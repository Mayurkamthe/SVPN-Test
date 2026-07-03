// controllers/adminController.js — MongoDB / Mongoose
const { User, Group, Question, Test, GroupMember, Result, Notification, Topic, StudentDocument } = require('../models');
const xlsx = require('xlsx');
const fs   = require('fs');
const path = require('path');

const COURSES = ['JEE','CET','NEET'];
const SUBJECTS_BY_COURSE = { JEE:['Physics','Chemistry','Mathematics'], CET:['Physics','Chemistry','Mathematics','Biology'], NEET:['Physics','Chemistry','Biology'] };
const ALL_SUBJECTS = ['Physics','Chemistry','Mathematics','Biology','English','General Knowledge'];
const generatePassword = rollNo => `CET@${String(rollNo).slice(-4).padStart(4,'0')}`;

const UPLOAD_DIR = path.join(__dirname,'../public/uploads');
const PDF_DIR = path.join(UPLOAD_DIR,'pdfs');
const DOC_DIR = path.join(UPLOAD_DIR,'documents');
[UPLOAD_DIR,PDF_DIR,DOC_DIR].forEach(d => { if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); });

const loadTopics = (course, subject) => {
  const q = { isActive: true };
  if (course)  q.course  = course;
  if (subject) q.subject = subject;
  return Topic.find(q).sort({ name: 1 });
};

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
exports.getDashboard = async (req, res) => {
  try {
    const [studentCount, testCount, groupCount, questionCount, recentResults, recentUsers] = await Promise.all([
      User.countDocuments({ role:'student', isActive:true }),
      Test.countDocuments(),
      Group.countDocuments({ isActive:true }),
      Question.countDocuments({ isActive:true }),
      Result.find().sort({ createdAt:-1 }).limit(8).populate('studentId','name rollNo').populate('testId','title'),
      User.find({ role:'student' }).sort({ createdAt:-1 }).limit(5),
    ]);
    res.render('admin/dashboard', { title:'Admin Dashboard', stats:{ studentCount, testCount, groupCount, questionCount }, recentResults, recentUsers, COURSES });
  } catch (e) { console.error(e); req.flash('error','Failed.'); res.redirect('/auth/login'); }
};

