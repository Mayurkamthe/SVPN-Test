// controllers/examController.js — MongoDB / Mongoose
const { Test, Question, Result, GroupMember, User } = require('../models');

const shuffle = arr => { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };

exports.getInstructions = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const { testId } = req.params;
    const [test, submitted, inProgress] = await Promise.all([
      Test.findOne({ _id: testId, status: { $in: ['published','active'] } }).populate('questions'),
      Result.findOne({ studentId, testId, status: { $in: ['submitted','auto_submitted'] } }),
      Result.findOne({ studentId, testId, status: 'in_progress' }),
    ]);
    if (!test) { req.flash('error','Test not available.'); return res.redirect('/student/tests'); }
    if (submitted) { req.flash('info','Already submitted.'); return res.redirect(`/results/${submitted._id}`); }
    res.render('exam/instructions', { title: `${test.title} — Instructions`, test, questionCount: test.questions.length, inProgress: !!inProgress });
  } catch (e) { console.error(e); req.flash('error','Failed.'); res.redirect('/student/tests'); }
};

exports.startExam = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const { testId } = req.params;
    const [test, submitted] = await Promise.all([
      Test.findOne({ _id: testId, status: { $in: ['published','active'] } }).populate('questions', '_id'),
      Result.findOne({ studentId, testId, status: { $in: ['submitted','auto_submitted'] } }),
    ]);
    if (!test) { req.flash('error','Test not available.'); return res.redirect('/student/tests'); }
    if (submitted) { req.flash('info','Already submitted.'); return res.redirect(`/results/${submitted._id}`); }

    let result = await Result.findOne({ studentId, testId, status: 'in_progress' });
    if (!result) {
      let questionIds = test.questions.map(q => q._id.toString());
      if (test.shuffleQuestions) questionIds = shuffle(questionIds);
      result = await Result.create({
        studentId, testId, score: 0, totalMarks: test.totalMarks,
        answers: {}, questionTimings: {},
        cheatingFlags: { tabSwitches:0, fullscreenExits:0, focusLosses:0 },
        violationCount: 0, status: 'in_progress', startedAt: new Date(),
        questionOrder: questionIds, markedForReview: [],
      });
    }
    res.redirect(`/exam/${testId}/question/1`);
  } catch (e) { console.error(e); req.flash('error','Failed to start.'); res.redirect('/student/tests'); }
};

exports.getQuestion = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const { testId, qNum } = req.params;
    const questionNumber = parseInt(qNum);

    const [result, test] = await Promise.all([
      Result.findOne({ studentId, testId, status: 'in_progress' }),
      Test.findById(testId),
    ]);

    if (!result) {
      const submitted = await Result.findOne({ studentId, testId, status: { $in: ['submitted','auto_submitted'] } });
      if (submitted) return res.redirect(`/results/${submitted._id}`);
      return res.redirect(`/exam/${testId}/instructions`);
    }
    if (!test) { req.flash('error','Test not found.'); return res.redirect('/student/tests'); }

    const startedAt = new Date(result.startedAt);
    const remaining = Math.max(0, Math.floor((test.duration * 60 * 1000 - (Date.now() - startedAt.getTime())) / 1000));
    if (remaining <= 0) { req.body = { auto:'true' }; return exports.submitExam(req, res); }

    const questionIds = result.questionOrder;
    const totalQuestions = questionIds.length;
    if (questionNumber < 1 || questionNumber > totalQuestions) return res.redirect(`/exam/${testId}/question/1`);

    const currentQuestionId = questionIds[questionNumber - 1];
    const question = await Question.findById(currentQuestionId);
    if (!question) { req.flash('error','Question not found.'); return res.redirect('/student/tests'); }

    let options = [
      { key:'A', value: question.optionA, image: question.optionAImage },
      { key:'B', value: question.optionB, image: question.optionBImage },
      { key:'C', value: question.optionC, image: question.optionCImage },
      { key:'D', value: question.optionD, image: question.optionDImage },
    ];
    if (test.shuffleOptions) options = shuffle(options);

    const answers = result.answers || {};
    const markedForReview = result.markedForReview || [];

    const paletteStatus = questionIds.map((qId, idx) => {
      const answered = !!(answers[String(qId)]?.answer);
      const marked   = markedForReview.includes(String(qId));
      let status = 'not-visited';
      if (answered && marked) status = 'answered-marked';
      else if (answered)      status = 'answered';
      else if (marked)        status = 'marked';
      else if (idx + 1 < questionNumber) status = 'not-answered';
      return { num: idx + 1, qId, status };
    });

    res.render('exam/question', {
      title: `Q${questionNumber} — ${test.title}`,
      test, question, options, questionNumber, totalQuestions,
      remaining, paletteStatus,
      selectedAnswer: answers[String(currentQuestionId)]?.answer || null,
      isMarked: markedForReview.includes(String(currentQuestionId)),
      resultId: result._id,
      violations: result.violationCount || 0,
      result,
    });
  } catch (e) { console.error(e); req.flash('error','Failed.'); res.redirect('/student/tests'); }
};

