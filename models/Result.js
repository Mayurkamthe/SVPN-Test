const mongoose = require('mongoose');

const resultSchema = new mongoose.Schema({
  studentId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User',  required: true },
  testId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Test',  required: true },
  score:           { type: Number, default: 0 },
  totalMarks:      { type: Number, default: 0 },
  correctAnswers:  { type: Number, default: 0 },
  wrongAnswers:    { type: Number, default: 0 },
  skippedAnswers:  { type: Number, default: 0 },
  rank:            { type: Number, default: null },
  percentile:      { type: Number, default: null },
  timeTaken:       { type: Number, default: null },  // seconds
  answers:         { type: mongoose.Schema.Types.Mixed, default: {} },
  questionTimings: { type: mongoose.Schema.Types.Mixed, default: {} },
  subjectScores:   { type: mongoose.Schema.Types.Mixed, default: {} },
  topicScores:     { type: mongoose.Schema.Types.Mixed, default: {} },
  cheatingFlags:   { type: mongoose.Schema.Types.Mixed, default: { tabSwitches: 0, fullscreenExits: 0, focusLosses: 0 } },
  violationCount:  { type: Number, default: 0 },
  status:          { type: String, enum: ['in_progress','submitted','auto_submitted','terminated'], default: 'in_progress' },
  questionOrder:   { type: [mongoose.Schema.Types.Mixed], default: [] },
  markedForReview: { type: [mongoose.Schema.Types.Mixed], default: [] },
  startedAt:       { type: Date, default: null },
  submittedAt:     { type: Date, default: null },
}, { timestamps: true });

resultSchema.index({ studentId: 1, testId: 1 });
resultSchema.index({ testId: 1, status: 1 });

module.exports = mongoose.models.Result || mongoose.model('Result', resultSchema);
