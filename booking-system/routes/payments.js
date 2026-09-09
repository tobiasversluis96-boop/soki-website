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

  // Hybride combi-boeking: sessie met credits, alleen het dinerdeel afrekenen.
  // Credits worden pas afgeschreven zodra de betaling slaagt (settleMemberCombi).
  let amount = booking.total_cents;
  const extraMetadata = {};
  if (req.body.use_credits === true) {
    if (!(booking.kantine_addon_cents > 0))
      return res.status(400).json({ error: 'Credits betalen kan hier alleen in combinatie met de combi-deal.' });
    const { CREDIT_COST } = require('./subscriptions');
    const slot = await queries.getSlotById(booking.time_slot_id);
    if (!slot || slot.is_private)
      return res.status(400).json({ error: 'Deze sessie kan niet met credits worden geboekt.' });
    const sub    = await queries.getActiveSubscription(req.user.userId);
    const passes = await queries.getActivePunchPasses(req.user.userId);
    const perPerson = (sub && sub.credits_per_month === null) ? 0 : (CREDIT_COST[slot.session_type_id] || 1.5);
    const creditsToUse = perPerson * (booking.group_size || 1);
    const covered = creditsToUse === 0
      || (sub && (Number(sub.credits_remaining) || 0) >= creditsToUse)
      || passes.some(p => Number(p.credits_remaining) >= creditsToUse);
    if (!covered)
      return res.status(400).json({ error: 'Onvoldoende credits voor deze sessie.' });
    amount = booking.kantine_addon_cents;
    extraMetadata.type = 'member_combi';
    extraMetadata.user_id = String(req.user.userId);
    extraMetadata.credits_to_use = String(creditsToUse);
  }

  try {
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'eur',
      payment_method_types: ['card', 'ideal', 'sepa_debit', 'bancontact'],
      metadata: {
        booking_id:    String(booking.id),
        customer_name: booking.customer_name,
        session_name:  booking.session_name,
        date:          booking.date,
        ...extraMetadata,
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

// Hybride combi-betaling afronden: credits afschrijven + boeking bevestigen.
// Idempotent — wordt door zowel /confirm als de webhook aangeroepen.
async function settleMemberCombi(intent) {
  const bookingId    = parseInt(intent.metadata.booking_id);
  const userId       = parseInt(intent.metadata.user_id);
  const creditsToUse = parseFloat(intent.metadata.credits_to_use) || 0;

  const booking = await queries.getBookingById(bookingId);
  if (!booking) return { ok: false };
  if (booking.status === 'cancelled') {
    // Late betaling op een al geannuleerde boeking: terugbetalen, niet heractiveren
    console.error(`Booking #${bookingId}: late combi-betaling op geannuleerde boeking — refund gestart`);
    try { await stripe.refunds.create({ payment_intent: intent.id }); }
    catch (e) { console.error('Late-payment refund failed:', e.message); }
    return { ok: false };
  }

  const result = await queries.confirmBookingWithCredits(bookingId, userId, creditsToUse, intent.id);
  if (result.insufficient) {
    // Credits verdwenen tussen intent en betaling (zeldzaam): diner terugbetalen + boeking annuleren
    console.error(`Booking #${bookingId}: onvoldoende credits bij combi-settle — refund + annulering`);
    try { await stripe.refunds.create({ payment_intent: intent.id }); }
    catch (e) { console.error('Combi refund failed:', e.message); }
    await queries.cancelBooking(bookingId);
    return { ok: false, insufficient: true };
  }

  await queries.redeemPendingPromo(bookingId);

  try {
    const fresh = await queries.getBookingById(bookingId);
    if (fresh && fresh.status === 'confirmed' && !fresh.confirmation_sent) {
      await sendBookingConfirmation(fresh);
      await queries.markConfirmationSent(bookingId);
    }
  } catch (e) {
    console.error('Combi confirmation email failed (non-fatal):', e.message);
  }
  return { ok: true };
}

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
    if (booking.status === 'cancelled')
      return res.status(400).json({ error: 'Deze boeking is geannuleerd. Neem contact op als je toch betaald hebt.' });

    // Hybride combi-betaling: credits afschrijven i.p.v. de boeking direct te
    // bevestigen (updateBookingPayment zou hem zonder credits bevestigen)
    if (intent.metadata?.type === 'member_combi') {
      if (intent.status === 'succeeded') {
        const settled = await settleMemberCombi(intent);
        if (settled.insufficient)
          return res.status(400).json({ error: 'Onvoldoende credits — je betaling is teruggestort.' });
      } else {
        await queries.updateBookingPayment(booking.id, intent.id, intent.status);
      }
      return res.json({
        status:     intent.status,
        booking_id: booking.id,
        confirmed:  intent.status === 'succeeded',
      });
    }

    await queries.updateBookingPayment(booking.id, intent.id, intent.status);

    if (intent.status === 'succeeded') {
      await queries.redeemPendingPromo(booking.id);
    }

    if (intent.status === 'succeeded' && !booking.confirmation_sent) {
      try {
        await sendBookingConfirmation({ ...booking, group_size: booking.group_size });
        await queries.markConfirmationSent(booking.id);
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
module.exports.settleMemberCombi = settleMemberCombi;
