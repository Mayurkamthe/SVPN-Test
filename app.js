// app.js — CET Examination System (MongoDB / Mongoose)
require('dotenv').config();
const express        = require('express');
const session        = require('express-session');
const flash          = require('connect-flash');
const fileUpload     = require('express-fileupload');
const methodOverride = require('method-override');
const path           = require('path');
const compression    = require('compression');
const helmet         = require('helmet');
const MongoStore     = require('connect-mongo');

const { connect } = require('./config/database');
require('./models'); // register all schemas

const { attachUser, errorHandler, notFound } = require('./middleware/auth');

const app = express();
app.set('trust proxy', 1);

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ── Compression ───────────────────────────────────────────────────────────────
app.use(compression({ level: 6, threshold: 1024 }));

// ── View engine ───────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d', etag: true, lastModified: true,
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html') || fp.endsWith('.json'))
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    else if (/\.(js|css|png|jpg|jpeg|svg|ico|woff2?)$/.test(fp))
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  },
}));

// ── Body / file parsers ───────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(methodOverride('_method'));
app.use(fileUpload({
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 20 * 1024 * 1024 },
  useTempFiles: false,
  abortOnLimit: true,
}));

// ── Sessions (stored in MongoDB) ──────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/svpn_test';

app.use(session({
  secret: process.env.SESSION_SECRET || 'svpn_secret_key',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: MONGO_URI,
    ttl: 24 * 60 * 60,        // 1 day
    autoRemove: 'native',
  }),
  cookie: {
    maxAge: parseInt(process.env.SESSION_MAX_AGE) || 86400000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
}));

app.use(flash());
app.use(attachUser);

// ── No-cache for HTML pages ───────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/uploads'))
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth',    require('./routes/auth'));
app.use('/admin',   require('./routes/admin'));
app.use('/student', require('./routes/student'));
app.use('/exam',    require('./routes/exam'));
app.use('/results', require('./routes/results'));

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect(`/${req.session.user.role}/dashboard`);
  res.redirect('/auth/login');
});

// ── Boot ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
let booted = false;

async function boot() {
  if (booted) return;
  booted = true;
  await connect();

  // Auto-seed admin
  try {
    const { User } = require('./models');
    const exists = await User.findOne({ role: 'admin' });
    if (!exists) {
      const adminEmail    = process.env.ADMIN_EMAIL    || 'admin@college.edu';
      const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@1234';
      const adminName     = process.env.ADMIN_NAME     || 'Administrator';
      await User.create({ name: adminName, email: adminEmail, password: adminPassword, role: 'admin', isActive: true, isFirstLogin: false });
      console.log(`✅ Admin seeded → ${adminEmail}`);
    }
  } catch (e) { console.error('Admin seed error:', e.message); }
}

app.use(async (req, res, next) => {
  try { await boot(); next(); }
  catch (e) { res.status(500).send('Server init failed: ' + e.message); }
});

app.use(notFound);
app.use(errorHandler);

module.exports = app;

if (require.main === module) {
  boot().then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 ${process.env.APP_NAME || 'CET Exam Portal'} — http://localhost:${PORT} [${process.env.NODE_ENV || 'development'}]`);
    });
  }).catch(e => { console.error(e); process.exit(1); });
}
