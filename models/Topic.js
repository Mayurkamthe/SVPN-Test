const mongoose = require('mongoose');

const topicSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  course:    { type: String, enum: ['JEE','CET','NEET'], required: true },
  subject:   { type: String, required: true },
  subtopics: { type: [String], default: [] },
  isActive:  { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.models.Topic || mongoose.model('Topic', topicSchema);
