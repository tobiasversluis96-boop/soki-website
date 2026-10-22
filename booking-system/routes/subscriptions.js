/**
 * routes/subscriptions.js
 * Customer subscription management.
 */
const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { queries } = require('../db/database');
const { requireAuth } = require('./auth');
const { promoteWaitlist } = require('../utils/waitlist-promote');
const nlTime = require('../utils/nl-time');

const router = express.Router();

// Credit cost per session type (session_type_id -> credits)
const CREDIT_COST = { 1: 1, 2: 1, 3: 1.5, 4: 1.5 };  // 1=Everyday, 2=Extended, 3=Ambient, 4=Aufguss

// Minimale looptijd: memberships gestart vanaf deze datum zitten minimaal
// 3 maanden vast. Opzeggen kan altijd, maar binnen de eerste 3 maanden loopt
// het membership door tot het einde van maand 3; daarna maandelijks opzegbaar.
// Bestaande leden (gestart vóór deze datum) houden de oude regels.
const MIN_TERM_MONTHS       = 3;
const MIN_TERM_APPLIES_FROM = Date.UTC(2026, 9, 20); // 20 okt 2026

// GET /api/subscriptions/plans
router.get('/plans', async (req, res) => {
  const plans = await queries.getSubscriptionPlans();
  res.json(plans);
});

// GET /api/subscriptions/my
router.get('/my', requireAuth, async (req, res) => {
  const sub = await queries.getActiveSubscription(req.user.userId);
  res.json(sub || null);
});

// POST /api/subscriptions/checkout  -- creates Stripe Checkout session
router.post('/checkout', requireAuth, async (req, res) => {
  const { plan_id } = req.body;
  if (!plan_id) return res.status(400).json({ error: 'plan_id is required' });

  const plans = await queries.getSubscriptionPlans();
  const plan  = plans.find(p => p.id === parseInt(plan_id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  // Check no existing active sub
  const existing = await queries.getActiveSubscription(req.user.userId);
  if (existing) return res.status(409).json({ error: 'You already have an active subscription' });

  const user = await queries.getUserById(req.user.userId);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card', 'ideal', 'sepa_debit', 'bancontact'],
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    customer_email: user.email,
    success_url: process.env.BASE_URL + '/account?sub=success',
    cancel_url:  process.env.BASE_URL + '/membership?sub=cancelled',
    metadata: {
      user_id: String(req.user.userId),
      plan_id: String(plan.id),
    },
    subscription_data: {
      metadata: {
        user_id: String(req.user.userId),
        plan_id: String(plan.id),
      },
    },
  });

  res.json({ url: session.url });
});

// POST /api/subscriptions/cancel
router.post('/cancel', requireAuth, async (req, res) => {
  const sub = await queries.getActiveSubscription(req.user.userId);
  if (!sub) return res.status(404).json({ error: 'No active subscription' });

  // Minimale looptijd: valt het einde van de lopende periode nog binnen de
  // eerste 3 maanden, dan niet stoppen aan het einde van de periode maar pas
  // aan het einde van maand 3 (cancel_at). Het uur marge voorkomt dat Stripe
  // precies op de periodegrens nog een vierde maand factureert.
  let endsAt = sub.current_period_end;
  let minTermApplied = false;
  const stripeSub  = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
  const startMs    = (stripeSub.start_date || 0) * 1000;
  if (startMs >= MIN_TERM_APPLIES_FROM) {
    const minEnd = new Date(startMs);
    minEnd.setMonth(minEnd.getMonth() + MIN_TERM_MONTHS);
    const cancelAtMs = minEnd.getTime() - 3600 * 1000;
    const periodEndMs = sub.current_period_end ? new Date(sub.current_period_end).getTime() : 0;
    if (cancelAtMs > periodEndMs + 3600 * 1000) {
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        cancel_at: Math.floor(cancelAtMs / 1000),
      });
      endsAt = new Date(cancelAtMs);
      minTermApplied = true;
    }
  }
  if (!minTermApplied) {
    // Cancel at period end in Stripe
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
  }
  await queries.cancelSubscription(req.user.userId, endsAt);

  // Sessies ná de einddatum die al op dit membership geboekt waren, gaan mee
  // uit: anders boek je eerst alles vol en zeg je daarna op. Credits komen
  // terug (daar kan de klant tot de einddatum nog mee boeken).
  const droppedBookings = await cancelMembershipBookingsAfter(sub.id, endsAt ? new Date(endsAt) : null,
    'Je membership is opgezegd en deze sessie valt na de einddatum. / Your membership has been cancelled and this session is after its end date.');

  try {
    const user = await queries.getUserById(req.user.userId);
    if (user) {
      const { sendMemberCancelledEmail } = require('../utils/email');
      await sendMemberCancelledEmail({
        customer_name:  user.name,
        customer_email: user.email,
        plan_name:      sub.plan_name,
        ends_at:        endsAt,
      });
    }
  } catch (e) {
    console.error('Member-cancelled email failed (non-fatal):', e.message);
  }

  res.json({
    ok: true, ends_at: endsAt, min_term_applied: minTermApplied || undefined,
    cancelled_bookings: droppedBookings.map(b => ({ id: b.id, date: nlTime.normalizeDate(b.date), start_time: b.start_time, session_name: b.session_name })),
  });
});

