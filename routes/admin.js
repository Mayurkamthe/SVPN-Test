const express        = require('express');
const router         = express.Router();
const c              = require('../controllers/adminController');
const { isAuthenticated, requireRole, requirePasswordChange } = require('../middleware/auth');

const guard = [isAuthenticated, requirePasswordChange, requireRole('admin')];

router.get('/dashboard', ...guard, c.getDashboard);

// Students
router.get('/students',              ...guard, c.getStudents);
router.post('/students',             ...guard, c.createStudent);
router.post('/students/bulk-import', ...guard, c.bulkImportStudents);

// Batches / Groups
router.get('/groups',                    ...guard, c.getGroups);
router.post('/groups',                   ...guard, c.createGroup);
router.post('/groups/assign-member',     ...guard, c.assignMember);
router.get('/groups/:id/credentials-pdf',...guard, c.exportGroupCredentials);
router.get('/groups/template/download',   ...guard, c.downloadStudentTemplate);
router.post('/groups/:id/bulk-import',   ...guard, c.bulkImportStudents);
router.post('/groups/:id/add-student',   ...guard, c.createStudent);

// Content hierarchy
router.get('/topics',        ...guard, c.getTopics);
router.post('/topics',       ...guard, c.createTopic);
router.post('/topics/:id',   ...guard, c.updateTopic);
router.post('/topics/:id/delete', ...guard, c.deleteTopic);

// AJAX helpers
router.get('/ajax/subjects/:course', ...guard, c.getSubjectsForCourse);
router.get('/ajax/topics',           ...guard, c.getTopicsForSubject);
router.get('/ajax/subtopics',        ...guard, c.getSubtopicsForTopic);

// Questions
router.get('/questions',              ...guard, c.getQuestions);
router.post('/questions',             ...guard, c.createQuestion);
router.post('/questions/bulk-import', ...guard, c.bulkImportQuestions);
router.delete('/questions/:id',       ...guard, c.deleteQuestion);
router.post('/questions/:id/delete',  ...guard, c.deleteQuestion);

// Tests
router.get('/tests',                  ...guard, c.getTests);
router.get('/tests/create',           ...guard, c.getCreateTest);
router.post('/tests',                 ...guard, c.createTest);
router.post('/tests/upload-pdf',      ...guard, c.uploadPdfTest);
router.get('/tests/:id',              ...guard, c.getTestDetail);
router.post('/tests/:id/publish',     ...guard, c.publishTest);

// Results
router.get('/results',        ...guard, c.getAllResults);
router.get('/results/export', ...guard, c.exportResultsExcel);

// Documents
router.get('/documents',          ...guard, c.getDocuments);
router.post('/documents/:id/delete',...guard, c.deleteDocument);

module.exports = router;