exports.saveAnswer = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const { testId } = req.params;
    const { questionId, answer, markForReview, timeSpent } = req.body;

    const result = await Result.findOne({ studentId, testId, status: 'in_progress' });
    if (!result) return res.json({ success: false, message: 'Session expired' });

    const answers        = { ...(result.answers || {}) };
    const questionTimings = { ...(result.questionTimings || {}) };
    const markedForReview = [...(result.markedForReview || [])];

    answers[questionId] = { answer: answer?.trim() || null, savedAt: new Date() };
    if (timeSpent && !isNaN(timeSpent))
      questionTimings[questionId] = (questionTimings[questionId] || 0) + parseInt(timeSpent);

    const idx = markedForReview.indexOf(String(questionId));
    if (markForReview === 'true' || markForReview === true) { if (idx === -1) markedForReview.push(String(questionId)); }
    else { if (idx !== -1) markedForReview.splice(idx, 1); }

    await Result.findByIdAndUpdate(result._id, { answers, questionTimings, markedForReview });
    return res.json({ success: true, answeredCount: Object.values(answers).filter(a => a.answer).length });
  } catch (e) { console.error(e); return res.json({ success: false, message: e.message }); }
};

exports.reportViolation = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const { testId } = req.params;
    const { type } = req.body;
    const [result, test] = await Promise.all([
      Result.findOne({ studentId, testId, status: 'in_progress' }),
      Test.findById(testId).select('autoSubmitOnViolation maxTabSwitches maxFocusLosses'),
    ]);
    if (!result) return res.json({ success: false });

    const flags = result.cheatingFlags || { tabSwitches:0, fullscreenExits:0, focusLosses:0 };
    if (type === 'tabSwitch')           flags.tabSwitches    = (flags.tabSwitches||0) + 1;
    else if (type === 'fullscreenExit') flags.fullscreenExits = (flags.fullscreenExits||0) + 1;
    else if (type === 'focusLoss')      flags.focusLosses    = (flags.focusLosses||0) + 1;

    const violations = (flags.tabSwitches||0) + (flags.fullscreenExits||0) + (flags.focusLosses||0);
    await Result.findByIdAndUpdate(result._id, { cheatingFlags: flags, violationCount: violations });

    // ── Auto-submit check ─────────────────────────────────────────────────
    const maxSwitches = test?.maxTabSwitches ?? 3;
    const maxFocusLosses = test?.maxFocusLosses ?? 5;
    const shouldAutoSubmit = test?.autoSubmitOnViolation && (
      (type === 'tabSwitch'    && flags.tabSwitches    >= maxSwitches) ||
      (type === 'focusLoss'    && flags.focusLosses    >= maxFocusLosses) ||
      (type === 'fullscreenExit' && flags.fullscreenExits >= 3)
    );

    const remaining = Math.max(0, maxSwitches - (flags.tabSwitches||0));
    let warningLevel = remaining <= 1 ? 'danger' : 'warning';
    let warningMsg = shouldAutoSubmit
      ? 'Exam auto-submitted due to too many violations.'
      : `⚠ Tab switch detected! ${remaining} more allowed.`;

    return res.json({
      success: true, violations,
      tabSwitches: flags.tabSwitches||0,
      focusLosses: flags.focusLosses||0,
      autoSubmit: shouldAutoSubmit,
      warningLevel, warningMsg,
    });
  } catch (e) { console.error(e); return res.json({ success: false }); }
};

