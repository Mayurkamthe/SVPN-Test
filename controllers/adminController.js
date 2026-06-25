// controllers/adminController.js
const { User, Group, Question, Test, TestQuestion, GroupMember, TestGroup, Result, Notification, Topic, StudentDocument } = require('../models');
const { Op } = require('sequelize');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { generateStudentPassword } = require('../utils/passwordHelper');

const COURSES = ['JEE', 'CET', 'NEET'];
const SUBJECTS_BY_COURSE = {
  JEE:  ['Physics', 'Chemistry', 'Mathematics'],
  CET:  ['Physics', 'Chemistry', 'Mathematics', 'Biology'],
  NEET: ['Physics', 'Chemistry', 'Biology'],
};
const ALL_SUBJECTS = ['Physics', 'Chemistry', 'Mathematics', 'Biology', 'English', 'General Knowledge'];

const loadSubjects = () => ALL_SUBJECTS;
const loadTopics   = async (course, subject) => {
  const where = { isActive: true };
  if (course)  where.course   = course;
  if (subject) where.subject  = subject;
  return Topic.findAll({ where, order: [['name', 'ASC']] });
};

const generatePassword = (rollNo) => {
  const last4 = String(rollNo).slice(-4).padStart(4,'0');
  return `CET@${last4}`;
};

// ── UPLOAD DIR ────────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const DOC_DIR = path.join(UPLOAD_DIR, 'documents');
if (!fs.existsSync(DOC_DIR)) fs.mkdirSync(DOC_DIR, { recursive: true });
const PDF_DIR = path.join(UPLOAD_DIR, 'pdfs');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
exports.getDashboard = async (req, res) => {
  try {
    const [studentCount, testCount, groupCount, questionCount] = await Promise.all([
      User.count({ where: { role: 'student', isActive: true } }),
      Test.count(),
      Group.count({ where: { isActive: true } }),
      Question.count({ where: { isActive: true } }),
    ]);
    const [recentResults, recentUsers] = await Promise.all([
      Result.findAll({ limit: 8, order: [['createdAt', 'DESC']],
        include: [{ model: User, as: 'student', attributes: ['name', 'rollNo'] }, { model: Test, as: 'test', attributes: ['title'] }] }),
      User.findAll({ where: { role: 'student' }, order: [['createdAt', 'DESC']], limit: 5 }),
    ]);
    res.render('admin/dashboard', { title: 'Admin Dashboard', stats: { studentCount, testCount, groupCount, questionCount }, recentResults, recentUsers, COURSES });
  } catch (e) { console.error(e); req.flash('error', 'Failed to load dashboard.'); res.redirect('/auth/login'); }
};

