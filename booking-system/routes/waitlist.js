/**
 * routes/waitlist.js
 * Customer waitlist endpoints — with upfront payment.
 */
const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { queries } = require('../db/database');
const { requireAuth } = require('./auth');

const router = express.Router();

// GET /api/waitlist — user's current waitlist entries
router.get('/', requireAuth, async (req, res) => {
  const entries = await queries.getUserWaitlist(req.user.userId);
  res.json(entries);
});

// GET /api/waitlist/:slotId — position for this user on this slot
router.get('/:slotId', requireAuth, async (req, res) => {
  const pos = await queries.getWaitlistPosition(req.user.userId, parseInt(req.params.slotId));
  res.json(pos);
});

// POST /api/waitlist/:slotId — join waitlist and create a PaymentIntent
router.post('/:slotId', requireAuth, async (req, res) => {
  const slotId    = parseInt(req.params.slotId);
  const groupSize = parseInt(req.body.group_size) || 1;

  if (groupSize < 1 || groupSize > 8)
    return res.status(400).json({ error: 'group_size must be between 1 and 8' });

  const slot = await queries.getSlotById(slotId);
  if (!slot)             return res.status(404).json({ error: 'Slot not found' });
  if (slot.is_cancelled) return res.status(400).json({ error: 'Slot is cancelled' });
  if (slot.is_private)   return res.status(400).json({ error: 'Voor privéverhuur is geen wachtlijst beschikbaar.' });

  const capacity  = slot.max_capacity || slot.type_capacity;
  const spotsLeft = capacity - slot.booked;
  if (spotsLeft > 0) return res.status(400).json({ error: 'Slot still has availability — book directly' });

  // Check if already on waitlist
  const existing = await queries.getWaitlistEntry(req.user.userId, slotId);
  if (existing)
    return res.status(409).json({ error: 'Already on waitlist' });

  const totalCents = slot.price_cents * groupSize;

  // Gratis sessies: geen betaling nodig — meteen definitief op de wachtlijst
  // (status 'paid' zodat de auto-boek-flow ze gewoon meeneemt zodra er plek is)
  if (totalCents === 0) {
    const entry = await queries.joinWaitlist(req.user.userId, slotId, groupSize, 0, null);
    if (entry) await queries.markWaitlistPaidById(entry.id);
    const pos = await queries.getWaitlistPosition(req.user.userId, slotId);
    return res.status(201).json({ free: true, position: pos.position, total: pos.total, total_cents: 0 });
  }

  // Create Stripe PaymentIntent (charged immediately, refunded if never claimed)
  const user = await queries.getUserById(req.user.userId);
  const intent = await stripe.paymentIntents.create({
    amount:   totalCents,
    currency: 'eur',
    metadata: {
      type:         'waitlist',
      slot_id:      String(slotId),
      user_id:      String(req.user.userId),
      group_size:   String(groupSize),
      session_name: slot.session_name,
    },
    description: `Wachtlijst: ${slot.session_name} – ${slot.date} ${slot.start_time}`,
    receipt_email: user?.email,
  });

  // Insert waitlist row (unpaid until webhook confirms)
  await queries.joinWaitlist(req.user.userId, slotId, groupSize, totalCents, intent.id);

  const pos = await queries.getWaitlistPosition(req.user.userId, slotId);
  res.status(201).json({
    client_secret:   intent.client_secret,
    publishable_key: process.env.STRIPE_PUBLISHABLE_KEY,
    position:        pos.position,
    total:           pos.total,
    total_cents:     totalCents,
  });
});

// DELETE /api/waitlist/:slotId — leave waitlist; refund if already paid
router.delete('/:slotId', requireAuth, async (req, res) => {
  const slotId = parseInt(req.params.slotId);
  // Eerst lezen en pas verwijderen NA een geslaagde refund: delete-first
  // betekende bij een mislukte refund dat de betaalde entry verdween (of als
  // 'pending' met verse datum herboren werd) terwijl het geld binnen bleef.
  const entry = await queries.getWaitlistEntry(req.user.userId, slotId);

  if (!entry) return res.json({ ok: true, refunded: false });

  // If the spot was already claimed into a booking, don't refund here (handled separately)
  if (entry.claimed_booking_id) {
    return res.status(400).json({ error: 'Your waitlist spot has already been converted to a booking. Cancel the booking instead.' });
  }

  let refunded = false;
  if (entry.stripe_payment_intent_id && entry.stripe_payment_status === 'paid') {
    try {
      await stripe.refunds.create({ payment_intent: entry.stripe_payment_intent_id });
      refunded = true;
    } catch (err) {
      if (err.code === 'charge_already_refunded') {
        refunded = true;
      } else {
        console.error('Waitlist refund failed:', err.message);
        return res.status(502).json({ error: 'Refund failed — please contact us' });
      }
    }
  } else if (entry.stripe_payment_intent_id && entry.stripe_payment_status === 'pending') {
    // Payment not completed yet — cancel the intent
    try {
      await stripe.paymentIntents.cancel(entry.stripe_payment_intent_id);
    } catch (err) {
      // Annuleren kan mislukken doordat de betaling tóch al (bijna) binnen is
      // (webhook nog onderweg): dan terugbetalen of de klant laten wachten —
      // nooit stilletjes het geld houden.
      try {
        const intent = await stripe.paymentIntents.retrieve(entry.stripe_payment_intent_id);
        if (intent.status === 'succeeded') {
          await stripe.refunds.create({ payment_intent: intent.id });
          refunded = true;
        } else if (intent.status === 'processing') {
          return res.status(409).json({ error: 'Je betaling wordt nog verwerkt — probeer het over een paar minuten opnieuw. / Your payment is still processing — please try again in a few minutes.' });
        }
      } catch (e2) {
        console.error('PaymentIntent cancel error:', err.message, '/ follow-up:', e2.message);
      }
    }
  }

  await queries.leaveWaitlist(req.user.userId, slotId);
  res.json({ ok: true, refunded });
});

module.exports = router;
