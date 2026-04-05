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
const CREDIT_COST = { 1: 1, 2: 2, 3: 2, 4: 2 };  // 1=Everyday, 2=Social, 3=Ambient, 4=Aufguss

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
  res.json({ ok: true, ends_at: sub.current_period_end });
});

// POST /api/subscriptions/credit-cost  -- returns cost for a slot
router.post('/credit-cost', requireAuth, async (req, res) => {
  const { session_type_id } = req.body;
  const cost = CREDIT_COST[session_type_id] || 2;
  const sub  = await queries.getActiveSubscription(req.user.userId);
  res.json({
    has_subscription: !!sub,
    credits_cost: cost,
    credits_remaining: sub ? sub.credits_remaining : 0,
    is_unlimited: sub ? sub.credits_per_month === null : false,
    can_book: sub ? (sub.credits_per_month === null || (sub.credits_remaining || 0) >= cost) : false,
  });
});

module.exports = router;
module.exports.CREDIT_COST = CREDIT_COST;