// ── STUDENT MANAGEMENT ────────────────────────────────────────────────────────
exports.getStudents = async (req, res) => {
  try {
    const students = await User.findAll({ where: { role: 'student' }, order: [['rollNo', 'ASC']] });
    const groups   = await Group.findAll({ where: { isActive: true } });
    res.render('admin/students', { title: 'Manage Students', students, groups });
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/dashboard'); }
};

exports.createStudent = async (req, res) => {
  try {
    const { name, rollNo, parentContact, groupId, autoPassword } = req.body;
    if (!rollNo || !name) { req.flash('error', 'Name and Roll No are required.'); return res.redirect('/admin/groups'); }
    const existing = await User.findOne({ where: { rollNo } });
    if (existing) { req.flash('error', `Roll No ${rollNo} already exists.`); return res.redirect(req.get('Referer') || '/admin/students'); }
    const pwd = generatePassword(rollNo);
    const student = await User.create({ name, rollNo, parentContact: parentContact || null, role: 'student', password: pwd, isFirstLogin: true });
    if (groupId) await GroupMember.create({ groupId, userId: student.id, role: 'student' });
    await Notification.create({ userId: student.id, title: 'Account Created', message: `Welcome ${name}! Roll: ${rollNo}, Password: ${pwd}`, type: 'info' });
    req.flash('success', `Student created. Password: ${pwd}`);
    res.redirect(req.get('Referer') || '/admin/students');
  } catch (e) {
    req.flash('error', e.name === 'SequelizeUniqueConstraintError' ? 'Roll number already exists.' : 'Failed: ' + e.message);
    res.redirect(req.get('Referer') || '/admin/students');
  }
};

exports.bulkImportStudents = async (req, res) => {
  try {
    const { groupId } = req.body;
    if (!req.files?.csvFile) { req.flash('error', 'No file uploaded.'); return res.redirect(req.get('Referer') || '/admin/groups'); }
    const wb = xlsx.read(req.files.csvFile.data, { type: 'buffer' });
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    let created = 0, skipped = 0, duplicates = [];
    for (const row of rows) {
      const rollNo       = String(row['Roll No'] || row.rollNo || row.roll_no || '').trim();
      const name         = String(row['Name'] || row.name || '').trim();
      const parentContact= String(row['Parent Contact No'] || row.parentContact || row.parent_contact || '').trim();
      if (!rollNo || !name) { skipped++; continue; }
      const exists = await User.findOne({ where: { rollNo } });
      if (exists) { duplicates.push(rollNo); skipped++; continue; }
      try {
        const pwd = generatePassword(rollNo);
        const student = await User.create({ name, rollNo, parentContact: parentContact || null, role: 'student', password: pwd, isFirstLogin: true });
        if (groupId) await GroupMember.create({ groupId, userId: student.id, role: 'student' }).catch(() => {});
        created++;
      } catch { skipped++; }
    }
    let msg = `Imported ${created} student(s).`;
    if (skipped) msg += ` ${skipped} skipped.`;
    if (duplicates.length) msg += ` Duplicate Roll Nos rejected: ${duplicates.join(', ')}.`;
    req.flash('success', msg);
    res.redirect(req.get('Referer') || '/admin/groups');
  } catch (e) { req.flash('error', 'Import failed: ' + e.message); res.redirect(req.get('Referer') || '/admin/groups'); }
};

// ── GROUP (BATCH) MANAGEMENT ──────────────────────────────────────────────────
exports.getGroups = async (req, res) => {
  try {
    const groups   = await Group.findAll({ include: [{ model: User, as: 'members', through: { attributes: ['role'] } }], order: [['createdAt', 'DESC']] });
    const students = await User.findAll({ where: { role: 'student', isActive: true }, order: [['rollNo', 'ASC']] });
    res.render('admin/groups', { title: 'Batches', groups, students, COURSES });
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/dashboard'); }
};

exports.createGroup = async (req, res) => {
  try {
    const { name, description, academicYear, course } = req.body;
    const group = await Group.create({ name, description, academicYear: academicYear || process.env.ACADEMIC_YEAR, course: course || null });

    // Optional: bulk import students along with group creation
    let imported = 0, skipped = 0;
    if (req.files?.csvFile) {
      const wb   = xlsx.read(req.files.csvFile.data, { type: 'buffer' });
      const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      for (const row of rows) {
        try {
          const rollNo = String(row['Roll No'] || row.rollNo || row.roll_no || '').trim();
          const sName  = String(row['Name']    || row.name   || '').trim();
          if (!rollNo || !sName) { skipped++; continue; }
          const pw = `CET@${rollNo.slice(-4).padStart(4,'0')}`;
          const [student, created] = await User.findOrCreate({
            where: { rollNo },
            defaults: {
              name: sName,
              email:  String(row['Email']   || row.email   || '').trim() || null,
              phone:  String(row['Phone']   || row.phone   || '').trim() || null,
              parentContact: String(row['Parent Contact No'] || row.parentContact || '').trim() || null,
              rollNo, role: 'student', password: pw, isFirstLogin: true,
            },
          });
          await GroupMember.findOrCreate({ where: { groupId: group.id, userId: student.id }, defaults: { role: 'student' } });
          if (created) imported++; else skipped++;
        } catch { skipped++; }
      }
      req.flash('success', `Batch "${name}" created with ${imported} students imported${skipped ? ', ' + skipped + ' skipped' : ''}.`);
    } else {
      req.flash('success', `Batch "${name}" created successfully.`);
    }
    res.redirect('/admin/groups');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Failed. Batch name may already exist.');
    res.redirect('/admin/groups');
  }
};

exports.assignMember = async (req, res) => {
  try {
    const { groupId, userId } = req.body;
    await GroupMember.findOrCreate({ where: { groupId, userId }, defaults: { role: 'student' } });
    req.flash('success', 'Member assigned.');
    res.redirect('/admin/groups');
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/groups'); }
};

// ── DOWNLOAD STUDENT IMPORT TEMPLATE ─────────────────────────────────────────
exports.downloadStudentTemplate = (req, res) => {
  const templateRows = [
    { 'Name': 'Arjun Mehta',  'Roll No': '2024CE001', 'Email': 'arjun@example.com', 'Phone': '9876543210', 'Parent Contact No': '9876543200' },
    { 'Name': 'Priya Patel',  'Roll No': '2024CE002', 'Email': 'priya@example.com', 'Phone': '9876543211', 'Parent Contact No': '9876543201' },
    { 'Name': 'Sample Student','Roll No': '2024CE003', 'Email': 'sample@example.com','Phone': '',            'Parent Contact No': '' },
  ];
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(templateRows);
  // Column widths
  ws['!cols'] = [{ wch: 25 }, { wch: 15 }, { wch: 30 }, { wch: 15 }, { wch: 20 }];
  xlsx.utils.book_append_sheet(wb, ws, 'Students');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=student_import_template.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
};

// ── EXPORT BATCH CREDENTIAL PDF ───────────────────────────────────────────────
exports.exportGroupCredentials = async (req, res) => {
  try {
    const group = await Group.findByPk(req.params.id, {
      include: [{ model: User, as: 'members', through: { attributes: ['role'] } }],
    });
    if (!group) { req.flash('error', 'Batch not found.'); return res.redirect('/admin/groups'); }

    // Fetch plain passwords from Notification (stored on creation)
    const students = group.members.filter(m => m.GroupMember?.role === 'student');

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=credentials_${group.name.replace(/\s+/g,'_')}.pdf`);
    doc.pipe(res);

    // Header
    doc.fontSize(16).font('Helvetica-Bold').text(process.env.COLLEGE_NAME || 'College', { align: 'center' });
    doc.fontSize(11).font('Helvetica').text(`Batch: ${group.name} | AY: ${group.academicYear || ''}`, { align: 'center' });
    doc.moveDown(0.5).moveTo(40, doc.y).lineTo(555, doc.y).stroke().moveDown(0.5);

    // Table header
    const colX = [40, 150, 300, 420];
    const headers = ['Roll No', 'Name', 'Parent Contact', 'Password'];
    doc.fontSize(9).font('Helvetica-Bold');
    headers.forEach((h, i) => doc.text(h, colX[i], doc.y, { continued: i < 3 }));
    doc.moveDown(0.4).moveTo(40, doc.y).lineTo(555, doc.y).stroke().moveDown(0.3);

    // Rows
    doc.font('Helvetica').fontSize(9);
    for (const s of students) {
      const pwd = generatePassword(s.rollNo);
      const rowY = doc.y;
      doc.text(s.rollNo || '',       colX[0], rowY, { width: 105 });
      doc.text(s.name  || '',        colX[1], rowY, { width: 145 });
      doc.text(s.parentContact || '', colX[2], rowY, { width: 115 });
      doc.text(pwd,                  colX[3], rowY, { width: 120 });
      doc.moveDown(0.5);
      if (doc.y > 750) { doc.addPage(); }
    }

    doc.end();
  } catch (e) { console.error(e); res.status(500).send('PDF export failed.'); }
};

// ── CONTENT HIERARCHY (Course → Subject → Topic → Subtopic) ──────────────────
exports.getTopics = async (req, res) => {
  try {
    const { course, subject } = req.query;
    const topics = await loadTopics(course, subject);
    const SUBJECTS = course ? (SUBJECTS_BY_COURSE[course] || ALL_SUBJECTS) : ALL_SUBJECTS;
    res.render('admin/topics', {
      title: 'Content Management',
      topics,
      COURSES,
      SUBJECTS,
      SUBJECTS_BY_COURSE,   // ← add this
      filterCourse: course || '',
      filterSubject: subject || ''
    });
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/dashboard'); }
};

exports.createTopic = async (req, res) => {
  try {
    const { name, course, subject, subtopics } = req.body;
    const subList = subtopics ? subtopics.split('\n').map(s => s.trim()).filter(Boolean) : [];
    await Topic.create({ name, course, subject, subtopics: subList });
    req.flash('success', 'Topic added.');
    res.redirect(`/admin/topics?course=${course}&subject=${encodeURIComponent(subject)}`);
  } catch (e) { req.flash('error', 'Failed: ' + e.message); res.redirect('/admin/topics'); }
};

exports.updateTopic = async (req, res) => {
  try {
    const { name, subtopics } = req.body;
    const subList = subtopics ? subtopics.split('\n').map(s => s.trim()).filter(Boolean) : [];
    await Topic.update({ name, subtopics: subList }, { where: { id: req.params.id } });
    req.flash('success', 'Topic updated.');
    res.redirect('/admin/topics');
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/topics'); }
};

exports.deleteTopic = async (req, res) => {
  try {
    await Topic.update({ isActive: false }, { where: { id: req.params.id } });
    req.flash('success', 'Topic deleted.');
    res.redirect('/admin/topics');
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/topics'); }
};

// AJAX: get subjects for a course
exports.getSubjectsForCourse = (req, res) => {
  const { course } = req.params;
  res.json(SUBJECTS_BY_COURSE[course] || ALL_SUBJECTS);
};

// AJAX: get topics for a course+subject
exports.getTopicsForSubject = async (req, res) => {
  try {
    const { course, subject } = req.query;
    const topics = await loadTopics(course, subject);
    res.json(topics);
  } catch { res.json([]); }
};

// ── QUESTION MANAGEMENT ───────────────────────────────────────────────────────

// AJAX: get subtopics for a topic name
exports.getSubtopicsForTopic = async (req, res) => {
  try {
    const { course, subject, topic } = req.query;
    const where = { isActive: true };
    if (course)  where.course   = course;
    if (subject) where.subject  = subject;
    if (topic)   where.name     = topic;
    const topicRow = await Topic.findOne({ where });
    res.json(topicRow?.subtopics || []);
  } catch { res.json([]); }
};

exports.getQuestions = async (req, res) => {
  try {
    const { subject, topic, subtopic, difficulty, course, sort = 'subject', page = 1 } = req.query;
    const limit = 25, offset = (page - 1) * limit;
    const where = { isActive: true };
    if (subject)   where.subject   = subject;
    if (topic)     where.topic     = topic;
    if (subtopic)  where.subtopic  = subtopic;
    if (difficulty) where.difficulty = difficulty;

    // Build order based on sort param
    let order;
    if (sort === 'difficulty') {
      order = [['difficulty','ASC'],['subject','ASC'],['topic','ASC'],['createdAt','DESC']];
    } else if (sort === 'newest') {
      order = [['createdAt','DESC']];
    } else if (sort === 'oldest') {
      order = [['createdAt','ASC']];
    } else {
      // default: subject → topic → subtopic → difficulty
      order = [['subject','ASC'],['topic','ASC'],['subtopic','ASC'],['difficulty','ASC'],['createdAt','DESC']];
    }

    const { count, rows: questions } = await Question.findAndCountAll({ where, order, limit, offset });
    // Load topics for filter dropdowns
    const topicRows = subject ? await loadTopics(course, subject) : [];
    // Get unique subtopics from selected topic
    const subtopicList = topic
      ? (topicRows.find(t => t.name === topic)?.subtopics || [])
      : [];
    res.render('admin/questions', {
      title: 'Question Bank', questions, total: count,
      currentPage: parseInt(page), totalPages: Math.ceil(count/limit),
      filters: { subject, topic, subtopic, difficulty, course, sort },
      COURSES, SUBJECTS: ALL_SUBJECTS, topicRows, subtopicList,
    });
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/dashboard'); }
};

exports.createQuestion = async (req, res) => {
  try {
    const { question, optionA, optionB, optionC, optionD, correctAnswer,
            subject, topic, subtopic, difficulty, marks, explanation, questionImageUrl } = req.body;
    let questionImage = questionImageUrl || null;
    if (req.files?.questionImage) {
      const { processQuestionImage } = require('../utils/imageUpload');
      questionImage = await processQuestionImage(req.files.questionImage, `q_${Date.now()}`);
    }
    await Question.create({
      question, optionA, optionB, optionC, optionD, correctAnswer,
      subject, topic: topic||null, subtopic: subtopic||null,
      difficulty, marks: parseFloat(marks)||1, explanation: explanation||null,
      questionImage, createdBy: req.session.user.id,
    });
    req.flash('success', 'Question added.');
    res.redirect(`/admin/questions?subject=${encodeURIComponent(subject||'')}&topic=${encodeURIComponent(topic||'')}`);
  } catch (e) { req.flash('error', 'Failed: ' + e.message); res.redirect('/admin/questions'); }
};

exports.bulkImportQuestions = async (req, res) => {
  try {
    if (!req.files?.csvFile) { req.flash('error', 'No file uploaded.'); return res.redirect('/admin/questions'); }
    const wb   = xlsx.read(req.files.csvFile.data, { type: 'buffer' });
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    let created = 0;
    for (const row of rows) {
      try {
        await Question.create({
          question: row.question || row.Question, optionA: row.optionA || row['Option A'],
          optionB: row.optionB || row['Option B'], optionC: row.optionC || row['Option C'], optionD: row.optionD || row['Option D'],
          correctAnswer: (row.correctAnswer||'A').toUpperCase(), subject: row.subject||'Physics',
          difficulty: row.difficulty||'Medium', marks: parseFloat(row.marks||1),
          topic: row.topic||null, subtopic: row.subtopic||row.Subtopic||null, explanation: row.explanation||null, createdBy: req.session.user.id,
        });
        created++;
      } catch {}
    }
    req.flash('success', `${created} questions imported.`);
    res.redirect('/admin/questions');
  } catch (e) { req.flash('error', 'Import failed.'); res.redirect('/admin/questions'); }
};

exports.deleteQuestion = async (req, res) => {
  try {
    await Question.update({ isActive: false }, { where: { id: req.params.id } });
    req.flash('success', 'Question removed.');
    res.redirect('/admin/questions');
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/questions'); }
};

// ── TEST MANAGEMENT ───────────────────────────────────────────────────────────
exports.getTests = async (req, res) => {
  try {
    const { subject, course } = req.query;
    const where = {};
    if (subject) where.subject = subject;
    if (course)  where.course  = course;
    const tests = await Test.findAll({
      where, include: [{ model: Group, as: 'groups', through: { attributes: [] } }],
      order: [['createdAt', 'DESC']],
    });
    res.render('admin/tests', { title: 'Tests', tests, COURSES, SUBJECTS: ALL_SUBJECTS, filterSubject: subject||'', filterCourse: course||'' });
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/dashboard'); }
};

exports.getCreateTest = async (req, res) => {
  try {
    const { subject, course } = req.query;
    const groups = await Group.findAll({ where: { isActive: true } });
    const where = { isActive: true };
    if (subject) where.subject = subject;
    const questions = await Question.findAll({ where, order: [['subject','ASC'],['difficulty','ASC']] });
    const topics = await loadTopics(course, subject);
    res.render('admin/create-test', { title: 'Create Test', groups, questions, COURSES, SUBJECTS: ALL_SUBJECTS, topics, filterSubject: subject||'', filterCourse: course||'' });
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/tests'); }
};

exports.createTest = async (req, res) => {
  try {
    const questionIds_raw = req.body.questionIds;
    const selectedQIds = Array.isArray(questionIds_raw) ? questionIds_raw : (questionIds_raw ? [questionIds_raw] : []);
    if (selectedQIds.length === 0) {
      req.flash('error', 'Please select at least one question for the test.');
      return res.redirect('/admin/tests/create');
    }
    const { title, description, duration, negativeMarking, passingMarks, shuffleQuestions, shuffleOptions,
            startTime, endTime, instructions, groupIds, questionIds, course, subject, topic, subtopic, marksPerQuestion } = req.body;
    const selected = Array.isArray(questionIds) ? questionIds : (questionIds ? [questionIds] : []);
    const questionsData = await Question.findAll({ where: { id: selected } });
    const totalMarks = questionsData.reduce((s, q) => s + q.marks, 0);

    let questionPdfPath = null, solutionPdfPath = null;
    if (req.files?.questionPdf) {
      const fname = `q_${Date.now()}.pdf`;
      questionPdfPath = '/uploads/pdfs/' + fname;
      fs.writeFileSync(path.join(PDF_DIR, fname), req.files.questionPdf.data);
    }
    if (req.files?.solutionPdf) {
      const fname = `s_${Date.now()}.pdf`;
      solutionPdfPath = '/uploads/pdfs/' + fname;
      fs.writeFileSync(path.join(PDF_DIR, fname), req.files.solutionPdf.data);
    }

    const test = await Test.create({
      title, description, duration: parseInt(duration)||180,
      negativeMarking: parseFloat(negativeMarking)||0.25, passingMarks: parseFloat(passingMarks)||null,
      shuffleQuestions: shuffleQuestions==='on', shuffleOptions: shuffleOptions==='on',
      startTime: startTime||null, endTime: endTime||null, instructions,
      totalMarks, createdBy: req.session.user.id, status: 'draft',
      course: course||null, subject: subject||null, topic: topic||null, subtopic: subtopic||null,
      marksPerQuestion: parseFloat(marksPerQuestion)||1,
      questionPdfPath, solutionPdfPath,
      // Anti-cheat settings
      autoSubmitOnViolation: req.body.autoSubmitOnViolation === 'on',
      maxTabSwitches: parseInt(req.body.maxTabSwitches) || 3,
      maxFocusLosses: parseInt(req.body.maxFocusLosses) || 5,
      blockCopyPaste: req.body.blockCopyPaste === 'on',
      requireFullscreen: req.body.requireFullscreen === 'on',
    });
    for (let i = 0; i < selected.length; i++) await TestQuestion.create({ testId: test.id, questionId: selected[i], orderIndex: i });
    const groups = Array.isArray(groupIds) ? groupIds : (groupIds ? [groupIds] : []);
    for (const gId of groups) await TestGroup.create({ testId: test.id, groupId: gId });
    req.flash('success', 'Test created!');
    res.redirect(`/admin/tests/${test.id}`);
  } catch (e) { req.flash('error', 'Failed: ' + e.message); res.redirect('/admin/tests/create'); }
};

exports.getTestDetail = async (req, res) => {
  try {
    const test = await Test.findOne({
      where: { id: req.params.id },
      include: [{ model: Question, as: 'questions', through: { attributes: ['orderIndex'] } }, { model: Group, as: 'groups', through: { attributes: [] } }],
    });
    if (!test) { req.flash('error', 'Not found.'); return res.redirect('/admin/tests'); }
    const results = await Result.findAll({
      where: { testId: test.id, status: { [Op.in]: ['submitted','auto_submitted'] } },
      include: [{ model: User, as: 'student', attributes: ['name','rollNo'] }],
      order: [['score','DESC']],
    });
    res.render('admin/test-detail', { title: test.title, test, results });
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/tests'); }
};

exports.publishTest = async (req, res) => {
  try {
    const test = await Test.findByPk(req.params.id);
    if (!test) { req.flash('error', 'Not found.'); return res.redirect('/admin/tests'); }
    await test.update({ status: 'published' });
    const testGroups = await TestGroup.findAll({ where: { testId: test.id } });
    for (const tg of testGroups) {
      const members = await GroupMember.findAll({ where: { groupId: tg.groupId, role: 'student' } });
      for (const m of members) await Notification.create({ userId: m.userId, title: 'New Exam Published', message: `"${test.title}" is now available. Duration: ${test.duration} mins.`, type: 'exam', link: '/student/tests' });
    }
    req.flash('success', 'Test published and students notified!');
    res.redirect(`/admin/tests/${test.id}`);
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/tests'); }
};

// ── RESULTS ───────────────────────────────────────────────────────────────────
exports.getAllResults = async (req, res) => {
  try {
    const results = await Result.findAll({
      include: [{ model: User, as: 'student', attributes: ['name','rollNo'] }, { model: Test, as: 'test', attributes: ['title','course','subject'] }],
      order: [['createdAt','DESC']],
    });
    res.render('admin/results', { title: 'All Results', results });
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/dashboard'); }
};

exports.exportResultsExcel = async (req, res) => {
  try {
    const results = await Result.findAll({
      include: [{ model: User, as: 'student', attributes: ['name','rollNo'] }, { model: Test, as: 'test', attributes: ['title'] }],
      order: [['createdAt','DESC']],
    });
    const data = results.map(r => ({
      'Roll No': r.student?.rollNo, Name: r.student?.name, Test: r.test?.title,
      Score: r.score, 'Total Marks': r.totalMarks,
      Percentage: r.totalMarks > 0 ? ((r.score/r.totalMarks)*100).toFixed(1)+'%' : '0%',
      Rank: r.rank||'', Status: r.status, Date: r.submittedAt ? new Date(r.submittedAt).toLocaleDateString('en-IN') : '',
    }));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(data), 'Results');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=results.xlsx');
    res.send(buf);
  } catch (e) { req.flash('error', 'Export failed.'); res.redirect('/admin/results'); }
};

// ── STUDENT DOCUMENTS ─────────────────────────────────────────────────────────
exports.getDocuments = async (req, res) => {
  try {
    const docs = await StudentDocument.findAll({
      include: [{ model: User, as: 'student', attributes: ['name','rollNo'] }],
      order: [['createdAt','DESC']],
    });
    res.render('admin/documents', { title: 'Student Documents', docs });
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/dashboard'); }
};

exports.deleteDocument = async (req, res) => {
  try {
    const doc = await StudentDocument.findByPk(req.params.id);
    if (doc) {
      const fullPath = path.join(__dirname, '..', 'public', doc.filePath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      await doc.destroy();
    }
    req.flash('success', 'Document deleted.');
    res.redirect('/admin/documents');
  } catch (e) { req.flash('error', 'Failed.'); res.redirect('/admin/documents'); }
};

// ── PDF-ONLY TEST UPLOAD ───────────────────────────────────────────────────────
// Creates a test from uploaded PDFs (question paper + model answers).
// 1 question per page convention: page count of question PDF = question count.
exports.uploadPdfTest = async (req, res) => {
  try {
    if (!req.files?.questionPdf) {
      req.flash('error', 'Question paper PDF is required.');
      return res.redirect('/admin/tests/create');
    }

    const { title, description, duration, negativeMarking, startTime, endTime,
            instructions, groupIds, course, subject, marksPerQuestion } = req.body;

    if (!title || !title.trim()) {
      req.flash('error', 'Test title is required.');
      return res.redirect('/admin/tests/create');
    }

    // Save Question PDF
    const qFname = `q_${Date.now()}.pdf`;
    const questionPdfPath = '/uploads/pdfs/' + qFname;
    const qBuf = req.files.questionPdf.data;
    fs.writeFileSync(path.join(PDF_DIR, qFname), qBuf);

    // Save Solution / Model Answers PDF (optional)
    let solutionPdfPath = null;
    if (req.files?.solutionPdf) {
      const sFname = `s_${Date.now()}.pdf`;
      solutionPdfPath = '/uploads/pdfs/' + sFname;
      fs.writeFileSync(path.join(PDF_DIR, sFname), req.files.solutionPdf.data);
    }

    // Count pages in question PDF by scanning /Type /Page markers
    let pdfPageCount = 0;
    try {
      const pdfStr = qBuf.toString('latin1');
      const pageMatches = pdfStr.match(/\/Type\s*\/Page[^s]/g);
      pdfPageCount = pageMatches ? pageMatches.length : 0;
      if (!pdfPageCount) {
        const countMatch = pdfStr.match(/\/Count\s+(\d+)/);
        pdfPageCount = countMatch ? parseInt(countMatch[1]) : 0;
      }
    } catch (_) { pdfPageCount = 0; }

    const mpq = parseFloat(marksPerQuestion) || 1;
    const totalMarks = pdfPageCount > 0 ? pdfPageCount * mpq : mpq;

    const test = await Test.create({
      title: title.trim(),
      description: description || null,
      duration: parseInt(duration) || 180,
      negativeMarking: parseFloat(negativeMarking) || 0.25,
      passingMarks: null,
      shuffleQuestions: false,
      shuffleOptions: false,
      startTime: startTime || null,
      endTime: endTime || null,
      instructions: instructions || null,
      totalMarks,
      createdBy: req.session.user.id,
      status: 'draft',
      course: course || null,
      subject: subject || null,
      topic: null,
      subtopic: null,
      marksPerQuestion: mpq,
      questionPdfPath,
      solutionPdfPath,
      autoSubmitOnViolation: req.body.autoSubmitOnViolation === 'on',
      maxTabSwitches: parseInt(req.body.maxTabSwitches) || 3,
      maxFocusLosses: parseInt(req.body.maxFocusLosses) || 5,
      blockCopyPaste: req.body.blockCopyPaste !== 'off',
      requireFullscreen: req.body.requireFullscreen === 'on',
    });

    const groups = Array.isArray(groupIds) ? groupIds : (groupIds ? [groupIds] : []);
    for (const gId of groups) await TestGroup.create({ testId: test.id, groupId: gId });

    const pageInfo = pdfPageCount > 0
      ? ` Detected ${pdfPageCount} page(s) — ${pdfPageCount} question(s), ${totalMarks} total marks.`
      : '';
    req.flash('success', `PDF test "${test.title}" created!${pageInfo}${solutionPdfPath ? ' Model answers PDF attached.' : ''}`);
    res.redirect(`/admin/tests/${test.id}`);
  } catch (e) {
    console.error('uploadPdfTest error:', e);
    req.flash('error', 'Failed to create PDF test: ' + e.message);
    res.redirect('/admin/tests/create');
  }
};

// ── PDF QUESTION TEMPLATE DOWNLOAD ────────────────────────────────────────────
// Generates a sample question paper PDF (5 sample questions, 1 per page)
// demonstrating: text-only questions, and questions with image placeholders.
exports.downloadPdfTestTemplate = (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=question_paper_template.pdf');
    doc.pipe(res);

    const W = 595.28; // A4 width pts
    const pageW = W - 100; // usable width (margin 50 each side)

    // ── Helper: draw page header ──────────────────────────────────────────────
    const pageHeader = (qNum, total, type) => {
      // Top bar
      doc.rect(50, 40, pageW, 28).fill('#1e3a5f');
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold')
         .text(`SVPN TEST  ·  Question ${qNum} of ${total}`, 58, 49)
         .text(type, 50, 49, { width: pageW, align: 'right' });
      doc.fillColor('#1e3a5f').fontSize(7).font('Helvetica')
         .text('⚠  1 QUESTION PER PAGE  —  Do not merge pages', 50, 74, { width: pageW, align: 'center' });
      doc.moveTo(50, 84).lineTo(W - 50, 84).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
    };

    // ── Helper: MCQ options block ─────────────────────────────────────────────
    const drawOptions = (opts, startY) => {
      const labels = ['A', 'B', 'C', 'D'];
      let y = startY;
      opts.forEach((opt, i) => {
        doc.rect(50, y, 14, 14).strokeColor('#94a3b8').lineWidth(0.8).stroke();
        doc.fillColor('#374151').fontSize(11).font('Helvetica-Bold')
           .text(labels[i] + '.', 68, y + 1);
        doc.font('Helvetica').fillColor('#1f2937')
           .text(opt, 88, y + 1, { width: pageW - 38 });
        y = doc.y + 6;
      });
      return y;
    };

    // ── Helper: answer key box ────────────────────────────────────────────────
    const answerBox = (answer, explanation) => {
      const y = doc.y + 14;
      doc.rect(50, y, pageW, explanation ? 56 : 26).fill('#f0fdf4').stroke();
      doc.fillColor('#166534').fontSize(9).font('Helvetica-Bold')
         .text(`✔  Correct Answer: (${answer})`, 58, y + 7);
      if (explanation) {
        doc.fillColor('#374151').font('Helvetica').fontSize(8.5)
           .text(`Explanation: ${explanation}`, 58, y + 22, { width: pageW - 16 });
      }
      // Footer note
      doc.fillColor('#94a3b8').fontSize(7).font('Helvetica')
         .text('— END OF QUESTION —', 50, doc.page.height - 50, { width: pageW, align: 'center' });
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // PAGE 1 — Text-only question
    // ═══════════════════════════════════════════════════════════════════════════
    pageHeader(1, 5, 'TEXT QUESTION');
    doc.moveDown(0.5);
    doc.fillColor('#1e3a5f').fontSize(10).font('Helvetica-Bold')
       .text('SUBJECT: Physics   |   TOPIC: Laws of Motion   |   DIFFICULTY: Medium   |   MARKS: 2', 50, 95, { width: pageW });
    doc.moveTo(50, doc.y + 2).lineTo(W - 50, doc.y + 2).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    doc.moveDown(0.8);
    doc.fillColor('#111827').fontSize(12.5).font('Helvetica-Bold')
       .text('Q1.  A body of mass 5 kg is moving with a velocity of 10 m/s. A force of 20 N acts on it for 3 seconds in the direction of motion. What is the final velocity of the body?', 50, doc.y, { width: pageW });
    doc.moveDown(1);
    drawOptions([
      '25 m/s',
      '22 m/s',
      '20 m/s',
      '30 m/s',
    ], doc.y);
    answerBox('B', 'Using v = u + at, a = F/m = 20/5 = 4 m/s². v = 10 + 4×3 = 22 m/s');

    // ═══════════════════════════════════════════════════════════════════════════
    // PAGE 2 — Question with embedded image placeholder
    // ═══════════════════════════════════════════════════════════════════════════
    doc.addPage();
    pageHeader(2, 5, 'QUESTION WITH DIAGRAM');
    doc.moveDown(0.5);
    doc.fillColor('#1e3a5f').fontSize(10).font('Helvetica-Bold')
       .text('SUBJECT: Physics   |   TOPIC: Optics   |   DIFFICULTY: Hard   |   MARKS: 3', 50, 95, { width: pageW });
    doc.moveTo(50, doc.y + 2).lineTo(W - 50, doc.y + 2).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    doc.moveDown(0.8);
    doc.fillColor('#111827').fontSize(12.5).font('Helvetica-Bold')
       .text('Q2.  Refer to the ray diagram shown below. Identify the type of lens and the nature of the image formed:', 50, doc.y, { width: pageW });
    doc.moveDown(0.8);

    // ── Image placeholder box (simulates an embedded diagram) ─────────────────
    const imgBoxY = doc.y;
    const imgBoxH = 130;
    doc.rect(50, imgBoxY, pageW, imgBoxH).fill('#f8fafc').strokeColor('#94a3b8').lineWidth(1).stroke();
    // Dashed diagonal lines to show "image area"
    doc.moveTo(50, imgBoxY).lineTo(50 + pageW, imgBoxY + imgBoxH).strokeColor('#cbd5e1').lineWidth(0.5).dash(4,{space:4}).stroke();
    doc.moveTo(50 + pageW, imgBoxY).lineTo(50, imgBoxY + imgBoxH).stroke();
    doc.undash();
    // Label inside placeholder
    doc.fillColor('#64748b').fontSize(11).font('Helvetica-Bold')
       .text('[ Diagram / Image Area ]', 50, imgBoxY + imgBoxH / 2 - 18, { width: pageW, align: 'center' });
    doc.fillColor('#94a3b8').fontSize(8.5).font('Helvetica')
       .text('Place your question diagram here (jpg/png embedded in the PDF)', 50, imgBoxY + imgBoxH / 2, { width: pageW, align: 'center' });
    doc.fillColor('#64748b').fontSize(8).font('Helvetica-Oblique')
       .text('Tip: Insert image using any PDF editor (Adobe, LibreOffice Draw, Canva, etc.)', 50, imgBoxY + imgBoxH / 2 + 16, { width: pageW, align: 'center' });

    doc.y = imgBoxY + imgBoxH + 12;
    drawOptions([
      'Convex lens; real and inverted image',
      'Concave lens; virtual and erect image',
      'Convex lens; virtual and erect image',
      'Concave lens; real and inverted image',
    ], doc.y);
    answerBox('A', 'A convex (converging) lens forms a real, inverted image when the object is beyond F.');

    // ═══════════════════════════════════════════════════════════════════════════
    // PAGE 3 — Chemistry text question
    // ═══════════════════════════════════════════════════════════════════════════
    doc.addPage();
    pageHeader(3, 5, 'TEXT QUESTION');
    doc.moveDown(0.5);
    doc.fillColor('#1e3a5f').fontSize(10).font('Helvetica-Bold')
       .text('SUBJECT: Chemistry   |   TOPIC: Chemical Bonding   |   DIFFICULTY: Easy   |   MARKS: 1', 50, 95, { width: pageW });
    doc.moveTo(50, doc.y + 2).lineTo(W - 50, doc.y + 2).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    doc.moveDown(0.8);
    doc.fillColor('#111827').fontSize(12.5).font('Helvetica-Bold')
       .text('Q3.  The bond angle in a water molecule (H₂O) is approximately:', 50, doc.y, { width: pageW });
    doc.moveDown(1);
    drawOptions(['90°', '109.5°', '104.5°', '120°'], doc.y);
    answerBox('C', 'H₂O has 2 lone pairs on oxygen which compress the bond angle to ~104.5°.');

    // ═══════════════════════════════════════════════════════════════════════════
    // PAGE 4 — Question with structural formula placeholder
    // ═══════════════════════════════════════════════════════════════════════════
    doc.addPage();
    pageHeader(4, 5, 'QUESTION WITH STRUCTURE / IMAGE');
    doc.moveDown(0.5);
    doc.fillColor('#1e3a5f').fontSize(10).font('Helvetica-Bold')
       .text('SUBJECT: Chemistry   |   TOPIC: Organic Chemistry   |   DIFFICULTY: Medium   |   MARKS: 2', 50, 95, { width: pageW });
    doc.moveTo(50, doc.y + 2).lineTo(W - 50, doc.y + 2).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    doc.moveDown(0.8);
    doc.fillColor('#111827').fontSize(12.5).font('Helvetica-Bold')
       .text('Q4.  The structural formula shown below belongs to which class of organic compound?', 50, doc.y, { width: pageW });
    doc.moveDown(0.8);

    // Structure placeholder
    const sBoxY = doc.y;
    const sBoxH = 110;
    doc.rect(50, sBoxY, pageW, sBoxH).fill('#fffbeb').strokeColor('#fbbf24').lineWidth(1).stroke();
    doc.moveTo(50, sBoxY).lineTo(50 + pageW, sBoxY + sBoxH).strokeColor('#fde68a').lineWidth(0.5).dash(4,{space:4}).stroke();
    doc.moveTo(50 + pageW, sBoxY).lineTo(50, sBoxY + sBoxH).stroke();
    doc.undash();
    doc.fillColor('#92400e').fontSize(11).font('Helvetica-Bold')
       .text('[ Structural Formula / Chemical Structure Image ]', 50, sBoxY + sBoxH / 2 - 16, { width: pageW, align: 'center' });
    doc.fillColor('#b45309').fontSize(8.5).font('Helvetica')
       .text('Embed the structural image here using a PDF editor before distributing', 50, sBoxY + sBoxH / 2 + 4, { width: pageW, align: 'center' });

    doc.y = sBoxY + sBoxH + 12;
    drawOptions(['Alcohol', 'Aldehyde', 'Ketone', 'Carboxylic Acid'], doc.y);
    answerBox('D', 'The –COOH functional group identifies a carboxylic acid.');

    // ═══════════════════════════════════════════════════════════════════════════
    // PAGE 5 — Maths / Biology text question
    // ═══════════════════════════════════════════════════════════════════════════
    doc.addPage();
    pageHeader(5, 5, 'TEXT QUESTION');
    doc.moveDown(0.5);
    doc.fillColor('#1e3a5f').fontSize(10).font('Helvetica-Bold')
       .text('SUBJECT: Mathematics   |   TOPIC: Integration   |   DIFFICULTY: Hard   |   MARKS: 4', 50, 95, { width: pageW });
    doc.moveTo(50, doc.y + 2).lineTo(W - 50, doc.y + 2).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    doc.moveDown(0.8);
    doc.fillColor('#111827').fontSize(12.5).font('Helvetica-Bold')
       .text('Q5.  Evaluate: ∫ (2x³ + 3x² − x + 5) dx', 50, doc.y, { width: pageW });
    doc.moveDown(1);
    drawOptions([
      '(x⁴/2) + x³ − (x²/2) + 5x + C',
      '(x⁴/2) + x³ + (x²/2) + 5x + C',
      '2x⁴ + 3x³ − x² + 5x + C',
      'x⁴ + x³ − x² + 5 + C',
    ], doc.y);
    answerBox('A', 'Integrate term by term: ∫2x³dx = x⁴/2, ∫3x²dx = x³, ∫−x dx = −x²/2, ∫5dx = 5x.');

    // ═══════════════════════════════════════════════════════════════════════════
    // Final instructions page (not a question page — for admin reference)
    // ═══════════════════════════════════════════════════════════════════════════
    doc.addPage();
    doc.rect(50, 40, pageW, 32).fill('#1e3a5f');
    doc.fillColor('#ffffff').fontSize(13).font('Helvetica-Bold')
       .text('PDF Question Paper — Format Guide', 58, 50);
    doc.moveDown(2);

    const rules = [
      ['1 Question Per Page', 'Every page of the question PDF must contain exactly ONE question. The system counts PDF pages to determine the total number of questions.'],
      ['Images / Diagrams', 'For questions with diagrams, structural formulas, graphs, or images — embed the image directly into the page using a PDF editor (Adobe Acrobat, LibreOffice Draw, Canva, etc.). The system will display the full PDF page to students, so images render automatically.'],
      ['Model Answers PDF', 'Upload a separate PDF for model answers / solution key. This file is stored securely and is only visible to admins. 1 solution per page is recommended but not required.'],
      ['Marks Per Question', 'Set "Marks Per Question" in the upload form. All questions are assumed equal marks. Total marks = pages × marks per question.'],
      ['Supported PDF Size', 'Maximum 20 MB per PDF file. Use compressed images inside the PDF to keep file size small.'],
      ['Page Order', 'Questions are displayed to students in page order (Page 1 = Q1, Page 2 = Q2, ...). Reorder pages in your PDF editor before uploading if needed.'],
    ];

    rules.forEach(([title, desc]) => {
      doc.fillColor('#1e3a5f').fontSize(11).font('Helvetica-Bold').text('▸  ' + title, 50, doc.y);
      doc.fillColor('#374151').fontSize(10).font('Helvetica').text(desc, 65, doc.y + 2, { width: pageW - 15 });
      doc.moveDown(1.2);
    });

    doc.end();
  } catch (e) {
    console.error('downloadPdfTestTemplate error:', e);
    res.status(500).send('Template generation failed: ' + e.message);
  }
};
