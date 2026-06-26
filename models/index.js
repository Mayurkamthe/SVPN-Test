// models/index.js — Mongoose models (MongoDB)
const User            = require('./User');
const Group           = require('./Group');
const GroupMember     = require('./GroupMember');
const Question        = require('./Question');
const Test            = require('./Test');
const Result          = require('./Result');
const Notification    = require('./Notification');
const Topic           = require('./Topic');
const StudentDocument = require('./StudentDocument');

module.exports = {
  User, Group, GroupMember, Question, Test,
  Result, Notification, Topic, StudentDocument,
};