exports.submitExam = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const { testId } = req.params;
    const isAutoSubmit = req.body?.auto === 'true';

    const result = await Result.findOne({ studentId, testId, status: 'in_progress' });
    if (!result) {
      const done = await Result.findOne({ studentId, testId, status: { $in: ['submitted','auto_submitted'] } });
      if (done) return res.redirect(`/results/${done._id}`);
      return res.redirect('/student/tests');
    }

    const test = await Test.findById(testId).populate('questions');
    const answers = result.answers || {};
    let score = 0, correct = 0, wrong = 0, skipped = 0;
    const subjectScores = {}, topicScores = {};

    for (const question of test.questions) {
      const subj  = question.subject || 'General';
      const topic = question.topic   || 'General';
      if (!subjectScores[subj])  subjectScores[subj]  = { correct:0, wrong:0, skipped:0, marks:0, total:0 };
      if (!topicScores[topic])   topicScores[topic]   = { correct:0, wrong:0, skipped:0 };
      subjectScores[subj].total += question.marks;

      const given = answers[String(question._id)]?.answer;
      if (!given) {
        skipped++; subjectScores[subj].skipped++; topicScores[topic].skipped++;
      } else if (given === question.correctAnswer) {
        score += question.marks; correct++;
        subjectScores[subj].correct++; subjectScores[subj].marks += question.marks;
        topicScores[topic].correct++;
      } else {
        score -= (parseFloat(test.negativeMarking) || 0); wrong++;
        subjectScores[subj].wrong++; topicScores[topic].wrong++;
      }
    }

    score = Math.max(0, parseFloat(score.toFixed(2)));
    const timeTaken = Math.floor((Date.now() - new Date(result.startedAt).getTime()) / 1000);

    await Result.findByIdAndUpdate(result._id, {
      score, totalMarks: test.totalMarks,
      correctAnswers: correct, wrongAnswers: wrong, skippedAnswers: skipped,
      timeTaken, subjectScores, topicScores,
      status: isAutoSubmit ? 'auto_submitted' : 'submitted',
      submittedAt: new Date(),
    });

    await updateRanks(testId);
    return res.redirect(`/results/${result._id}`);
  } catch (e) { console.error(e); req.flash('error','Submit failed.'); res.redirect('/student/tests'); }
};

exports.autoSubmit = async (req, res) => { req.body = { auto:'true' }; return exports.submitExam(req, res); };

// Called via navigator.sendBeacon when student navigates away mid-exam
exports.leaveExam = async (req, res) => {
  try {
    const studentId = req.session?.user?.id;
    const { testId } = req.params;
    if (!studentId) return res.sendStatus(204);

    const body = req.body || {};
    const { questionId, answer, markForReview, timeSpent } = body;

    const result = await Result.findOne({ studentId, testId, status: 'in_progress' });
    if (!result) return res.sendStatus(204);

    // Save the current answer first
    if (questionId) {
      const answers         = { ...(result.answers || {}) };
      const questionTimings = { ...(result.questionTimings || {}) };
      const markedForReview = [...(result.markedForReview || [])];

      answers[questionId] = { answer: answer?.trim() || null, savedAt: new Date() };
      if (timeSpent && !isNaN(timeSpent))
        questionTimings[questionId] = (questionTimings[questionId] || 0) + parseInt(timeSpent);

      const idx = markedForReview.indexOf(String(questionId));
      if (markForReview === 'true') { if (idx === -1) markedForReview.push(String(questionId)); }
      else { if (idx !== -1) markedForReview.splice(idx, 1); }

      await Result.findByIdAndUpdate(result._id, { answers, questionTimings, markedForReview });
    }

    // Auto-submit
    req.body = { auto: 'true' };
    return exports.submitExam(req, res);
  } catch (e) {
    console.error('leaveExam error:', e);
    return res.sendStatus(204);
  }
};

async function updateRanks(testId) {
  const results = await Result.find({ testId, status: { $in: ['submitted','auto_submitted'] } })
    .sort({ score: -1, timeTaken: 1 });
  const n = results.length;
  await Promise.all(results.map((r, i) =>
    Result.findByIdAndUpdate(r._id, { rank: i+1, percentile: parseFloat((((n-i)/n)*100).toFixed(2)) })
  ));
}

exports.getResult = async (req, res) => {
  try {
    const result = await Result.findById(req.params.resultId)
      .populate('studentId', 'name rollNo email')
      .populate({ path: 'testId', populate: { path: 'questions' } });
    if (!result) { req.flash('error','Not found.'); return res.redirect('/student/dashboard'); }

    const viewer = req.session.user;
    if (viewer.role === 'student' && result.studentId._id.toString() !== viewer.id)
      { req.flash('error','Access denied.'); return res.redirect('/student/dashboard'); }

    const [topperResult, totalAttempted, trend] = await Promise.all([
      Result.findOne({ testId: result.testId._id, rank: 1 }, 'score subjectScores'),
      Result.countDocuments({ testId: result.testId._id, status: { $in: ['submitted','auto_submitted'] } }),
      Result.find({ studentId: result.studentId._id, status: { $in: ['submitted','auto_submitted'] } })
        .populate('testId','title').sort({ submittedAt: 1 }).limit(10),
    ]);

    const percentage = result.totalMarks > 0
      ? parseFloat(((result.score / result.totalMarks) * 100).toFixed(1)) : 0;

    res.render('exam/result', { title: 'Exam Result', result, percentage, topperResult, trend, totalAttempted });
  } catch (e) { console.error(e); req.flash('error','Failed.'); res.redirect('/student/dashboard'); }
};

