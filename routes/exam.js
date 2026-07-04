// routes/exam.js
const express = require('express');
const router = express.Router();
const ec = require('../controllers/examController');
const { isAuthenticated, requirePasswordChange } = require('../middleware/auth');
const guard = [isAuthenticated, requirePasswordChange];

router.get('/:testId/instructions',      ...guard, ec.getInstructions);
router.post('/:testId/start',            ...guard, ec.startExam);
router.get('/:testId/question/:qNum',    ...guard, ec.getQuestion);
router.post('/:testId/save-answer',      ...guard, ec.saveAnswer);
router.post('/:testId/report-violation', ...guard, ec.reportViolation);
router.post('/:testId/submit',           ...guard, ec.submitExam);
router.get('/:testId/auto-submit',       ...guard, ec.autoSubmit);
router.post('/:testId/leave',            ...guard, ec.leaveExam);

module.exports = router;
