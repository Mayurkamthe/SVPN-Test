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