// ── STUDENT MANAGEMENT ────────────────────────────────────────────────────────
exports.getStudents = async (req, res) => {
  try {
    const [students, groups] = await Promise.all([
      User.find({ role:'student' }).sort({ rollNo:1 }),
      Group.find({ isActive:true }),
    ]);
    res.render('admin/students', { title:'Manage Students', students, groups });
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/dashboard'); }
};

exports.createStudent = async (req, res) => {
  try {
    const { name, rollNo, parentContact, groupId } = req.body;
    if (!rollNo || !name) { req.flash('error','Name and Roll No required.'); return res.redirect('/admin/students'); }
    const exists = await User.findOne({ rollNo });
    if (exists) { req.flash('error',`Roll No ${rollNo} already exists.`); return res.redirect(req.get('Referer')||'/admin/students'); }
    const pwd = generatePassword(rollNo);
    const student = await User.create({ name, rollNo, parentContact:parentContact||null, role:'student', password:pwd, isFirstLogin:true });
    if (groupId) await GroupMember.create({ groupId, userId:student._id, role:'student' });
    await Notification.create({ userId:student._id, title:'Account Created', message:`Welcome ${name}! Roll: ${rollNo}, Password: ${pwd}`, type:'info' });
    req.flash('success',`Student created. Password: ${pwd}`);
    res.redirect(req.get('Referer')||'/admin/students');
  } catch (e) {
    req.flash('error', e.code===11000 ? 'Roll number already exists.' : 'Failed: '+e.message);
    res.redirect(req.get('Referer')||'/admin/students');
  }
};

exports.bulkImportStudents = async (req, res) => {
  try {
    const { groupId } = req.body;
    if (!req.files?.csvFile) { req.flash('error','No file uploaded.'); return res.redirect(req.get('Referer')||'/admin/groups'); }
    const wb   = xlsx.read(req.files.csvFile.data, { type:'buffer' });
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    let created=0, skipped=0, duplicates=[];
    for (const row of rows) {
      const rollNo = String(row['Roll No']||row.rollNo||'').trim();
      const name   = String(row['Name']||row.name||'').trim();
      if (!rollNo||!name) { skipped++; continue; }
      if (await User.findOne({ rollNo })) { duplicates.push(rollNo); skipped++; continue; }
      try {
        const pwd = generatePassword(rollNo);
        const s = await User.create({ name, rollNo, parentContact:String(row['Parent Contact No']||row.parentContact||'').trim()||null, role:'student', password:pwd, isFirstLogin:true });
        if (groupId) await GroupMember.create({ groupId, userId:s._id, role:'student' }).catch(()=>{});
        created++;
      } catch { skipped++; }
    }
    let msg = `Imported ${created} student(s).`;
    if (skipped) msg += ` ${skipped} skipped.`;
    if (duplicates.length) msg += ` Duplicates: ${duplicates.join(', ')}.`;
    req.flash('success', msg);
    res.redirect(req.get('Referer')||'/admin/groups');
  } catch (e) { req.flash('error','Import failed: '+e.message); res.redirect(req.get('Referer')||'/admin/groups'); }
};

// ── GROUPS ────────────────────────────────────────────────────────────────────
exports.getGroups = async (req, res) => {
  try {
    const [groups, students, memberships] = await Promise.all([
      Group.find().sort({ createdAt:-1 }),
      User.find({ role:'student', isActive:true }).sort({ rollNo:1 }),
      GroupMember.find().populate('userId','name rollNo').populate('groupId','name'),
    ]);
    // Attach members array to each group
    const memberMap = {};
    memberships.forEach(m => {
      const gid = m.groupId?._id?.toString();
      if (!gid) return;
      if (!memberMap[gid]) memberMap[gid] = [];
      memberMap[gid].push({ ...m.userId?.toObject(), GroupMember:{ role: m.role } });
    });
    const groupsWithMembers = groups.map(g => ({ ...g.toObject(), members: memberMap[g._id.toString()]||[] }));
    res.render('admin/groups', { title:'Batches', groups: groupsWithMembers, students, COURSES });
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/dashboard'); }
};

exports.createGroup = async (req, res) => {
  try {
    const { name, description, academicYear, course } = req.body;
    const group = await Group.create({ name, description, academicYear:academicYear||process.env.ACADEMIC_YEAR, course:course||null });
    let imported=0, skipped=0;
    if (req.files?.csvFile) {
      const wb   = xlsx.read(req.files.csvFile.data, { type:'buffer' });
      const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      for (const row of rows) {
        try {
          const rollNo = String(row['Roll No']||row.rollNo||'').trim();
          const sName  = String(row['Name']||row.name||'').trim();
          if (!rollNo||!sName) { skipped++; continue; }
          const pw = generatePassword(rollNo);
          let student = await User.findOne({ rollNo });
          const isNew = !student;
          if (!student) student = await User.create({ name:sName, rollNo, email:String(row['Email']||row.email||'').trim()||null, phone:String(row['Phone']||row.phone||'').trim()||null, parentContact:String(row['Parent Contact No']||row.parentContact||'').trim()||null, role:'student', password:pw, isFirstLogin:true });
          await GroupMember.findOneAndUpdate({ groupId:group._id, userId:student._id }, { role:'student' }, { upsert:true });
          if (isNew) imported++; else skipped++;
        } catch { skipped++; }
      }
      req.flash('success',`Batch "${name}" created with ${imported} students${skipped?', '+skipped+' skipped':''}.`);
    } else {
      req.flash('success',`Batch "${name}" created.`);
    }
    res.redirect('/admin/groups');
  } catch (e) { req.flash('error','Failed. Name may already exist.'); res.redirect('/admin/groups'); }
};

exports.assignMember = async (req, res) => {
  try {
    const { groupId, userId } = req.body;
    await GroupMember.findOneAndUpdate({ groupId, userId }, { role:'student' }, { upsert:true });
    req.flash('success','Member assigned.');
    res.redirect('/admin/groups');
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/groups'); }
};

exports.downloadStudentTemplate = (req, res) => {
  const rows = [
    { 'Name':'Arjun Mehta',   'Roll No':'2024CE001', 'Email':'arjun@example.com',  'Phone':'9876543210', 'Parent Contact No':'9876543200' },
    { 'Name':'Priya Patel',   'Roll No':'2024CE002', 'Email':'priya@example.com',  'Phone':'9876543211', 'Parent Contact No':'9876543201' },
    { 'Name':'Sample Student','Roll No':'2024CE003', 'Email':'sample@example.com', 'Phone':'',           'Parent Contact No':'' },
  ];
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(rows);
  ws['!cols'] = [{wch:25},{wch:15},{wch:30},{wch:15},{wch:20}];
  xlsx.utils.book_append_sheet(wb, ws, 'Students');
  const buf = xlsx.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition','attachment; filename=student_import_template.xlsx');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
};

exports.exportGroupCredentials = async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) { req.flash('error','Batch not found.'); return res.redirect('/admin/groups'); }
    const memberships = await GroupMember.find({ groupId:group._id, role:'student' }).populate('userId','name rollNo parentContact');
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin:40, size:'A4' });
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename=credentials_${group.name.replace(/\s+/g,'_')}.pdf`);
    doc.pipe(res);
    doc.fontSize(16).font('Helvetica-Bold').text(process.env.COLLEGE_NAME||'College',{align:'center'});
    doc.fontSize(11).font('Helvetica').text(`Batch: ${group.name} | AY: ${group.academicYear||''}`,{align:'center'});
    doc.moveDown(0.5).moveTo(40,doc.y).lineTo(555,doc.y).stroke().moveDown(0.5);
    const colX=[40,150,300,420];
    doc.fontSize(9).font('Helvetica-Bold');
    ['Roll No','Name','Parent Contact','Password'].forEach((h,i)=>doc.text(h,colX[i],doc.y,{continued:i<3}));
    doc.moveDown(0.4).moveTo(40,doc.y).lineTo(555,doc.y).stroke().moveDown(0.3);
    doc.font('Helvetica').fontSize(9);
    for (const m of memberships) {
      const s = m.userId;
      if (!s) continue;
      const rowY = doc.y;
      const pwd  = generatePassword(s.rollNo||'');
      doc.text(s.rollNo||'',colX[0],rowY,{width:105});
      doc.text(s.name||'',colX[1],rowY,{width:145});
      doc.text(s.parentContact||'',colX[2],rowY,{width:115});
      doc.text(pwd,colX[3],rowY,{width:120});
      doc.moveDown(0.5);
      if (doc.y>750) doc.addPage();
    }
    doc.end();
  } catch (e) { console.error(e); res.status(500).send('PDF export failed.'); }
};

// ── TOPICS ────────────────────────────────────────────────────────────────────
exports.getTopics = async (req, res) => {
  try {
    const { course, subject } = req.query;
    const [topics] = await Promise.all([ loadTopics(course, subject) ]);
    const SUBJECTS = course ? (SUBJECTS_BY_COURSE[course]||ALL_SUBJECTS) : ALL_SUBJECTS;
    res.render('admin/topics', { title:'Content Management', topics, COURSES, SUBJECTS, SUBJECTS_BY_COURSE, filterCourse:course||'', filterSubject:subject||'' });
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/dashboard'); }
};

exports.createTopic = async (req, res) => {
  try {
    const { name, course, subject, subtopics } = req.body;
    await Topic.create({ name, course, subject, subtopics: subtopics ? subtopics.split('\n').map(s=>s.trim()).filter(Boolean) : [] });
    req.flash('success','Topic added.');
    res.redirect(`/admin/topics?course=${course}&subject=${encodeURIComponent(subject)}`);
  } catch (e) { req.flash('error','Failed: '+e.message); res.redirect('/admin/topics'); }
};

exports.updateTopic = async (req, res) => {
  try {
    const { name, subtopics } = req.body;
    await Topic.findByIdAndUpdate(req.params.id, { name, subtopics: subtopics ? subtopics.split('\n').map(s=>s.trim()).filter(Boolean) : [] });
    req.flash('success','Topic updated.');
    res.redirect('/admin/topics');
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/topics'); }
};

exports.deleteTopic = async (req, res) => {
  try {
    await Topic.findByIdAndUpdate(req.params.id, { isActive:false });
    req.flash('success','Topic deleted.');
    res.redirect('/admin/topics');
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/topics'); }
};

exports.getSubjectsForCourse = (req, res) => res.json(SUBJECTS_BY_COURSE[req.params.course]||ALL_SUBJECTS);

exports.getTopicsForSubject = async (req, res) => {
  try { res.json(await loadTopics(req.query.course, req.query.subject)); }
  catch { res.json([]); }
};

exports.getSubtopicsForTopic = async (req, res) => {
  try {
    const { course, subject, topic } = req.query;
    const q = { isActive:true };
    if (course)  q.course  = course;
    if (subject) q.subject = subject;
    if (topic)   q.name    = topic;
    const t = await Topic.findOne(q);
    res.json(t?.subtopics||[]);
  } catch { res.json([]); }
};

// ── QUESTIONS ─────────────────────────────────────────────────────────────────
exports.getQuestions = async (req, res) => {
  try {
    const { subject, topic, subtopic, difficulty, course, sort='subject', page=1 } = req.query;
    const limit=25, skip=(page-1)*limit;
    const q = { isActive:true };
    if (subject)   q.subject   = subject;
    if (topic)     q.topic     = topic;
    if (subtopic)  q.subtopic  = subtopic;
    if (difficulty) q.difficulty = difficulty;
    const sortMap = {
      difficulty: { difficulty:1, subject:1 },
      newest:     { createdAt:-1 },
      oldest:     { createdAt:1 },
      subject:    { subject:1, topic:1, subtopic:1, difficulty:1, createdAt:-1 },
    };
    const [questions, total] = await Promise.all([
      Question.find(q).sort(sortMap[sort]||sortMap.subject).skip(skip).limit(limit),
      Question.countDocuments(q),
    ]);
    const topicRows = subject ? await loadTopics(course, subject) : [];
    const subtopicList = topic ? (topicRows.find(t=>t.name===topic)?.subtopics||[]) : [];
    res.render('admin/questions', {
      title:'Question Bank', questions, total,
      currentPage:parseInt(page), totalPages:Math.ceil(total/limit),
      filters:{ subject, topic, subtopic, difficulty, course, sort },
      COURSES, SUBJECTS:ALL_SUBJECTS, topicRows, subtopicList,
    });
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/dashboard'); }
};

exports.createQuestion = async (req, res) => {
  try {
    const { question, optionA, optionB, optionC, optionD, correctAnswer, subject, topic, subtopic, difficulty, marks, explanation, questionImageUrl } = req.body;
    let questionImage = questionImageUrl || null;
    if (req.files?.questionImage) {
      const { processQuestionImage } = require('../utils/imageUpload');
      questionImage = await processQuestionImage(req.files.questionImage, `q_${Date.now()}`);
    }
    await Question.create({ question, optionA, optionB, optionC, optionD, correctAnswer, subject, topic:topic||null, subtopic:subtopic||null, difficulty, marks:parseFloat(marks)||1, explanation:explanation||null, questionImage, createdBy:req.session.user.id });
    req.flash('success','Question added.');
    res.redirect(`/admin/questions?subject=${encodeURIComponent(subject||'')}&topic=${encodeURIComponent(topic||'')}`);
  } catch (e) { req.flash('error','Failed: '+e.message); res.redirect('/admin/questions'); }
};

exports.bulkImportQuestions = async (req, res) => {
  try {
    if (!req.files?.csvFile) { req.flash('error','No file uploaded.'); return res.redirect('/admin/questions'); }
    const wb   = xlsx.read(req.files.csvFile.data, { type:'buffer' });
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    let created=0;
    for (const row of rows) {
      try {
        await Question.create({
          question:row.question||row.Question, optionA:row.optionA||row['Option A'],
          optionB:row.optionB||row['Option B'], optionC:row.optionC||row['Option C'], optionD:row.optionD||row['Option D'],
          correctAnswer:(row.correctAnswer||'A').toUpperCase(), subject:row.subject||'Physics',
          difficulty:row.difficulty||'Medium', marks:parseFloat(row.marks||1),
          topic:row.topic||null, subtopic:row.subtopic||null, explanation:row.explanation||null,
          questionImage: row.questionImageUrl || row.questionImage || row['Image URL'] || row['Question Image URL'] || null,
          createdBy:req.session.user.id,
        });
        created++;
      } catch {}
    }
    req.flash('success',`${created} questions imported.`);
    res.redirect('/admin/questions');
  } catch (e) { req.flash('error','Import failed.'); res.redirect('/admin/questions'); }
};

exports.deleteQuestion = async (req, res) => {
  try {
    await Question.findByIdAndUpdate(req.params.id, { isActive:false });
    req.flash('success','Question removed.');
    res.redirect('/admin/questions');
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/questions'); }
};

// ── TESTS ─────────────────────────────────────────────────────────────────────
exports.getTests = async (req, res) => {
  try {
    const { subject, course } = req.query;
    const q = {};
    if (subject) q.subject = subject;
    if (course)  q.course  = course;
    const tests = await Test.find(q).populate('groups','name').sort({ createdAt:-1 });
    res.render('admin/tests', { title:'Tests', tests, COURSES, SUBJECTS:ALL_SUBJECTS, filterSubject:subject||'', filterCourse:course||'' });
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/dashboard'); }
};

exports.getCreateTest = async (req, res) => {
  try {
    const { subject, course } = req.query;
    const q = { isActive:true };
    if (subject) q.subject = subject;
    const [groups, questions, topics] = await Promise.all([
      Group.find({ isActive:true }),
      Question.find(q).sort({ subject:1, difficulty:1 }),
      loadTopics(course, subject),
    ]);
    res.render('admin/create-test', { title:'Create Test', groups, questions, COURSES, SUBJECTS:ALL_SUBJECTS, topics, filterSubject:subject||'', filterCourse:course||'' });
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/tests'); }
};

exports.createTest = async (req, res) => {
  try {
    const questionIds_raw = req.body.questionIds;
    const selectedQIds = Array.isArray(questionIds_raw) ? questionIds_raw : (questionIds_raw ? [questionIds_raw] : []);
    if (!selectedQIds.length) { req.flash('error','Select at least one question.'); return res.redirect('/admin/tests/create'); }
    const { title, description, duration, negativeMarking, passingMarks, shuffleQuestions, shuffleOptions, startTime, endTime, instructions, groupIds, courses, subjects, topic, subtopic, marksPerQuestion } = req.body;
    const questionsData = await Question.find({ _id:{ $in:selectedQIds } });
    const totalMarks = questionsData.reduce((s,q)=>s+q.marks, 0);
    let questionPdfPath=null, solutionPdfPath=null;
    if (req.files?.questionPdf) { const fn=`q_${Date.now()}.pdf`; questionPdfPath='/uploads/pdfs/'+fn; fs.writeFileSync(path.join(PDF_DIR,fn),req.files.questionPdf.data); }
    if (req.files?.solutionPdf) { const fn=`s_${Date.now()}.pdf`; solutionPdfPath='/uploads/pdfs/'+fn; fs.writeFileSync(path.join(PDF_DIR,fn),req.files.solutionPdf.data); }
    const groups = Array.isArray(groupIds) ? groupIds : (groupIds ? [groupIds] : []);
    const courseArr  = Array.isArray(courses)  ? courses  : (courses  ? [courses]  : []);
    const subjectArr = Array.isArray(subjects) ? subjects : (subjects ? [subjects] : []);
    const test = await Test.create({
      title, description, duration:parseInt(duration)||180,
      negativeMarking:parseFloat(negativeMarking)||0.25, passingMarks:parseFloat(passingMarks)||null,
      shuffleQuestions:shuffleQuestions==='on', shuffleOptions:shuffleOptions==='on',
      startTime:startTime||null, endTime:endTime||null, instructions,
      totalMarks, createdBy:req.session.user.id, status:'draft',
      course: courseArr, subject: subjectArr, topic:topic||null, subtopic:subtopic||null,
      marksPerQuestion:parseFloat(marksPerQuestion)||1,
      questionPdfPath, solutionPdfPath,
      questions:selectedQIds, groups,
      autoSubmitOnViolation:req.body.autoSubmitOnViolation==='on',
      maxTabSwitches:parseInt(req.body.maxTabSwitches)||3,
      maxFocusLosses:parseInt(req.body.maxFocusLosses)||5,
      blockCopyPaste:req.body.blockCopyPaste==='on',
      requireFullscreen:req.body.requireFullscreen==='on',
    });
    req.flash('success','Test created!');
    res.redirect(`/admin/tests/${test._id}`);
  } catch (e) { req.flash('error','Failed: '+e.message); res.redirect('/admin/tests/create'); }
};

exports.getTestDetail = async (req, res) => {
  try {
    const [test, results] = await Promise.all([
      Test.findById(req.params.id).populate('questions').populate('groups','name'),
      Result.find({ testId:req.params.id, status:{ $in:['submitted','auto_submitted'] } })
        .populate('studentId','name rollNo').sort({ score:-1 }),
    ]);
    if (!test) { req.flash('error','Not found.'); return res.redirect('/admin/tests'); }
    res.render('admin/test-detail', { title:test.title, test, results });
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/tests'); }
};

exports.publishTest = async (req, res) => {
  try {
    const test = await Test.findById(req.params.id);
    if (!test) { req.flash('error','Not found.'); return res.redirect('/admin/tests'); }
    await Test.findByIdAndUpdate(test._id, { status:'published' });
    // Notify all students in assigned groups
    const memberships = await GroupMember.find({ groupId:{ $in:test.groups }, role:'student' });
    await Promise.all(memberships.map(m =>
      Notification.create({ userId:m.userId, title:'New Exam Published', message:`"${test.title}" is now available. Duration: ${test.duration} mins.`, type:'exam', link:'/student/tests' })
    ));
    req.flash('success','Test published and students notified!');
    res.redirect(`/admin/tests/${test._id}`);
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/tests'); }
};

// ── RESULTS ───────────────────────────────────────────────────────────────────
exports.getAllResults = async (req, res) => {
  try {
    const results = await Result.find().sort({ createdAt:-1 }).populate('studentId','name rollNo').populate('testId','title course subject');
    res.render('admin/results', { title:'All Results', results });
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/dashboard'); }
};

exports.exportResultsExcel = async (req, res) => {
  try {
    const results = await Result.find().sort({ createdAt:-1 }).populate('studentId','name rollNo').populate('testId','title');
    const data = results.map(r => ({
      'Roll No':r.studentId?.rollNo, Name:r.studentId?.name, Test:r.testId?.title,
      Score:r.score, 'Total Marks':r.totalMarks,
      Percentage:r.totalMarks>0?((r.score/r.totalMarks)*100).toFixed(1)+'%':'0%',
      Rank:r.rank||'', Status:r.status,
      Date:r.submittedAt?new Date(r.submittedAt).toLocaleDateString('en-IN'):'',
    }));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(data), 'Results');
    const buf = xlsx.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition','attachment; filename=results.xlsx');
    res.send(buf);
  } catch (e) { req.flash('error','Export failed.'); res.redirect('/admin/results'); }
};

// ── DOCUMENTS ─────────────────────────────────────────────────────────────────
exports.getDocuments = async (req, res) => {
  try {
    const docs = await StudentDocument.find().sort({ createdAt:-1 }).populate('studentId','name rollNo');
    res.render('admin/documents', { title:'Student Documents', docs });
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/dashboard'); }
};

exports.deleteDocument = async (req, res) => {
  try {
    const doc = await StudentDocument.findById(req.params.id);
    if (doc) {
      const fp = path.join(__dirname,'..','public',doc.filePath);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      await doc.deleteOne();
    }
    req.flash('success','Document deleted.');
    res.redirect('/admin/documents');
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/documents'); }
};

// ── GROUP DETAIL / EDIT / DELETE ──────────────────────────────────────────
exports.getGroupDetail = async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) { req.flash('error','Batch not found.'); return res.redirect('/admin/groups'); }
    const memberships = await GroupMember.find({ groupId: group._id, role: 'student' }).populate('userId');
    const members = memberships.map(m => m.userId).filter(Boolean);
    const allGroups = await Group.find({ isActive: true });
    res.render('admin/group-detail', { title: group.name, group, members, allGroups });
  } catch (e) { console.error(e); req.flash('error','Failed.'); res.redirect('/admin/groups'); }
};

exports.updateGroup = async (req, res) => {
  try {
    const { name, description, academicYear } = req.body;
    await Group.findByIdAndUpdate(req.params.id, { name, description: description || null, academicYear: academicYear || process.env.ACADEMIC_YEAR });
    req.flash('success', 'Batch updated.');
    res.redirect('/admin/groups');
  } catch (e) { req.flash('error', 'Failed: ' + e.message); res.redirect('/admin/groups'); }
};

exports.deleteGroup = async (req, res) => {
  try {
    await GroupMember.deleteMany({ groupId: req.params.id });
    await Group.findByIdAndUpdate(req.params.id, { isActive: false });
    req.flash('success', 'Batch deleted.');
    res.redirect('/admin/groups');
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/groups'); }
};

exports.removeStudentFromGroup = async (req, res) => {
  try {
    await GroupMember.findOneAndDelete({ groupId: req.params.id, userId: req.params.studentId });
    req.flash('success', 'Student removed from batch.');
    res.redirect(`/admin/groups/${req.params.id}`);
  } catch (e) { req.flash('error', 'Failed.'); res.redirect(`/admin/groups/${req.params.id}`); }
};

exports.moveStudentToGroup = async (req, res) => {
  try {
    const { targetGroupId } = req.body;
    await GroupMember.findOneAndDelete({ groupId: req.params.id, userId: req.params.studentId });
    await GroupMember.findOneAndUpdate({ groupId: targetGroupId, userId: req.params.studentId }, { role: 'student' }, { upsert: true });
    req.flash('success', 'Student moved to new batch.');
    res.redirect(`/admin/groups/${req.params.id}`);
  } catch (e) { req.flash('error', 'Failed.'); res.redirect(`/admin/groups/${req.params.id}`); }
};

// ── DELETE STUDENT ─────────────────────────────────────────────────────────
exports.deleteStudent = async (req, res) => {
  try {
    await GroupMember.deleteMany({ userId: req.params.id });
    await User.findByIdAndUpdate(req.params.id, { isActive: false });
    req.flash('success', 'Student deleted.');
    res.redirect('/admin/students');
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/students'); }
};

// ── VIEW STUDENT PROFILE ──────────────────────────────────────────────────
exports.viewStudentProfile = async (req, res) => {
  try {
    const student = await User.findById(req.params.id);
    if (!student || student.role !== 'student') { req.flash('error','Student not found.'); return res.redirect('/admin/students'); }
    const [memberships, documents, results] = await Promise.all([
      GroupMember.find({ userId: student._id }).populate('groupId', 'name academicYear'),
      StudentDocument.find({ studentId: student._id }).sort({ createdAt: -1 }),
      require('../models/Result').find({ studentId: student._id, status: { $in: ['submitted','auto_submitted'] } }).populate('testId', 'title totalMarks').sort({ createdAt: -1 }).limit(10),
    ]);
    res.render('admin/student-profile', { title: student.name, student, memberships, documents, results });
  } catch (e) { console.error(e); req.flash('error','Failed.'); res.redirect('/admin/students'); }
};

// ── EDIT TEST ─────────────────────────────────────────────────────────────
exports.getEditTest = async (req, res) => {
  try {
    const [test, groups, questions] = await Promise.all([
      Test.findById(req.params.id).populate('questions').populate('groups','name'),
      Group.find({ isActive:true }),
      Question.find({ isActive:true }).sort({ subject:1, difficulty:1 }),
    ]);
    if (!test) { req.flash('error','Not found.'); return res.redirect('/admin/tests'); }
    res.render('admin/edit-test', { title:'Edit Test', test, groups, questions, COURSES, SUBJECTS:ALL_SUBJECTS });
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/tests'); }
};

exports.updateTest = async (req, res) => {
  try {
    const questionIds_raw = req.body.questionIds;
    const selectedQIds = Array.isArray(questionIds_raw) ? questionIds_raw : (questionIds_raw ? [questionIds_raw] : []);
    const { title, description, duration, negativeMarking, passingMarks, shuffleQuestions, shuffleOptions, startTime, endTime, instructions, groupIds, courses, subjects } = req.body;
    const questionsData = selectedQIds.length ? await Question.find({ _id:{ $in:selectedQIds } }) : [];
    const totalMarks = questionsData.reduce((s,q)=>s+q.marks, 0);
    const groups = Array.isArray(groupIds) ? groupIds : (groupIds ? [groupIds] : []);
    const courseArr  = Array.isArray(courses)  ? courses  : (courses  ? [courses]  : []);
    const subjectArr = Array.isArray(subjects) ? subjects : (subjects ? [subjects] : []);
    await Test.findByIdAndUpdate(req.params.id, {
      title, description, duration:parseInt(duration)||180,
      negativeMarking:parseFloat(negativeMarking)||0.25,
      passingMarks:parseFloat(passingMarks)||null,
      shuffleQuestions:shuffleQuestions==='on', shuffleOptions:shuffleOptions==='on',
      startTime:startTime||null, endTime:endTime||null, instructions,
      course: courseArr, subject: subjectArr, groups, totalMarks,
      autoSubmitOnViolation:req.body.autoSubmitOnViolation==='on',
      maxTabSwitches:parseInt(req.body.maxTabSwitches)||3,
      maxFocusLosses:parseInt(req.body.maxFocusLosses)||5,
      blockCopyPaste:req.body.blockCopyPaste==='on',
      requireFullscreen:req.body.requireFullscreen==='on',
      ...(selectedQIds.length ? { questions: selectedQIds } : {}),
    });
    req.flash('success','Test updated!');
    res.redirect(`/admin/tests/${req.params.id}`);
  } catch (e) { req.flash('error','Failed: '+e.message); res.redirect(`/admin/tests/${req.params.id}`); }
};

exports.deleteTest = async (req, res) => {
  try {
    await Test.findByIdAndUpdate(req.params.id, { isActive: false });
    req.flash('success','Test deleted.');
    res.redirect('/admin/tests');
  } catch (e) { req.flash('error','Failed.'); res.redirect('/admin/tests'); }
};

// ── QUESTION TEMPLATE DOWNLOAD ────────────────────────────────────────────
exports.downloadQuestionTemplate = (req, res) => {
  const rows = [
    { question:'What is the SI unit of force?', optionA:'Joule', optionB:'Newton', optionC:'Watt', optionD:'Pascal', correctAnswer:'B', subject:'Physics', topic:'Laws of Motion', subtopic:'', difficulty:'Easy', marks:1, explanation:'Force = mass × acceleration. SI unit is Newton (N).', questionImageUrl:'' },
    { question:'pH of pure water at 25°C?', optionA:'0', optionB:'7', optionC:'14', optionD:'1', correctAnswer:'B', subject:'Chemistry', topic:'Acids and Bases', subtopic:'', difficulty:'Easy', marks:1, explanation:'Pure water is neutral with pH = 7.', questionImageUrl:'' },
    { question:'Derivative of sin(x) is?', optionA:'-cos(x)', optionB:'cos(x)', optionC:'tan(x)', optionD:'-sin(x)', correctAnswer:'B', subject:'Mathematics', topic:'Calculus', subtopic:'', difficulty:'Easy', marks:1, explanation:'d/dx sin(x) = cos(x)', questionImageUrl:'' },
  ];
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(rows);
  ws['!cols'] = [{wch:60},{wch:20},{wch:20},{wch:20},{wch:20},{wch:15},{wch:15},{wch:20},{wch:15},{wch:12},{wch:6},{wch:60},{wch:40}];
  xlsx.utils.book_append_sheet(wb, ws, 'Questions');
  const buf = xlsx.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition','attachment; filename=question_import_template.xlsx');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
};

exports.getUploadTest = async (req, res) => {
  try {
    const groups = await Group.find({ isActive: true });
    res.render('admin/upload-test', { title: 'Upload Test via PDF', groups, COURSES, SUBJECTS: ALL_SUBJECTS });
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/tests'); }
};

exports.uploadPdfTest = async (req, res) => {
  try {
    if (!req.files?.questionPdf) { req.flash('error','Question PDF required.'); return res.redirect('/admin/tests/upload'); }
    const { title, description, duration, negativeMarking, startTime, endTime, instructions, groupIds, courses, subjects, marksPerQuestion } = req.body;
    if (!title?.trim()) { req.flash('error','Test title required.'); return res.redirect('/admin/tests/upload'); }
    const qFname = `q_${Date.now()}.pdf`;
    const qBuf   = req.files.questionPdf.data;
    fs.writeFileSync(path.join(PDF_DIR,qFname), qBuf);
    const questionPdfPath = '/uploads/pdfs/'+qFname;
    let solutionPdfPath = null;
    if (req.files?.solutionPdf) { const fn=`s_${Date.now()}.pdf`; solutionPdfPath='/uploads/pdfs/'+fn; fs.writeFileSync(path.join(PDF_DIR,fn),req.files.solutionPdf.data); }
    let pdfPageCount=0;
    try {
      const ps = qBuf.toString('latin1');
      const pm = ps.match(/\/Type\s*\/Page[^s]/g);
      pdfPageCount = pm ? pm.length : 0;
      if (!pdfPageCount) { const cm=ps.match(/\/Count\s+(\d+)/); pdfPageCount=cm?parseInt(cm[1]):0; }
    } catch {}
    const mpq=parseFloat(marksPerQuestion)||1;
    const totalMarks=pdfPageCount>0?pdfPageCount*mpq:mpq;
    const groups=Array.isArray(groupIds)?groupIds:(groupIds?[groupIds]:[]);
    const courseArr  = Array.isArray(courses)  ? courses  : (courses  ? [courses]  : []);
    const subjectArr = Array.isArray(subjects) ? subjects : (subjects ? [subjects] : []);
    const test = await Test.create({
      title:title.trim(), description:description||null, duration:parseInt(duration)||180,
      negativeMarking:parseFloat(negativeMarking)||0.25, startTime:startTime||null, endTime:endTime||null,
      instructions:instructions||null, totalMarks, createdBy:req.session.user.id, status:'draft',
      course:courseArr, subject:subjectArr, marksPerQuestion:mpq,
      questionPdfPath, solutionPdfPath, groups,
      autoSubmitOnViolation:req.body.autoSubmitOnViolation==='on',
      maxTabSwitches:parseInt(req.body.maxTabSwitches)||3,
      maxFocusLosses:parseInt(req.body.maxFocusLosses)||5,
      blockCopyPaste:req.body.blockCopyPaste!=='off',
      requireFullscreen:req.body.requireFullscreen==='on',
    });
    const pageInfo=pdfPageCount>0?` Detected ${pdfPageCount} page(s) — ${totalMarks} total marks.`:'';
    req.flash('success',`PDF test "${test.title}" created!${pageInfo}${solutionPdfPath?' Model answers attached.':''}`);
    res.redirect(`/admin/tests/${test._id}`);
  } catch (e) { console.error(e); req.flash('error','Failed: '+e.message); res.redirect('/admin/tests/upload'); }
};

// ── PDF TEMPLATE ──────────────────────────────────────────────────────────────
exports.downloadPdfTestTemplate = (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size:'A4', margin:50 });
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition','attachment; filename=question_paper_template.pdf');
    doc.pipe(res);
    const W=595.28, pageW=W-100;
    const pageHeader=(qNum,total,type)=>{
      doc.rect(50,40,pageW,28).fill('#1e3a5f');
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold').text(`SVPN TEST  ·  Question ${qNum} of ${total}`,58,49).text(type,50,49,{width:pageW,align:'right'});
      doc.fillColor('#1e3a5f').fontSize(7).font('Helvetica').text('⚠  1 QUESTION PER PAGE  —  Do not merge pages',50,74,{width:pageW,align:'center'});
      doc.moveTo(50,84).lineTo(W-50,84).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
    };
    const drawOptions=(opts,startY)=>{
      const labels=['A','B','C','D']; let y=startY;
      opts.forEach((opt,i)=>{ doc.rect(50,y,14,14).strokeColor('#94a3b8').lineWidth(0.8).stroke(); doc.fillColor('#374151').fontSize(11).font('Helvetica-Bold').text(labels[i]+'.',68,y+1); doc.font('Helvetica').fillColor('#1f2937').text(opt,88,y+1,{width:pageW-38}); y=doc.y+6; });
      return y;
    };
    const answerBox=(answer,explanation)=>{
      const y=doc.y+14; doc.rect(50,y,pageW,explanation?56:26).fill('#f0fdf4').stroke();
      doc.fillColor('#166534').fontSize(9).font('Helvetica-Bold').text(`✔  Correct Answer: (${answer})`,58,y+7);
      if(explanation) doc.fillColor('#374151').font('Helvetica').fontSize(8.5).text(`Explanation: ${explanation}`,58,y+22,{width:pageW-16});
      doc.fillColor('#94a3b8').fontSize(7).font('Helvetica').text('— END OF QUESTION —',50,doc.page.height-50,{width:pageW,align:'center'});
    };
    pageHeader(1,5,'TEXT QUESTION'); doc.moveDown(0.5);
    doc.fillColor('#1e3a5f').fontSize(10).font('Helvetica-Bold').text('SUBJECT: Physics   |   TOPIC: Laws of Motion   |   MARKS: 2',50,95,{width:pageW});
    doc.moveDown(0.8); doc.fillColor('#111827').fontSize(12.5).font('Helvetica-Bold').text('Q1.  A body of mass 5 kg moves at 10 m/s. A force of 20 N acts for 3 s. What is the final velocity?',50,doc.y,{width:pageW});
    doc.moveDown(1); drawOptions(['25 m/s','22 m/s','20 m/s','30 m/s'],doc.y); answerBox('B','v = u + at = 10 + (20/5)×3 = 22 m/s');
    doc.addPage(); pageHeader(2,5,'QUESTION WITH DIAGRAM'); doc.moveDown(0.5);
    doc.fillColor('#1e3a5f').fontSize(10).font('Helvetica-Bold').text('SUBJECT: Physics   |   TOPIC: Optics   |   MARKS: 3',50,95,{width:pageW});
    doc.moveDown(0.8); doc.fillColor('#111827').fontSize(12.5).font('Helvetica-Bold').text('Q2.  Refer to the ray diagram below. Identify the type of lens and image formed:',50,doc.y,{width:pageW});
    doc.moveDown(0.8);
    const imgY=doc.y,imgH=130;
    doc.rect(50,imgY,pageW,imgH).fill('#f8fafc').strokeColor('#94a3b8').lineWidth(1).stroke();
    doc.moveTo(50,imgY).lineTo(50+pageW,imgY+imgH).strokeColor('#cbd5e1').lineWidth(0.5).dash(4,{space:4}).stroke();
    doc.moveTo(50+pageW,imgY).lineTo(50,imgY+imgH).stroke(); doc.undash();
    doc.fillColor('#64748b').fontSize(11).font('Helvetica-Bold').text('[ Diagram / Image Area ]',50,imgY+imgH/2-18,{width:pageW,align:'center'});
    doc.fillColor('#94a3b8').fontSize(8.5).font('Helvetica').text('Embed your diagram here using a PDF editor',50,imgY+imgH/2,{width:pageW,align:'center'});
    doc.y=imgY+imgH+12; drawOptions(['Convex lens; real and inverted','Concave lens; virtual and erect','Convex lens; virtual and erect','Concave lens; real and inverted'],doc.y);
    answerBox('A','Convex lens forms a real, inverted image when object is beyond F.');
    doc.addPage(); pageHeader(3,5,'TEXT QUESTION'); doc.moveDown(0.5);
    doc.fillColor('#1e3a5f').fontSize(10).font('Helvetica-Bold').text('SUBJECT: Chemistry   |   TOPIC: Chemical Bonding   |   MARKS: 1',50,95,{width:pageW});
    doc.moveDown(0.8); doc.fillColor('#111827').fontSize(12.5).font('Helvetica-Bold').text('Q3.  Bond angle in H₂O is approximately:',50,doc.y,{width:pageW});
    doc.moveDown(1); drawOptions(['90°','109.5°','104.5°','120°'],doc.y); answerBox('C','2 lone pairs compress the bond angle to ~104.5°.');
    doc.addPage(); pageHeader(4,5,'QUESTION WITH STRUCTURE / IMAGE'); doc.moveDown(0.5);
    doc.fillColor('#1e3a5f').fontSize(10).font('Helvetica-Bold').text('SUBJECT: Chemistry   |   TOPIC: Organic Chemistry   |   MARKS: 2',50,95,{width:pageW});
    doc.moveDown(0.8); doc.fillColor('#111827').fontSize(12.5).font('Helvetica-Bold').text('Q4.  The structural formula below belongs to which class of organic compound?',50,doc.y,{width:pageW});
    doc.moveDown(0.8);
    const sY=doc.y,sH=110;
    doc.rect(50,sY,pageW,sH).fill('#fffbeb').strokeColor('#fbbf24').lineWidth(1).stroke();
    doc.fillColor('#92400e').fontSize(11).font('Helvetica-Bold').text('[ Structural Formula / Chemical Structure Image ]',50,sY+sH/2-16,{width:pageW,align:'center'});
    doc.y=sY+sH+12; drawOptions(['Alcohol','Aldehyde','Ketone','Carboxylic Acid'],doc.y); answerBox('D','–COOH functional group = Carboxylic acid.');
    doc.addPage(); pageHeader(5,5,'TEXT QUESTION'); doc.moveDown(0.5);
    doc.fillColor('#1e3a5f').fontSize(10).font('Helvetica-Bold').text('SUBJECT: Mathematics   |   TOPIC: Integration   |   MARKS: 4',50,95,{width:pageW});
    doc.moveDown(0.8); doc.fillColor('#111827').fontSize(12.5).font('Helvetica-Bold').text('Q5.  Evaluate: ∫ (2x³ + 3x² − x + 5) dx',50,doc.y,{width:pageW});
    doc.moveDown(1); drawOptions(['(x⁴/2) + x³ − (x²/2) + 5x + C','(x⁴/2) + x³ + (x²/2) + 5x + C','2x⁴ + 3x³ − x² + 5x + C','x⁴ + x³ − x² + 5 + C'],doc.y);
    answerBox('A','∫2x³dx=x⁴/2, ∫3x²dx=x³, ∫−x dx=−x²/2, ∫5dx=5x');
    doc.end();
  } catch (e) { console.error(e); res.status(500).send('Template failed: '+e.message); }
};
