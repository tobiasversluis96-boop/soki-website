/**
 * routes/buddies.js
 * Buddy's: members koppelen elkaar (wederzijdse acceptatie) en zien daarna
 * elkaars aankomende sessies in de boekingskalender.
 */

const express = require('express');
const { queries } = require('../db/database');
const { requireAuth } = require('./auth');

const router = express.Router();

// GET /api/buddies/search?q=naam
router.get('/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const results = await queries.searchBuddyUsers(req.user.userId, q);
  res.json(results.map(r => ({ id: r.id, name: r.name, buddy_status: r.buddy_status })));
});

// GET /api/buddies — eigen buddy's + openstaande verzoeken
router.get('/', requireAuth, async (req, res) => {
  const rows = await queries.getBuddyRelations(req.user.userId);
  const me = await queries.getUserById(req.user.userId);
  res.json({
    buddies:  rows.filter(r => r.status === 'accepted')
                  .map(r => ({ id: r.id, user_id: r.other_id, name: r.other_name })),
    incoming: rows.filter(r => r.status === 'pending' && r.addressee_id === req.user.userId)
                  .map(r => ({ id: r.id, user_id: r.other_id, name: r.other_name })),
    outgoing: rows.filter(r => r.status === 'pending' && r.requester_id === req.user.userId)
                  .map(r => ({ id: r.id, user_id: r.other_id, name: r.other_name })),
    hidden: !!(me && me.buddy_hidden),
  });
});

// POST /api/buddies/request { user_id }
router.post('/request', requireAuth, async (req, res) => {
  const targetId = parseInt(req.body.user_id);
  if (!targetId || targetId === req.user.userId)
    return res.status(400).json({ error: 'Ongeldige gebruiker' });

  const target = await queries.getUserById(targetId);
  // Verborgen users niet bevestigen als bestaand
  if (!target || target.buddy_hidden)
    return res.status(404).json({ error: 'Gebruiker niet gevonden' });

  const existing = await queries.getBuddyBetween(req.user.userId, targetId);
  if (existing) {
    if (existing.status === 'accepted')
      return res.status(409).json({ error: 'Jullie zijn al buddy\'s' });
    // Omgekeerd verzoek staat al open → meteen accepteren
    if (existing.addressee_id === req.user.userId) {
      const accepted = await queries.acceptBuddy(existing.id, req.user.userId);
      return res.json({ ok: true, accepted: !!accepted });
    }
    return res.status(409).json({ error: 'Verzoek staat al open' });
  }

  await queries.createBuddyRequest(req.user.userId, targetId);
  res.json({ ok: true, accepted: false });
});

// POST /api/buddies/:id/accept
router.post('/:id/accept', requireAuth, async (req, res) => {
  const row = await queries.acceptBuddy(parseInt(req.params.id), req.user.userId);
  if (!row) return res.status(404).json({ error: 'Verzoek niet gevonden' });
  res.json({ ok: true });
});

// DELETE /api/buddies/:id — weigeren, intrekken of ontkoppelen
router.delete('/:id', requireAuth, async (req, res) => {
  const ok = await queries.deleteBuddy(parseInt(req.params.id), req.user.userId);
  if (!ok) return res.status(404).json({ error: 'Niet gevonden' });
  res.json({ ok: true });
});

// GET /api/buddies/sessions — { slot_id: [namen] } voor aankomende sessies
router.get('/sessions', requireAuth, async (req, res) => {
  const rows = await queries.getBuddyUpcomingSessions(req.user.userId);
  const map = {};
  for (const r of rows) {
    if (!map[r.slot_id]) map[r.slot_id] = [];
    if (!map[r.slot_id].includes(r.name)) map[r.slot_id].push(r.name);
  }
  res.json(map);
});

// PATCH /api/buddies/visibility { hidden }
router.patch('/visibility', requireAuth, async (req, res) => {
  await queries.setBuddyHidden(req.user.userId, !!req.body.hidden);
  res.json({ ok: true });
});

module.exports = router;
