/**
 * routes/auth.js
 * Customer authentication: register, login, profile.
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { queries } = require('../db/database');
const { sendPasswordResetEmail } = require('../utils/email');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

// ─── Middleware ───────────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  try {
    // Revocation check: a password reset bumps token_version and kills old tokens
    const currentVersion = await queries.getUserTokenVersion(payload.userId);
    if (currentVersion === null || (payload.tv || 0) !== currentVersion)
      return res.status(401).json({ error: 'Session expired — please log in again' });
    req.user = payload;
    next();
  } catch (err) {
    next(err);
  }
}

function signCustomerToken(user) {
  return jwt.sign(
    { userId: user.id, type: 'customer', tv: user.token_version || 0 },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email and password are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  if (await queries.getUserByEmail(email))
    return res.status(409).json({ error: 'An account with this email already exists' });

  const hash  = await bcrypt.hash(password, 12);
  const user  = await queries.createUser(name, email, hash);
  const token = signCustomerToken(user);

  res.status(201).json({ token, user: { id: user.id, name, email } });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email and password are required' });

  const user = await queries.getUserByEmail(email);
  if (!user) {
    queries.auditLog({ actor_type: 'customer', actor_email: email, action: 'login_failed', detail: 'unknown email', ip: req.ip });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    queries.auditLog({ actor_type: 'customer', actor_id: user.id, actor_email: email, action: 'login_failed', ip: req.ip });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = signCustomerToken(user);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const user = await queries.getUserById(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// POST /api/auth/google
router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'credential is required' });

  try {
    const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    const ticket  = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name } = payload;

    const user  = await queries.findOrCreateUserByGoogle(googleId, email, name);
    const token = signCustomerToken(user);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(401).json({ error: 'Invalid Google credential' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const user = await queries.getUserByEmail(email);
  // Always respond with success to prevent user enumeration
  if (!user) return res.json({ ok: true });

  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await queries.createPasswordResetToken(user.id, token, expiresAt);

  try {
    await sendPasswordResetEmail({ name: user.name, email: user.email, token });
  } catch (err) {
    console.error('Reset email failed (non-fatal):', err.message);
  }

  res.json({ ok: true });
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password)
    return res.status(400).json({ error: 'token and password are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const record = await queries.getPasswordResetToken(token);
  if (!record) return res.status(400).json({ error: 'Invalid or expired reset link' });

  const hash = await bcrypt.hash(password, 12);
  await queries.updateUserPassword(record.user_id, hash);
  await queries.deletePasswordResetToken(token);
  queries.auditLog({ actor_type: 'customer', actor_id: record.user_id, action: 'password_reset', ip: req.ip });

  res.json({ ok: true });
});

// DELETE /api/auth/me — GDPR: delete own account (anonymises PII)
router.delete('/me', requireAuth, async (req, res) => {
  await queries.deleteUser(req.user.userId);
  queries.auditLog({ actor_type: 'customer', actor_id: req.user.userId, action: 'account_deleted', ip: req.ip });
  res.json({ ok: true });
});

// GET /api/auth/me/export — GDPR: export own data
router.get('/me/export', requireAuth, async (req, res) => {
  const data = await queries.getUserDataExport(req.user.userId);
  queries.auditLog({ actor_type: 'customer', actor_id: req.user.userId, action: 'data_export', ip: req.ip });
  res.setHeader('Content-Disposition', 'attachment; filename="my-soki-data.json"');
  res.json(data);
});

// PATCH /api/auth/me/waiver — sign health waiver
router.patch('/me/waiver', requireAuth, async (req, res) => {
  await queries.signWaiver(req.user.userId);
  res.json({ ok: true });
});

module.exports = router;
module.exports.requireAuth = requireAuth;
