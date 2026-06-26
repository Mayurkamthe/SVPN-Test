const mongoose = require('mongoose');

const testSchema = new mongoose.Schema({
  title:           { type: String, required: true },
  description:     { type: String, default: null },
  duration:        { type: Number, default: 180 },   // minutes
  totalMarks:      { type: Number, default: 0 },
  negativeMarking: { type: Number, default: 0.25 },
  passingMarks:    { type: Number, default: null },
  shuffleQuestions:{ type: Boolean, default: true },
  shuffleOptions:  { type: Boolean, default: false },
  status:          { type: String, enum: ['draft','published','active','closed'], default: 'draft' },
  startTime:       { type: Date, default: null },
  endTime:         { type: Date, default: null },
  createdBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  instructions:    { type: String, default: null },
  course:          { type: String, enum: ['JEE','CET','NEET', null], default: null },
  subject:         { type: String, default: null },
  topic:           { type: String, default: null },
  subtopic:        { type: String, default: null },
  marksPerQuestion:{ type: Number, default: 1 },
  questionPdfPath: { type: String, default: null },
  solutionPdfPath: { type: String, default: null },
  // Embedded question list (replaces TestQuestion join table)
  questions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Question' }],
  // Groups assigned (replaces TestGroup join table)
  groups:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Group' }],
  // Anti-cheat
  autoSubmitOnViolation: { type: Boolean, default: false },
  maxTabSwitches:        { type: Number, default: 3 },
  maxFocusLosses:        { type: Number, default: 5 },
  blockCopyPaste:        { type: Boolean, default: true },
  requireFullscreen:     { type: Boolean, default: false },
  isActive:              { type: Boolean, default: true },
}, { timestamps: true });

testSchema.index({ status: 1, createdBy: 1 });

module.exports = mongoose.models.Test || mongoose.model('Test', testSchema);
