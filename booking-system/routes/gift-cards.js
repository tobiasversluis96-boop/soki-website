/**
 * routes/gift-cards.js
 * Purchase, activate and check gift cards.
 */

const express = require('express');
const crypto  = require('crypto');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { queries } = require('../db/database');
const { requireAuth } = require('./auth');
const { sendGiftCardEmail } = require('../utils/email');

const router = express.Router();

function generateCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `SOKI-${seg()}-${seg()}`;
}

// GET /api/gift-cards/check/:code  — public balance check
router.get('/check/:code', async (req, res) => {
  const card = await queries.getGiftCardByCode(req.params.code);
  if (!card) return res.status(404).json({ error: 'Cadeaubon niet gevonden.' });
  if (card.status === 'pending')  return res.status(400).json({ error: 'Deze cadeaubon is nog niet geactiveerd.' });
  if (card.status === 'depleted') return res.status(400).json({ error: 'Deze cadeaubon is volledig gebruikt.' });
  if (card.status === 'expired' || new Date(card.expires_at) < new Date())
    return res.status(400).json({ error: 'Deze cadeaubon is verlopen.' });
  res.json({
    valid: true,
    remaining_cents: card.remaining_amount_cents,
    initial_cents:   card.initial_amount_cents,
    expires_at:      card.expires_at,
  });
});

// POST /api/gift-cards/purchase  — create PaymentIntent for gift card
router.post('/purchase', async (req, res) => {
  const { amount_cents, purchaser_name, purchaser_email, recipient_name, recipient_email, message } = req.body;

  if (!amount_cents || amount_cents < 500)
    return res.status(400).json({ error: 'Minimumbedrag is €5.' });
  if (amount_cents > 50000)
    return res.status(400).json({ error: 'Maximumbedrag is €500.' });
  if (!purchaser_name || !purchaser_email || !recipient_name || !recipient_email)
    return res.status(400).json({ error: 'Alle velden zijn verplicht.' });

  // Generate a unique code
  let code, attempts = 0;
  do {
    code = generateCode();
    const existing = await queries.getGiftCardByCode(code);
    if (!existing) break;
  } while (++attempts < 10);

  const card = await queries.createGiftCard({
    code, initial_amount_cents: amount_cents,
    purchaser_name, purchaser_email,
    recipient_name, recipient_email, message,
    status: 'pending',
  });

  const intent = await stripe.paymentIntents.create({
    amount:   amount_cents,
    currency: 'eur',
    payment_method_types: ['card', 'ideal', 'sepa_debit', 'bancontact'],
    metadata: { gift_card_id: String(card.id), gift_card_code: code },
    description: `Soki cadeaubon voor ${recipient_name}`,
  });

  res.json({
    client_secret:    intent.client_secret,
    publishable_key:  process.env.STRIPE_PUBLISHABLE_KEY,
    gift_card_id:     card.id,
    payment_intent_id: intent.id,
  });
});

// POST /api/gift-cards/confirm  — called after Stripe payment succeeds on frontend
router.post('/confirm', async (req, res) => {
  const { payment_intent_id } = req.body;
  if (!payment_intent_id) return res.status(400).json({ error: 'payment_intent_id required' });

  const intent = await stripe.paymentIntents.retrieve(payment_intent_id);
  if (intent.status !== 'succeeded')
    return res.status(400).json({ error: 'Betaling niet geslaagd.' });

  const cardId = parseInt(intent.metadata.gift_card_id);
  const card   = await queries.getGiftCardById(cardId);
  if (!card) return res.status(404).json({ error: 'Cadeaubon niet gevonden.' });
  if (card.status === 'active') return res.json({ ok: true, code: card.code }); // idempotent

  const activated = await queries.activateGiftCard(cardId, payment_intent_id);

  try {
    await sendGiftCardEmail(activated);
  } catch (e) {
    console.error('Gift card email error:', e.message);
  }

  res.json({ ok: true, code: activated.code });
});

module.exports = router;
