// config/database.js — MongoDB via Mongoose
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/svpn_test';

const connect = async () => {
  try {
    await mongoose.connect(MONGO_URI, {
      maxPoolSize: parseInt(process.env.DB_POOL_MAX) || 15,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 20000,
    });
    console.log('✅ MongoDB connected:', mongoose.connection.host, '/', mongoose.connection.name);
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  }
};

// Keep-alive on disconnect
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected — retrying...');
});

module.exports = { connect, mongoose };
