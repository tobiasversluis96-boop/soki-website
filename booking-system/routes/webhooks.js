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
  } else {
    // No webhook secret configured -- accept without verification (dev only)
    try { event = JSON.parse(req.body); } catch { return res.status(400).send('Invalid JSON'); }
  }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
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
        const status = mapStripeStatus(stripeSub.status);
        const periodEnd = new Date(stripeSub.current_period_end * 1000);
        await queries.updateSubscriptionFromWebhook(stripeSub.id, status, periodEnd, stripeSub.cancel_at_period_end);
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
