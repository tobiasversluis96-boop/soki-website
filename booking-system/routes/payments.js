/**
 * routes/payments.js
 * Stripe payment intent creation and confirmation.
 */

const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { queries } = require('../db/database');
const { requireAuth } = require('./auth');
const { sendBookingConfirmation } = require('../utils/email');

const router = express.Router();

// POST /api/payments/create-intent
router.post('/create-intent', requireAuth, async (req, res) => {
  const { booking_id } = req.body;
  if (!booking_id) return res.status(400).json({ error: 'booking_id is required' });

  const booking = await queries.getBookingById(booking_id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.user_id !== req.user.userId)
    return res.status(403).json({ error: 'Access denied' });
  if (booking.status !== 'pending')
    return res.status(400).json({ error: 'Booking is not in pending state' });

  try {
    const intent = await stripe.paymentIntents.create({
      amount:   booking.total_cents,
      currency: 'eur',
      payment_method_types: ['card', 'ideal', 'sepa_debit', 'bancontact'],
      metadata: {
        booking_id:    String(booking.id),
        customer_name: booking.customer_name,
        session_name:  booking.session_name,
        date:          booking.date,
      },
      description: `Soki – ${booking.session_name} op ${booking.date}`,
    });

    await queries.updateBookingPayment(booking.id, intent.id, intent.status);

    res.json({
      client_secret:     intent.client_secret,
      payment_intent_id: intent.id,
      amount:            intent.amount,
      publishable_key:   process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(502).json({ error: 'Payment service unavailable' });
  }
});

// POST /api/payments/confirm
router.post('/confirm', requireAuth, async (req, res) => {
  const { payment_intent_id } = req.body;
  if (!payment_intent_id) return res.status(400).json({ error: 'payment_intent_id is required' });

  try {
    const intent  = await stripe.paymentIntents.retrieve(payment_intent_id);
    const booking = await queries.getBookingByPaymentIntent(payment_intent_id);

    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.user_id !== req.user.userId)
      return res.status(403).json({ error: 'Access denied' });

    await queries.updateBookingPayment(booking.id, intent.id, intent.status);

    if (intent.status === 'succeeded' && !booking.confirmation_sent) {
      try {
        await sendBookingConfirmation({ ...booking, group_size: booking.group_size });
      } catch (emailErr) {
        console.error('Email failed (non-fatal):', emailErr.message);
      }
    }

    res.json({
      status:     intent.status,
      booking_id: booking.id,
      confirmed:  intent.status === 'succeeded',
    });
  } catch (err) {
    console.error('Stripe confirm error:', err.message);
    res.status(502).json({ error: 'Payment service unavailable' });
  }
});

module.exports = router;
