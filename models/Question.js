const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
  question:         { type: String, required: true },
  questionImage:    { type: String, default: null },
  optionA:          { type: String, required: true },
  optionB:          { type: String, required: true },
  optionC:          { type: String, required: true },
  optionD:          { type: String, required: true },
  optionAImage:     { type: String, default: null },
  optionBImage:     { type: String, default: null },
  optionCImage:     { type: String, default: null },
  optionDImage:     { type: String, default: null },
  correctAnswer:    { type: String, enum: ['A','B','C','D'], required: true },
  subject:          { type: String, required: true },
  difficulty:       { type: String, enum: ['Easy','Medium','Hard'], default: 'Medium' },
  marks:            { type: Number, default: 1.0 },
  explanation:      { type: String, default: null },
  explanationImage: { type: String, default: null },
  topic:            { type: String, default: null },
  subtopic:         { type: String, default: null },
  createdBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isActive:         { type: Boolean, default: true },
}, { timestamps: true });

questionSchema.index({ subject: 1, topic: 1, difficulty: 1 });

module.exports = mongoose.models.Question || mongoose.model('Question', questionSchema);
