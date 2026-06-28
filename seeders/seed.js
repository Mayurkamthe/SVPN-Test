// seeders/seed.js — MongoDB/Mongoose seed for SVPN-Test
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { connect } = require('../config/database');
const { User, Group, GroupMember, Question, Test, Topic } = require('../models');

async function seed() {
  try {
    await connect();
    console.log('🔄 Clearing existing data...');

    // Clear all collections
    await Promise.all([
      User.deleteMany({}),
      Group.deleteMany({}),
      GroupMember.deleteMany({}),
      Question.deleteMany({}),
      Test.deleteMany({}),
      Topic.deleteMany({}),
    ]);
    console.log('✅ Collections cleared');

    // ── Admin ────────────────────────────────────────────────────────────────
    const admin = await User.create({
      name:         'System Administrator',
      email:        process.env.COLLEGE_EMAIL || 'admin@xyzcollege.edu.in',
      password:     process.env.ADMIN_DEFAULT_PASSWORD || 'Admin@XYZ2024',
      role:         'admin',
      isFirstLogin: false,
    });
    console.log('✅ Admin created:', admin.email);

    // ── Groups ───────────────────────────────────────────────────────────────
    const groupA = await Group.create({ name: 'PCM Batch-A 2024', description: 'Physics Chemistry Mathematics', academicYear: process.env.ACADEMIC_YEAR || '2024-2025' });
    const groupB = await Group.create({ name: 'PCB Batch-B 2024', description: 'Physics Chemistry Biology',     academicYear: process.env.ACADEMIC_YEAR || '2024-2025' });
    console.log('✅ Groups created');

    // ── Students ─────────────────────────────────────────────────────────────
    const studentRows = [
      { name: 'Arjun Mehta',  rollNo: '2024CE001', group: groupA._id },
      { name: 'Priya Patel',  rollNo: '2024CE002', group: groupA._id },
      { name: 'Rohan Singh',  rollNo: '2024CE003', group: groupB._id },
      { name: 'Ananya Gupta', rollNo: '2024CE004', group: groupA._id },
      { name: 'Kiran Kumar',  rollNo: '2024CE005', group: groupB._id },
    ];
    for (const s of studentRows) {
      const prefix = process.env.PASSWORD_PREFIX || 'CET@';
      const pw     = `${prefix}${s.rollNo.slice(-4)}`;
      const student = await User.create({ name: s.name, rollNo: s.rollNo, role: 'student', password: pw, isFirstLogin: true });
      await GroupMember.create({ groupId: s.group, userId: student._id, role: 'student' });
    }
    console.log('✅ Students created');

    // ── Topics ───────────────────────────────────────────────────────────────
    await Topic.insertMany([
      { name: 'Kinematics',        course: 'CET', subject: 'Physics' },
      { name: 'Laws of Motion',    course: 'CET', subject: 'Physics' },
      { name: 'Organic Chemistry', course: 'CET', subject: 'Chemistry' },
      { name: 'Periodic Table',    course: 'CET', subject: 'Chemistry' },
      { name: 'Calculus',          course: 'CET', subject: 'Mathematics' },
      { name: 'Algebra',           course: 'CET', subject: 'Mathematics' },
    ]);
    console.log('✅ Topics created');

    // ── Questions ─────────────────────────────────────────────────────────────
    const qRows = [
      { question: 'What is the SI unit of force?',       optionA:'Joule',     optionB:'Newton',       optionC:'Watt',          optionD:'Pascal',    correctAnswer:'B', subject:'Physics',     difficulty:'Easy',   topic:'Laws of Motion',   marks:1 },
      { question: "Newton's third law is about?",        optionA:'Inertia',   optionB:'Acceleration', optionC:'Action-Reaction',optionD:'Gravity',   correctAnswer:'C', subject:'Physics',     difficulty:'Easy',   topic:'Laws of Motion',   marks:1 },
      { question: 'Speed of light in vacuum?',           optionA:'3×10⁸ m/s', optionB:'3×10⁶ m/s',   optionC:'3×10⁷ m/s',     optionD:'3×10⁹ m/s', correctAnswer:'A', subject:'Physics',     difficulty:'Medium', topic:'Kinematics',        marks:1 },
      { question: 'Atomic number of Carbon?',            optionA:'6',         optionB:'12',           optionC:'8',             optionD:'4',         correctAnswer:'A', subject:'Chemistry',   difficulty:'Easy',   topic:'Periodic Table',   marks:1 },
      { question: 'Chemical formula of water?',          optionA:'H2O2',      optionB:'HO',           optionC:'H2O',           optionD:'H3O',       correctAnswer:'C', subject:'Chemistry',   difficulty:'Easy',   topic:'Periodic Table',   marks:1 },
      { question: 'pH of pure water?',                   optionA:'0',         optionB:'7',            optionC:'14',            optionD:'1',         correctAnswer:'B', subject:'Chemistry',   difficulty:'Easy',   topic:'Organic Chemistry', marks:1 },
      { question: 'Derivative of sin(x) is?',            optionA:'-cos(x)',   optionB:'cos(x)',       optionC:'tan(x)',        optionD:'-sin(x)',   correctAnswer:'B', subject:'Mathematics', difficulty:'Easy',   topic:'Calculus',          marks:1 },
      { question: 'Integral of x dx is?',                optionA:'x^2',       optionB:'x + C',        optionC:'x^2/2+C',      optionD:'2x',        correctAnswer:'C', subject:'Mathematics', difficulty:'Medium', topic:'Calculus',          marks:1 },
      { question: 'Sum of angles in a triangle?',        optionA:'90',        optionB:'360',          optionC:'180',          optionD:'270',       correctAnswer:'C', subject:'Mathematics', difficulty:'Easy',   topic:'Algebra',           marks:1 },
      { question: "Ohm's law: V equals?",                optionA:'I/R',       optionB:'IR',           optionC:'I+R',          optionD:'I^2 R',     correctAnswer:'B', subject:'Physics',     difficulty:'Easy',   topic:'Laws of Motion',   marks:1 },
    ];
    const questions = await Question.insertMany(qRows.map(q => ({ ...q, createdBy: admin._id })));
    console.log('✅ Questions created');

    // ── Test ─────────────────────────────────────────────────────────────────
    await Test.create({
      title:            'CET Mock Test 1 — PCM',
      description:      'Mock test covering Physics, Chemistry and Mathematics',
      duration:         30,
      totalMarks:       10,
      negativeMarking:  0.25,
      shuffleQuestions: true,
      status:           'published',
      instructions:     'Each correct answer = 1 mark. Wrong answer = -0.25 marks.',
      createdBy:        admin._id,
      course:           'CET',
      questions:        questions.map(q => q._id),
      groups:           [groupA._id],
    });
    console.log('✅ Test created');

    console.log('\n🎉 Seed complete!\n');
    console.log('──────────────────────────────────────────────');
    console.log('  Admin:   admin@xyzcollege.edu.in / Admin@XYZ2024');
    console.log('  Student: Roll No: 2024CE001      / CET@0001');
    console.log('  Student: Roll No: 2024CE002      / CET@0002');
    console.log('──────────────────────────────────────────────\n');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed error:', err.message);
    console.error(err);
    process.exit(1);
  }
}

seed();