// Annuleer bevestigde boekingen op een membership die ná `endsAt` vallen
// (endsAt null = alles vanaf nu: het membership is al beëindigd). Credits gaan
// terug zolang het membership nog loopt; de klant krijgt per boeking een mail.
// Retourneert de geannuleerde boekingen.
async function cancelMembershipBookingsAfter(subscriptionId, endsAt, reason) {
  const dropped = [];
  let bookings = [];
  try {
    bookings = await queries.getConfirmedBookingsForSubscription(subscriptionId);
  } catch (e) {
    console.error('Membership-boekingen ophalen mislukt (non-fatal):', e.message);
    return dropped;
  }
  for (const b of bookings) {
    const startsAt = nlTime.nlToDate(b.date, b.start_time);
    if (!startsAt || (endsAt && startsAt <= endsAt)) continue;
    try {
      const claimed = await queries.claimBookingCancel(b.id);
      if (!claimed) continue;
      let creditsRestored = 0;
      if (Number(b.credits_used) > 0) {
        const restored = await queries.restoreCreditsForBooking(claimed);
        if (restored) creditsRestored = Number(b.credits_used);
      }
      // Eventueel via Stripe bijbetaald deel (extra personen/diner) terug
      let refunded = false, refundedCents = 0;
      if (claimed.stripe_payment_intent_id && claimed.stripe_payment_status === 'succeeded' && Number(claimed.paid_cents) > 0) {
        try {
          await stripe.refunds.create({ payment_intent: claimed.stripe_payment_intent_id });
          refunded = true; refundedCents = Number(claimed.paid_cents);
        } catch (e) {
          if (e.code !== 'charge_already_refunded') console.error(`Refund mislukt voor membership-boeking #${b.id}:`, e.message);
        }
      }
      queries.auditLog({ actor_type: 'system', action: 'booking_cancelled', target: `booking:${b.id}`, detail: `membership ended (sub ${subscriptionId}); ${creditsRestored} credits restored` });
      try {
        const { sendBookingCancelledEmail } = require('../utils/email');
        await sendBookingCancelledEmail(b, { refunded, refundedCents, creditsRestored, sessionCancelled: false, reason });
      } catch (e) {
        console.error('Membership-boeking annuleringsmail mislukt (non-fatal):', e.message);
      }
      await promoteWaitlist(b);
      dropped.push(b);
    } catch (e) {
      console.error(`Membership-boeking #${b.id} annuleren mislukt (non-fatal):`, e.message);
    }
  }
  return dropped;
}

// POST /api/subscriptions/credit-cost  -- returns cost for a slot
router.post('/credit-cost', requireAuth, async (req, res) => {
  const { session_type_id } = req.body;
  const groupSize = Math.min(Math.max(parseInt(req.body.group_size) || 1, 1), 20);
  // Alleen een 'active' membership geeft boekrecht (past_due = incasso mislukt)
  const sub  = await queries.getEntitledSubscription(req.user.userId);
  const passes = await queries.getActivePunchPasses(req.user.userId);
  const passTotal = passes.reduce((sum, p) => sum + Number(p.credits_remaining), 0);
  // Credits (abonnement én strippenkaart) zijn persoonlijk: ze dekken alleen de eigen
  // plek. Bij een groepsboeking worden de extra personen via Stripe bijbetaald.
  const cost = (sub && sub.credits_per_month === null) ? 0 : (CREDIT_COST[session_type_id] || 1.5);
  const covered = (sub ? (sub.credits_per_month === null || (Number(sub.credits_remaining) || 0) >= cost) : false)
    || passes.some(p => Number(p.credits_remaining) >= cost);
  res.json({
    has_subscription: !!sub || passes.length > 0,
    credits_cost: cost,
    credits_remaining: (sub ? Number(sub.credits_remaining) || 0 : 0) + passTotal,
    is_unlimited: sub ? sub.credits_per_month === null : false,
    can_book: groupSize === 1 && covered,
    // Groepsboeking: eigen plek op credits, extra personen (en evt. diner) bijbetalen
    credit_partial: groupSize > 1 && covered,
  });
});

// Einddatum van een opgezegd membership (null als het gewoon doorloopt):
// na dit moment mag er niet meer met credits/Unlimited op geboekt worden.
function membershipEndsAt(sub) {
  if (!sub || !sub.cancel_at_period_end) return null;
  const end = sub.ends_at || sub.current_period_end;
  return end ? new Date(end) : null;
}

module.exports = router;
module.exports.CREDIT_COST = CREDIT_COST;
module.exports.membershipEndsAt = membershipEndsAt;
module.exports.cancelMembershipBookingsAfter = cancelMembershipBookingsAfter;
