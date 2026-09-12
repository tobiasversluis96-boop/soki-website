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
            const confirmed = await queries.confirmWalkinBooking(bookingId, session.payment_intent);
            if (!confirmed) {
              // Boeking was al verlopen/geannuleerd toen de betaling binnenkwam:
              // niet heractiveren (plek kan opnieuw verkocht zijn) maar terugbetalen.
              console.error(`Walk-in booking #${bookingId}: late betaling op niet-pending boeking — refund gestart`);
              if (session.payment_intent) {
                try { await stripe.refunds.create({ payment_intent: session.payment_intent }); }
                catch (e) { console.error('Walk-in late-payment refund failed:', e.message); }
              }
              break;
            }
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

        // Punch pass (strippenkaart) purchase: create the pass once payment is in
        if (session.mode === 'payment' && session.metadata && session.metadata.type === 'punch_pass') {
          if (session.payment_status !== 'paid') break;
          const ppUserId = parseInt(session.metadata.user_id);
          const credits  = parseFloat(session.metadata.credits);
          const priceCents = parseInt(session.metadata.price_cents);
          if (!ppUserId || !(credits > 0)) break;

          // Idempotent: UNIQUE op stripe_payment_intent_id, ON CONFLICT DO NOTHING
          const pass = await queries.createPunchPass(ppUserId, {
            bundle_name: session.metadata.bundle_name || 'Punch Pass',
            credits,
            price_cents: priceCents || 0,
          }, session.payment_intent);

          if (pass) {
            console.log(`✓ Punch pass created for user ${ppUserId} (${credits} credits)`);
            if (session.metadata.discount_code_id) {
              try {
                await queries.redeemDiscountCode(parseInt(session.metadata.discount_code_id), ppUserId, { punchPassId: pass.id });
              } catch (e) { console.error('Discount code redeem failed (non-fatal):', e.message); }
            }
            try {
              const user = await queries.getUserById(ppUserId);
              if (user) {
                const { sendPunchPassEmail } = require('../utils/email');
                await sendPunchPassEmail({
                  customer_name:  user.name,
                  customer_email: user.email,
                  bundle_name:    pass.bundle_name,
                  credits:        Number(pass.credits),
                  price_cents:    pass.price_cents,
                  expires_at:     pass.expires_at,
                });
              }
            } catch (e) {
              console.error('Punch pass email failed (non-fatal):', e.message);
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

        try {
          const user = await queries.getUserById(userId);
          if (user) {
            const { sendMemberWelcomeEmail } = require('../utils/email');
            await sendMemberWelcomeEmail({
              customer_name:     user.name,
              customer_email:    user.email,
              plan_name:         plan.name,
              credits_per_month: plan.credits_per_month,
              price_cents:       plan.price_cents,
            });
          }
        } catch (e) {
          console.error('Member welcome email failed (non-fatal):', e.message);
        }
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

          try {
            const user = await queries.getUserById(parseInt(intent.metadata.user_id));
            const slot = await queries.getSlotById(parseInt(intent.metadata.slot_id));
            if (user && slot) {
              const { sendWaitlistJoinedEmail } = require('../utils/email');
              await sendWaitlistJoinedEmail({
                customer_name:  user.name,
                customer_email: user.email,
                session_name:   slot.session_name,
                date:           slot.date,
                start_time:     slot.start_time,
                end_time:       slot.end_time,
                group_size:     parseInt(intent.metadata.group_size) || 1,
                total_cents:    intent.amount,
              });
            }
          } catch (e) {
            console.error('Waitlist-joined email failed (non-fatal):', e.message);
          }
          break;
        }

        // Hybride combi-boeking: credits afschrijven + bevestigen (idempotent)
        if (intent.metadata?.type === 'member_combi') {
          const { settleMemberCombi } = require('./payments');
          await settleMemberCombi(intent);
          break;
        }

        // Otherwise confirm regular booking
        const booking = await queries.getBookingByPaymentIntent(intent.id);
        if (!booking) break;
        if (booking.status === 'cancelled') {
          // Late betaling op een al geannuleerde boeking: terugbetalen, niet heractiveren
          console.error(`Booking #${booking.id}: late betaling op geannuleerde boeking — refund gestart`);
          try { await stripe.refunds.create({ payment_intent: intent.id }); }
          catch (e) { console.error('Late-payment refund failed:', e.message); }
          break;
        }
        // Redeem attached gift card/milestone (idempotent — safe if /confirm already did)
        await queries.redeemPendingPromo(booking.id);
        if (booking.status !== 'confirmed') {
          await queries.updateBookingPayment(booking.id, intent.id, 'succeeded');
          console.log(`✓ Booking #${booking.id} confirmed via webhook`);
        }
        // Bevestigingsmail als /confirm die (nog) niet heeft gestuurd
        try {
          const fresh = await queries.getBookingById(booking.id);
          if (fresh && fresh.status === 'confirmed' && !fresh.confirmation_sent) {
            const { sendBookingConfirmation } = require('../utils/email');
            await sendBookingConfirmation(fresh);
            await queries.markConfirmationSent(booking.id);
          }
        } catch (e) {
          console.error('Webhook confirmation email failed (non-fatal):', e.message);
        }
        break;
      }

      // Note: 'invoice.payment_failed' must be enabled in Stripe Dashboard webhook settings
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const stripeSubId = invoice.subscription;
        if (!stripeSubId) break;
        // Stripe vuurt dit event bij elke incassopoging — alleen bij de eerste mailen
        if (invoice.attempt_count > 1) break;

        const sub = await queries.getSubscriptionByStripeId(stripeSubId);
        if (!sub) break;

        try {
          const user  = await queries.getUserById(sub.user_id);
          const plans = await queries.getSubscriptionPlans();
          const plan  = plans.find(p => p.id === sub.plan_id);
          if (user) {
            const { sendPaymentFailedEmail } = require('../utils/email');
            await sendPaymentFailedEmail({
              customer_name:  user.name,
              customer_email: user.email,
              plan_name:      plan ? plan.name : 'Membership',
              amount_cents:   invoice.amount_due,
            });
          }
        } catch (e) {
          console.error('Payment-failed email error (non-fatal):', e.message);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const stripeSub = event.data.object;
        await queries.updateSubscriptionFromWebhook(stripeSub.id, 'expired', new Date(), false);
        console.log(`✓ Subscription expired: ${stripeSub.id}`);
        break;
      }

      // Note: 'charge.refunded' must be enabled in Stripe Dashboard webhook settings
      case 'charge.refunded': {
        const charge = event.data.object;
        // Alleen bij volledige refund van een punch pass het tegoed intrekken
        if (!charge.payment_intent || !charge.refunded) break;
        const revoked = await queries.revokePunchPassByPaymentIntent(charge.payment_intent);
        if (revoked) console.log(`✓ Punch pass #${revoked.id} ingetrokken na volledige refund (intent ${charge.payment_intent})`);
        break;
      }
    }
  } catch (err) {
    // 500 zodat Stripe het event opnieuw aanbiedt; handlers zijn idempotent
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }

  res.json({ received: true });
});

function mapStripeStatus(stripeStatus) {
  const map = { active: 'active', past_due: 'past_due', canceled: 'expired', unpaid: 'past_due', incomplete: 'past_due', trialing: 'active' };
  return map[stripeStatus] || 'expired';
}

module.exports = router;
