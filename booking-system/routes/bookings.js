/**
 * routes/bookings.js
 * Create and list customer bookings.
 */

const express = require('express');
const { queries, getPool } = require('../db/database');
const { requireAuth } = require('./auth');

const router = express.Router();

// POST /api/bookings — create a pending booking
router.post('/', requireAuth, async (req, res) => {
  const { slot_id, group_size } = req.body;
  if (!slot_id || !group_size)
    return res.status(400).json({ error: 'slot_id and group_size are required' });
  if (group_size < 1 || group_size > 20)
    return res.status(400).json({ error: 'group_size must be between 1 and 20' });

  const slot = await queries.getSlotById(slot_id);
  if (!slot)             return res.status(404).json({ error: 'Slot not found' });
  if (slot.is_cancelled) return res.status(400).json({ error: 'This slot has been cancelled' });

  const capacity  = slot.max_capacity || slot.type_capacity;
  const spotsLeft = capacity - slot.booked;
  if (group_size > spotsLeft)
    return res.status(409).json({ error: `Only ${spotsLeft} spot(s) remaining`, spots_left: spotsLeft });

  const totalCents = slot.price_cents * group_size;
  let booking;
  try {
    booking = await queries.createBooking(req.user.userId, slot_id, group_size, totalCents);
  } catch (err) {
    if (err.code === 'NO_CAPACITY')
      return res.status(409).json({ error: err.message, spots_left: err.spots_left });
    throw err;
  }

  res.status(201).json({
    booking_id:  booking.id,
    total_cents: totalCents,
    slot,
    group_size,
  });
});

// GET /api/bookings — list bookings for logged-in user
router.get('/', requireAuth, async (req, res) => {
  const bookings = await queries.getBookingsByUser(req.user.userId);
  res.json(bookings);
});

// GET /api/bookings/:id — single booking detail
router.get('/:id', requireAuth, async (req, res) => {
  const booking = await queries.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.user_id !== req.user.userId)
    return res.status(403).json({ error: 'Access denied' });
  res.json(booking);
});

// PATCH /api/bookings/:id/cancel — user cancels their own booking
router.patch('/:id/cancel', requireAuth, async (req, res) => {
  const booking = await queries.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.user_id !== req.user.userId)
    return res.status(403).json({ error: 'Access denied' });
  if (booking.status === 'cancelled')
    return res.status(400).json({ error: 'Booking is already cancelled' });

  // Enforce 24-hour cancellation cutoff
  const sessionDatetime = new Date(booking.date + 'T' + booking.start_time + ':00');
  const hoursUntil = (sessionDatetime - Date.now()) / 36e5;
  if (hoursUntil < 24)
    return res.status(400).json({ error: 'Cancellations must be made at least 24 hours in advance', hours_until: Math.round(hoursUntil) });

  // Refund via Stripe if payment was confirmed
  if (booking.stripe_payment_intent_id && booking.stripe_payment_status === 'succeeded') {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      await stripe.refunds.create({ payment_intent: booking.stripe_payment_intent_id });
    } catch (stripeErr) {
      console.error('Stripe refund failed:', stripeErr.message);
      return res.status(502).json({ error: 'Refund failed — please contact us to cancel' });
    }
  }

  await queries.cancelBooking(req.params.id);
  res.json({ ok: true, refunded: booking.stripe_payment_status === 'succeeded' });
});

// POST /api/bookings/:id/confirm-member — confirm booking using subscription credits
router.post('/:id/confirm-member', requireAuth, async (req, res) => {
  const bookingId = parseInt(req.params.id);
  const { credits_to_use } = req.body;

  const booking = await queries.getBookingById(bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.user_id !== req.user.userId) return res.status(403).json({ error: 'Access denied' });
  if (booking.status !== 'pending') return res.status(400).json({ error: 'Booking already processed' });

  // Verify subscription
  const sub = await queries.getActiveSubscription(req.user.userId);
  if (!sub) return res.status(403).json({ error: 'No active subscription' });

  // Deduct credits + confirm booking in a single transaction
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (sub.credits_per_month !== null && credits_to_use > 0) {
      const { rows } = await client.query(
        'UPDATE subscriptions SET credits_remaining = credits_remaining - $1 WHERE user_id = $2 AND status IN (\'active\', \'past_due\') AND credits_remaining >= $1 RETURNING *',
        [credits_to_use, req.user.userId]
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient credits' });
      }
    }
    await client.query(
      "UPDATE bookings SET status = 'confirmed', credits_used = $2 WHERE id = $1",
      [bookingId, credits_to_use]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Send confirmation email (non-fatal, guarded by confirmation_sent flag)
  if (!booking.confirmation_sent) {
    try {
      const { sendBookingConfirmation } = require('../utils/email');
      await sendBookingConfirmation({ ...booking });
    } catch (e) { console.error('Email failed:', e.message); }
  }

  res.json({ ok: true, booking_id: bookingId });
});

module.exports = router;
