// controllers/authController.js
const { User } = require('../models');

exports.getAdminLogin = (req, res) =>
  res.render('auth/admin-login', { title: 'Admin Login — ' + (process.env.COLLEGE_SHORT_NAME || 'CET') + ' Portal' });

exports.postAdminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase().trim(), role: 'admin' });
    if (!user || !user.isActive) { req.flash('error', 'Invalid admin credentials.'); return res.redirect('/auth/admin'); }
    const valid = await user.verifyPassword(password);
    if (!valid) { req.flash('error', 'Incorrect password.'); return res.redirect('/auth/admin'); }
    req.session.user = { id: user._id.toString(), name: user.name, email: user.email, rollNo: user.rollNo, role: user.role, isFirstLogin: user.isFirstLogin, profilePhoto: user.profilePhoto };
    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });
    if (user.isFirstLogin) { req.flash('warning', 'Please change your default password.'); return res.redirect('/auth/change-password'); }
    req.flash('success', `Welcome, ${user.name}!`);
    return res.redirect('/admin/dashboard');
  } catch (err) { console.error('Admin login error:', err); req.flash('error', 'Login failed.'); return res.redirect('/auth/admin'); }
};

exports.getLogin = (req, res) =>
  res.render('auth/login', { title: 'Login — ' + (process.env.COLLEGE_SHORT_NAME || 'CET') + ' Portal' });

exports.postLogin = async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const user = await User.findOne({ rollNo: identifier.trim(), role: 'student' });
    if (!user || !user.isActive) { req.flash('error', 'Invalid credentials or account inactive.'); return res.redirect('/auth/login'); }
    const valid = await user.verifyPassword(password);
    if (!valid) { req.flash('error', 'Incorrect password.'); return res.redirect('/auth/login'); }
    req.session.user = { id: user._id.toString(), name: user.name, email: user.email, rollNo: user.rollNo, role: user.role, isFirstLogin: user.isFirstLogin, profilePhoto: user.profilePhoto };
    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });
    if (user.isFirstLogin) { req.flash('warning', 'Please change your default password.'); return res.redirect('/auth/change-password'); }
    req.flash('success', `Welcome back, ${user.name}!`);
    return res.redirect('/student/dashboard');
  } catch (err) { console.error('Login error:', err); req.flash('error', 'Login failed.'); return res.redirect('/auth/login'); }
};

exports.getChangePassword = (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  res.render('auth/change-password', { title: 'Change Password', user: req.session.user });
};

exports.postChangePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword) { req.flash('error', 'Passwords do not match.'); return res.redirect('/auth/change-password'); }
    if (newPassword.length < 6) { req.flash('error', 'Password must be at least 6 characters.'); return res.redirect('/auth/change-password'); }
    const user = await User.findById(req.session.user.id);
    if (!user) { req.flash('error', 'User not found.'); return res.redirect('/auth/login'); }
    if (!user.isFirstLogin) {
      const valid = await user.verifyPassword(currentPassword);
      if (!valid) { req.flash('error', 'Current password is incorrect.'); return res.redirect('/auth/change-password'); }
    }
    user.password = newPassword;
    user.isFirstLogin = false;
    await user.save();
    req.session.user.isFirstLogin = false;
    req.flash('success', 'Password changed successfully!');
    return res.redirect(`/${req.session.user.role}/dashboard`);
  } catch (err) { console.error(err); req.flash('error', 'Failed to change password.'); return res.redirect('/auth/change-password'); }
};

exports.logout = (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Session destroy error:', err);
    res.clearCookie('connect.sid');
    return res.redirect('/auth/login');
  });
};
