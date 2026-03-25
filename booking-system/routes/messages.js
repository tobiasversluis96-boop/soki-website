/**
 * routes/messages.js
 * Customer ↔ admin messaging.
 */

const express = require('express');
const { queries } = require('../db/database');
const { requireAuth } = require('./auth');

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
  res.status(201).json(msg);
});

// GET /api/messages — customer gets their own messages + replies
router.get('/', requireAuth, async (req, res) => {
  const msgs = await queries.getMessagesByUser(req.user.userId);
  res.json(msgs);
});

module.exports = router;
