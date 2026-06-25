// controllers/studentController.js
const { User, Test, Question, TestQuestion, Group, TestGroup, GroupMember, Result, Notification } = require('../models');
const { Op } = require('sequelize');

/**
 * GET /student/dashboard
 */
exports.getDashboard = async (req, res) => {
  try {
    const studentId = req.session.user.id;

    // ── Group memberships ─────────────────────────────────────────────────
    const groupMemberships = await GroupMember.findAll({ where: { userId: studentId, role: 'student' } });
    const groupIds = groupMemberships.map(gm => gm.groupId);

    // ── Available tests ───────────────────────────────────────────────────
    let availableTests = [];
    if (groupIds.length > 0) {
      const testGroups = await TestGroup.findAll({ where: { groupId: { [Op.in]: groupIds } } });
      const testIds = [...new Set(testGroups.map(tg => tg.testId))];
      if (testIds.length > 0) {
        availableTests = await Test.findAll({
          where: { id: { [Op.in]: testIds }, status: { [Op.in]: ['published', 'active'] } },
          order: [['startTime', 'ASC'], ['createdAt', 'DESC']],
        });
      }
    }

    // ── All completed results (no limit — needed for analytics) ───────────
    const allResults = await Result.findAll({
      where: { studentId, status: { [Op.in]: ['submitted', 'auto_submitted'] } },
      include: [{ model: Test, as: 'test', attributes: ['id', 'title', 'totalMarks', 'subject', 'course', 'duration'] }],
      order: [['submittedAt', 'DESC']],
    });

    // ── In-progress tests ─────────────────────────────────────────────────
    const inProgressResults = await Result.findAll({ where: { studentId, status: 'in_progress' }, attributes: ['testId'] });
    const inProgressTestIds = inProgressResults.map(r => r.testId);
    const completedTestIds  = allResults.map(r => r.testId);
    const nonPendingIds     = new Set([...completedTestIds, ...inProgressTestIds]);
    const pendingTests      = availableTests.filter(t => !nonPendingIds.has(t.id));

    // ── Notifications ─────────────────────────────────────────────────────
    const notifications = await Notification.findAll({
      where: { userId: studentId, isRead: false },
      order: [['createdAt', 'DESC']],
      limit: 8,
    });

    // ── Performance chart data (last 10 results chronological) ───────────
    const chartResults = [...allResults].reverse().slice(-10);
    const chartData = chartResults.map(r => ({
      label: r.test?.title ? r.test.title.substring(0, 18) + (r.test.title.length > 18 ? '…' : '') : 'Test',
      pct:   r.totalMarks > 0 ? parseFloat(((r.score / r.totalMarks) * 100).toFixed(1)) : 0,
      score: r.score,
      total: r.totalMarks,
      date:  r.submittedAt ? new Date(r.submittedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '',
    }));

    // ── Subject-wise performance breakdown ────────────────────────────────
    const subjectMap = {};
    allResults.forEach(r => {
      const subj = r.test?.subject || 'General';
      if (!subjectMap[subj]) subjectMap[subj] = { correct: 0, total: 0, marks: 0, maxMarks: 0, count: 0 };
      subjectMap[subj].marks    += r.score;
      subjectMap[subj].maxMarks += r.totalMarks;
      subjectMap[subj].correct  += r.correctAnswers || 0;
      subjectMap[subj].total    += (r.correctAnswers || 0) + (r.wrongAnswers || 0) + (r.skippedAnswers || 0);
      subjectMap[subj].count++;
    });
    const subjectStats = Object.entries(subjectMap).map(([name, d]) => ({
      name,
      pct: d.maxMarks > 0 ? parseFloat(((d.marks / d.maxMarks) * 100).toFixed(1)) : 0,
      count: d.count,
      marks: d.marks,
      maxMarks: d.maxMarks,
    })).sort((a, b) => b.pct - a.pct);

    // ── Best rank & percentile ────────────────────────────────────────────
    const bestResult = allResults.reduce((best, r) => {
      const pct = r.totalMarks > 0 ? (r.score / r.totalMarks) * 100 : 0;
      const bpct = best ? (best.totalMarks > 0 ? (best.score / best.totalMarks) * 100 : 0) : -1;
      return pct > bpct ? r : best;
    }, null);

    // ── Average score ─────────────────────────────────────────────────────
    const avgScore = allResults.length
      ? parseFloat((allResults.reduce((s, r) => s + (r.totalMarks > 0 ? (r.score / r.totalMarks) * 100 : 0), 0) / allResults.length).toFixed(1))
      : 0;

    // ── Score trend (up/down vs previous) ────────────────────────────────
    let scoreTrend = 'neutral';
    if (allResults.length >= 2) {
      const last  = allResults[0].totalMarks > 0 ? (allResults[0].score / allResults[0].totalMarks) * 100 : 0;
      const prev  = allResults[1].totalMarks > 0 ? (allResults[1].score / allResults[1].totalMarks) * 100 : 0;
      scoreTrend  = last > prev ? 'up' : last < prev ? 'down' : 'neutral';
    }

    // ── Accuracy ─────────────────────────────────────────────────────────
    const totalCorrect  = allResults.reduce((s, r) => s + (r.correctAnswers || 0), 0);
    const totalAttempted = allResults.reduce((s, r) => s + (r.correctAnswers || 0) + (r.wrongAnswers || 0), 0);
    const accuracy = totalAttempted > 0 ? parseFloat(((totalCorrect / totalAttempted) * 100).toFixed(1)) : 0;

    // ── Recent 5 for the table ─────────────────────────────────────────────
    const completedResults = allResults.slice(0, 5);

    // ── Upcoming test (nearest startTime in future) ───────────────────────
    const now = new Date();
    const upcomingTest = pendingTests.find(t => t.startTime && new Date(t.startTime) > now) || null;

    res.render('student/dashboard', {
      title: 'My Dashboard',
      pendingTests,
      completedResults,
      allResultsCount: allResults.length,
      notifications,
      chartData: JSON.stringify(chartData),
      subjectStats,
      upcomingTest,
      bestResult,
      stats: {
        pending:   pendingTests.length,
        completed: allResults.length,
        avgScore,
        scoreTrend,
        accuracy,
        rank:      bestResult?.rank || null,
        percentile: bestResult?.percentile || null,
        totalCorrect,
        totalAttempted,
      },
    });
  } catch (error) {
    console.error('Student dashboard error:', error);
    req.flash('error', 'Failed to load dashboard.');
    res.redirect('/auth/login');
  }
};
exports.getTests = async (req, res) => {
  try {
    const studentId = req.session.user.id;

    const groupMemberships = await GroupMember.findAll({ where: { userId: studentId } });
    const groupIds = groupMemberships.map(gm => gm.groupId);
    let tests = [];
    if (groupIds.length > 0) {
      const testGroups = await TestGroup.findAll({ where: { groupId: { [Op.in]: groupIds } } });
      const testIds = [...new Set(testGroups.map(tg => tg.testId))];
      if (testIds.length > 0) {
        tests = await Test.findAll({
          where: { id: { [Op.in]: testIds }, status: { [Op.in]: ['published', 'active', 'closed'] } },
          order: [['createdAt', 'DESC']],
        });
      }
    }

    const results = await Result.findAll({
      where: { studentId },
      attributes: ['testId', 'score', 'totalMarks', 'status', 'rank'],
    });

    const resultMap = {};
    results.forEach(r => { resultMap[r.testId] = r; });

    res.render('student/tests', { title: 'My Tests', tests, resultMap });
  } catch (error) {
    req.flash('error', 'Failed to load tests.');
    res.redirect('/student/dashboard');
  }
};

/**
 * GET /student/notifications
 */
exports.getNotifications = async (req, res) => {
  try {
    const notifications = await Notification.findAll({
      where: { userId: req.session.user.id },
      order: [['createdAt', 'DESC']],
    });
    // Mark all as read
    await Notification.update({ isRead: true }, { where: { userId: req.session.user.id } });
    res.render('student/notifications', { title: 'Notifications', notifications });
  } catch (error) {
    req.flash('error', 'Failed to load notifications.');
    res.redirect('/student/dashboard');
  }
};

/**
 * GET /student/results
 */
exports.getResults = async (req, res) => {
  try {
    const results = await Result.findAll({
      where: { studentId: req.session.user.id, status: { [Op.in]: ['submitted', 'auto_submitted'] } },
      include: [{ model: Test, as: 'test', attributes: ['title', 'totalMarks', 'duration'] }],
      order: [['submittedAt', 'DESC']],
    });
    res.render('student/results', { title: 'My Results', results });
  } catch (error) {
    req.flash('error', 'Failed to load results.');
    res.redirect('/student/dashboard');
  }
};

// ── DOCUMENT UPLOAD ───────────────────────────────────────────────────────────
const { StudentDocument } = require('../models');
const fs   = require('fs');
const path = require('path');
const DOC_DIR = path.join(__dirname, '../public/uploads/documents');
if (!fs.existsSync(DOC_DIR)) fs.mkdirSync(DOC_DIR, { recursive: true });

exports.getDocuments = async (req, res) => {
  try {
    const docs = await StudentDocument.findAll({ where: { studentId: req.session.user.id }, order: [['createdAt','DESC']] });
    res.render('student/documents', { title: 'My Documents', docs });
  } catch (e) { req.flash('error','Failed.'); res.redirect('/student/dashboard'); }
};

exports.uploadDocument = async (req, res) => {
  try {
    if (!req.files?.document) { req.flash('error','No file selected.'); return res.redirect('/student/documents'); }
    const file = req.files.document;
    const fname = `doc_${req.session.user.id}_${Date.now()}_${file.name.replace(/\s+/g,'_')}`;
    const filePath = '/uploads/documents/' + fname;
    fs.writeFileSync(path.join(DOC_DIR, fname), file.data);
    await StudentDocument.create({
      studentId: req.session.user.id, fileName: fname,
      originalName: file.name, fileType: file.mimetype,
      fileSize: file.size, filePath,
      description: req.body.description || '',
    });
    req.flash('success', 'Document uploaded.');
    res.redirect('/student/documents');
  } catch (e) { req.flash('error','Upload failed: ' + e.message); res.redirect('/student/documents'); }
};
