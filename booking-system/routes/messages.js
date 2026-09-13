/**
 * routes/messages.js
 * Customer ↔ admin messaging.
 */

const express = require('express');
const { queries } = require('../db/database');
const { requireAuth } = require('./auth');
const { sendMessageReceivedEmail, sendContactFormEmail } = require('../utils/email');

const router = express.Router();

// POST /api/messages — customer sends a message
router.post('/', requireAuth, async (req, res) => {
  const { subject, body } = req.body;
  if (!subject || !body)
    return res.status(400).json({ error: 'subject and body are required' });
  if (subject.length > 200)
    return res.status(400).json({ error: 'subject too long' });
  if (body.length > 5000)
    return res.status(400).json({ error: 'body too long' });

  const msg = await queries.createMessage(req.user.userId, subject.trim(), body.trim());

  try {
    const user = await queries.getUserById(req.user.userId);
    if (user) {
      await sendMessageReceivedEmail({
        customer_name:  user.name,
        customer_email: user.email,
        subject:        subject.trim(),
        body:           body.trim(),
      });
    }
  } catch (e) {
    console.error('Message-received email failed (non-fatal):', e.message);
  }

  res.status(201).json(msg);
});

// POST /api/messages/feedback — publiek feedbackformulier (geen login vereist)
router.post('/feedback', async (req, res) => {
  const { rating, name, email, message, website } = req.body;
  if (website) return res.status(201).json({ ok: true }); // honeypot: stil negeren

  const stars = parseInt(rating, 10);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5)
    return res.status(400).json({ error: 'Kies een aantal sterren.' });
  if (!message || !String(message).trim())
    return res.status(400).json({ error: 'Schrijf kort wat we kunnen verbeteren.' });
  if (String(message).length > 5000 || String(name || '').length > 200 || String(email || '').length > 200)
    return res.status(400).json({ error: 'Bericht te lang.' });

  const guestName  = String(name || '').trim() || null;
  const guestEmail = String(email || '').trim().toLowerCase() || null;

  let userId = null;
  if (guestEmail) {
    const user = await queries.getUserByEmail(guestEmail);
    if (user) userId = user.id;
  }

  const subject = `Feedback: ${'★'.repeat(stars)}${'☆'.repeat(5 - stars)} (${stars}/5)`;
  const msg = await queries.createFeedbackMessage({
    userId, guestName, guestEmail, rating: stars,
    subject, body: String(message).trim(),
  });
  res.status(201).json({ ok: true, id: msg.id });
});

// POST /api/messages/contact — publiek contact-/samenwerkingsformulier (About-pagina)
router.post('/contact', async (req, res) => {
  const { name, email, message, website } = req.body;
  if (website) return res.status(201).json({ ok: true }); // honeypot: stil negeren

  const guestName  = String(name || '').trim();
  const guestEmail = String(email || '').trim().toLowerCase();
  const body       = String(message || '').trim();
  if (!guestName) return res.status(400).json({ error: 'Vul je naam in.' });
  if (!guestEmail || !guestEmail.includes('@')) return res.status(400).json({ error: 'Vul een geldig e-mailadres in.' });
  if (!body) return res.status(400).json({ error: 'Schrijf een bericht.' });
  if (body.length > 5000 || guestName.length > 200 || guestEmail.length > 200)
    return res.status(400).json({ error: 'Bericht te lang.' });

  let userId = null;
  const user = await queries.getUserByEmail(guestEmail);
  if (user) userId = user.id;

  const msg = await queries.createFeedbackMessage({
    userId, guestName, guestEmail, rating: null,
    subject: `Contactformulier: ${guestName}`,
    body,
  });

  try {
    await sendContactFormEmail({ name: guestName, email: guestEmail, message: body });
  } catch (e) {
    console.error('Contact notification email failed (non-fatal):', e.message);
  }

  res.status(201).json({ ok: true, id: msg.id });
});

// GET /api/messages — customer gets their own messages + replies
router.get('/', requireAuth, async (req, res) => {
  const msgs = await queries.getMessagesByUser(req.user.userId);
  res.json(msgs);
});

module.exports = router;
