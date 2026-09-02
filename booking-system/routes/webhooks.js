/**
 * routes/webhooks.js
 * Stripe webhook handler for subscription lifecycle events.
 */
const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { queries } = require('../db/database');

const router = express.Router();

// Stripe requires raw body for webhook signature verification
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  if (secret) {
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error('Webhook signature failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else if (process.env.NODE_ENV === 'production') {
    // Never accept unverified payment events in production
    console.error('Webhook rejected: STRIPE_WEBHOOK_SECRET is not configured');
    return res.status(500).send('Webhook not configured');
  } else {
    // No webhook secret configured -- accept without verification (dev only)
    try { event = JSON.parse(req.body); } catch { return res.status(400).send('Invalid JSON'); }
  }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;

        // Walk-in booking payment via QR: confirm booking + clear the hold
        if (session.mode === 'payment' && session.metadata && session.metadata.walkin === '1') {
          const bookingId = parseInt(session.metadata.booking_id);
          if (bookingId && session.payment_status === 'paid') {
            await queries.confirmWalkinBooking(bookingId, session.payment_intent);
            console.log(`✓ Walk-in booking #${bookingId} confirmed via QR checkout`);
            try {
              const fullBooking = await queries.getBookingById(bookingId);
              if (fullBooking && !fullBooking.confirmation_sent) {
                const { sendBookingConfirmation } = require('../utils/email');
                await sendBookingConfirmation(fullBooking);
                await queries.markConfirmationSent(bookingId);
              }
            } catch (e) {
              console.error('Walk-in confirmation email failed (non-fatal):', e.message);
            }
          }
          break;
        }

        if (session.mode !== 'subscription') break;

        const userId = parseInt(session.metadata.user_id);
        const planId = parseInt(session.metadata.plan_id);
        const stripeSubId    = session.subscription;
        const stripeCustomer = session.customer;

        // Fetch the subscription to get period_end
        const stripeSub = await stripe.subscriptions.retrieve(stripeSubId);
        const periodEnd = new Date(stripeSub.current_period_end * 1000);

        const plans = await queries.getSubscriptionPlans();
        const plan  = plans.find(p => p.id === planId);
        if (!plan) break;

        await queries.createSubscription(
          userId, planId, stripeSubId, stripeCustomer,
          plan.credits_per_month, periodEnd
        );
        console.log(`✓ Subscription created for user ${userId}`);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.billing_reason !== 'subscription_cycle') break;  // Only handle renewals

        const stripeSubId = invoice.subscription;
        const sub = await queries.getSubscriptionByStripeId(stripeSubId);
        if (!sub) break;

        const stripeSub = await stripe.subscriptions.retrieve(stripeSubId);
        const periodEnd = new Date(stripeSub.current_period_end * 1000);

        const plans = await queries.getSubscriptionPlans();
        const plan  = plans.find(p => p.id === sub.plan_id);
        if (!plan) break;

        // Reset credits for new period
        await queries.resetSubscriptionCredits(stripeSubId, plan.credits_per_month, periodEnd);
        console.log(`✓ Credits reset for subscription ${stripeSubId}`);
        break;
      }

      case 'customer.subscription.updated': {
        const stripeSub = event.data.object;
        const periodEnd = new Date(stripeSub.current_period_end * 1000);

        // If Stripe reports pause_collection, mirror locally as 'paused'.
        // If it's cleared (e.g. auto-resumed at resumes_at), mark resumed.
        if (stripeSub.pause_collection) {
          const local = await queries.getSubscriptionByStripeId(stripeSub.id);
          if (local && local.status !== 'paused') {
            const resumesAt = stripeSub.pause_collection.resumes_at
              ? new Date(stripeSub.pause_collection.resumes_at * 1000)
              : null;
            await queries.markSubscriptionPaused(local.id, resumesAt);
          }
        } else {
          const local = await queries.getSubscriptionByStripeId(stripeSub.id);
          if (local && local.status === 'paused') {
            await queries.markSubscriptionResumedByStripeId(stripeSub.id);
          }
          const status = mapStripeStatus(stripeSub.status);
          await queries.updateSubscriptionFromWebhook(stripeSub.id, status, periodEnd, stripeSub.cancel_at_period_end);
        }
        break;
      }

      // Note: 'payment_intent.succeeded' must be enabled in Stripe Dashboard webhook settings
      case 'payment_intent.succeeded': {
        const intent = event.data.object;

        // Check if this is a waitlist payment
        if (intent.metadata?.type === 'waitlist') {
          await queries.markWaitlistPaid(intent.id);
          console.log(`✓ Waitlist payment confirmed for intent ${intent.id}`);
          break;
        }

        // Otherwise confirm regular booking
        const booking = await queries.getBookingByPaymentIntent(intent.id);
        if (!booking) break;
        // Redeem attached gift card/milestone (idempotent — safe if /confirm already did)
        await queries.redeemPendingPromo(booking.id);
        if (booking.status === 'confirmed') break; // idempotent
        await queries.updateBookingPayment(booking.id, intent.id, 'succeeded');
        console.log(`✓ Booking #${booking.id} confirmed via webhook`);
        break;
      }

      case 'customer.subscription.deleted': {
        const stripeSub = event.data.object;
        await queries.updateSubscriptionFromWebhook(stripeSub.id, 'expired', new Date(), false);
        console.log(`✓ Subscription expired: ${stripeSub.id}`);
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }

  res.json({ received: true });
});

function mapStripeStatus(stripeStatus) {
  const map = { active: 'active', past_due: 'past_due', canceled: 'expired', unpaid: 'past_due', incomplete: 'past_due', trialing: 'active' };
  return map[stripeStatus] || 'expired';
}

module.exports = router;
