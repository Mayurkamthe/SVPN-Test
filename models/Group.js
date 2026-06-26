const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  name:         { type: String, required: true, unique: true, trim: true },
  description:  { type: String, default: null },
  academicYear: { type: String, default: process.env.ACADEMIC_YEAR || '2024-2025' },
  course:       { type: String, enum: ['JEE','CET','NEET', null], default: null },
  isActive:     { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.models.Group || mongoose.model('Group', groupSchema);