exports.downloadResultPDF = async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const result = await Result.findById(req.params.resultId)
      .populate('studentId', 'name rollNo email')
      .populate({ path: 'testId', populate: { path: 'questions' } });
    if (!result) return res.status(404).send('Not found');

    const test = result.testId;
    const questionMap = {};
    (test.questions || []).forEach(q => { questionMap[q._id.toString()] = q; });
    const orderedIds  = result.questionOrder?.length ? result.questionOrder : Object.keys(questionMap);
    const questions   = orderedIds.map(id => questionMap[id.toString()]).filter(Boolean);
    const answers     = result.answers || {};
    const safe        = str => (str || '').replace(/<[^>]*>/g, '').trim();
    const COLLEGE     = process.env.COLLEGE_NAME || 'College';
    const pct         = result.totalMarks > 0 ? ((result.score / result.totalMarks) * 100).toFixed(1) : '0.0';

    const doc = new PDFDocument({ margin: 45, size: 'A4', bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=result_${result._id}.pdf`);
    doc.pipe(res);

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#1e293b').text(COLLEGE, { align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor('#64748b').text('CET Examination — Detailed Result Card', { align: 'center' });
    doc.moveDown(0.5);

    const info = [
      ['Name', result.studentId.name], ['Roll No', result.studentId.rollNo || '—'],
      ['Test', test.title],
      ['Date', result.submittedAt ? new Date(result.submittedAt).toLocaleDateString('en-IN') : '—'],
      ['Score', `${result.score} / ${result.totalMarks}  (${pct}%)`],
      ['Rank', `#${result.rank || '—'}  ·  Correct: ${result.correctAnswers}  Wrong: ${result.wrongAnswers}  Skipped: ${result.skippedAnswers}`],
    ];
    info.forEach(([label, val]) => {
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text(`${label}: `, { continued: true });
      doc.font('Helvetica').fillColor('#1e293b').text(val);
    });

    doc.addPage();
    doc.fontSize(11).font('Helvetica-Bold').text('QUESTION-BY-QUESTION ANSWERS', { align: 'center' });
    doc.moveDown(0.5);

    questions.forEach((q, idx) => {
      if (doc.y > 700) doc.addPage();
      const ans = answers[String(q._id)] || {};
      const given = ans.answer || null;
      const isCorrect = given && given === q.correctAnswer;
      const statusColor = isCorrect ? '#16a34a' : given ? '#dc2626' : '#b45309';
      const optMap = { A: q.optionA, B: q.optionB, C: q.optionC, D: q.optionD };

      doc.fontSize(9).font('Helvetica-Bold').fillColor('#1e1f5e').text(`Q${idx+1}. `, { continued: true });
      doc.font('Helvetica').fillColor('#1e293b').text(safe(q.question));
      ['A','B','C','D'].forEach(key => {
        const isC = q.correctAnswer === key, isG = given === key;
        const col = isC ? '#16a34a' : (isG && !isC) ? '#dc2626' : '#374151';
        doc.fontSize(8).font(isC||isG?'Helvetica-Bold':'Helvetica').fillColor(col)
           .text(`   ${isC?'✓':isG?'✗':' '} ${key}) ${safe(optMap[key]||'')}`, { width: 480 });
      });
      if (q.explanation) {
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#6d28d9').text('Explanation: ', { continued: true });
        doc.font('Helvetica').fillColor('#4b5563').text(safe(q.explanation));
      }
      doc.moveDown(0.5);
    });

    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).font('Helvetica').fillColor('#94a3b8')
         .text(`${COLLEGE} · Page ${i+1} of ${totalPages}`, 45, 820, { width: 505, align: 'center' });
    }
    doc.end();
  } catch (e) { console.error('PDF error:', e); res.status(500).send('PDF generation failed: ' + e.message); }
};

exports.getLeaderboard = async (req, res) => {
  try {
    const { testId } = req.params;
    const [test, results] = await Promise.all([
      Test.findById(testId),
      Result.find({ testId, status: { $in: ['submitted','auto_submitted'] } })
        .populate('studentId', 'name rollNo')
        .sort({ score: -1, timeTaken: 1 }).limit(50),
    ]);
    if (!test) { req.flash('error','Not found.'); return res.redirect('/student/dashboard'); }
    res.render('exam/leaderboard', { title: `Leaderboard — ${test.title}`, test, results });
  } catch (e) { req.flash('error','Failed.'); res.redirect('/student/dashboard'); }
};
