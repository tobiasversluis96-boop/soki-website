/**
 * routes/subscriptions.js
 * Customer subscription management.
 */
const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { queries } = require('../db/database');
const { requireAuth } = require('./auth');

const router = express.Router();

// Credit cost per session type (session_type_id -> credits)
const CREDIT_COST = { 1: 1, 2: 1, 3: 1.5, 4: 1.5 };  // 1=Everyday, 2=Social, 3=Ambient, 4=Aufguss

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

  // Cancel at period end in Stripe
  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    cancel_at_period_end: true,
  });
  await queries.cancelSubscription(req.user.userId);

  try {
    const user = await queries.getUserById(req.user.userId);
    if (user) {
      const { sendMemberCancelledEmail } = require('../utils/email');
      await sendMemberCancelledEmail({
        customer_name:  user.name,
        customer_email: user.email,
        plan_name:      sub.plan_name,
        ends_at:        sub.current_period_end,
      });
    }
  } catch (e) {
    console.error('Member-cancelled email failed (non-fatal):', e.message);
  }

  res.json({ ok: true, ends_at: sub.current_period_end });
});

// POST /api/subscriptions/credit-cost  -- returns cost for a slot
router.post('/credit-cost', requireAuth, async (req, res) => {
  const { session_type_id } = req.body;
  // Credits gelden per persoon — zelfde rekensom als confirm-member
  const groupSize = Math.min(Math.max(parseInt(req.body.group_size) || 1, 1), 20);
  const cost = (CREDIT_COST[session_type_id] || 1.5) * groupSize;
  const sub  = await queries.getActiveSubscription(req.user.userId);
  const passes = await queries.getActivePunchPasses(req.user.userId);
  const passTotal = passes.reduce((sum, p) => sum + Number(p.credits_remaining), 0);
  const subCanBook = sub ? (sub.credits_per_month === null || (Number(sub.credits_remaining) || 0) >= cost) : false;
  // Geen mixen van bronnen per boeking: één enkele kaart moet de kosten dekken.
  // Strippenkaart-credits zijn bovendien persoonlijk: alleen voor boekingen voor 1 persoon.
  const passCovers = groupSize === 1 && passes.some(p => Number(p.credits_remaining) >= cost);
  res.json({
    has_subscription: !!sub || passes.length > 0,
    credits_cost: cost,
    credits_remaining: (sub ? Number(sub.credits_remaining) || 0 : 0) + passTotal,
    is_unlimited: sub ? sub.credits_per_month === null : false,
    can_book: subCanBook || passCovers,
    // Strippenkaart bij groepsboeking: eigen plek op credits, extra personen bijbetalen
    pass_partial: !subCanBook && groupSize > 1
      && passes.some(p => Number(p.credits_remaining) >= (CREDIT_COST[session_type_id] || 1.5)),
    credits_cost_self: CREDIT_COST[session_type_id] || 1.5,
  });
});

module.exports = router;
module.exports.CREDIT_COST = CREDIT_COST;
