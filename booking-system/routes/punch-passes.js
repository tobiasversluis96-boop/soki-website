/**
 * routes/punch-passes.js
 * Strippenkaart (punch pass): buy a credit bundle via one-off Stripe payment.
 */
const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { queries } = require('../db/database');
const { requireAuth } = require('./auth');

const router = express.Router();

// GET /api/punch-passes/bundles  -- public, active bundles for the membership page
router.get('/bundles', async (req, res) => {
  const bundles = await queries.getPunchPassBundles();
  res.json(bundles.map(b => ({
    id: b.id,
    name: b.name,
    credits: Number(b.credits),
    price_cents: b.price_cents,
  })));
});

// GET /api/punch-passes/my  -- passes of the logged-in user
router.get('/my', requireAuth, async (req, res) => {
  const passes = await queries.getUserPunchPasses(req.user.userId);
  res.json(passes);
});

// POST /api/punch-passes/checkout  -- creates Stripe Checkout session (one-off payment)
router.post('/checkout', requireAuth, async (req, res) => {
  const bundleId = parseInt(req.body.bundle_id);
  if (!bundleId) return res.status(400).json({ error: 'bundle_id is required' });

  const bundle = await queries.getPunchPassBundleById(bundleId);
  if (!bundle || !bundle.is_active) return res.status(404).json({ error: 'Bundle not found' });

  const user = await queries.getUserById(req.user.userId);

  const metadata = {
    type:        'punch_pass',
    user_id:     String(req.user.userId),
    bundle_id:   String(bundle.id),
    bundle_name: bundle.name,
    credits:     String(bundle.credits),
    price_cents: String(bundle.price_cents),
  };

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card', 'ideal', 'bancontact'],
    line_items: [{
      price_data: {
        currency: 'eur',
        unit_amount: bundle.price_cents,
        product_data: {
          name: `SOKI ${bundle.name} - ${Number(bundle.credits)} credits`,
        },
      },
      quantity: 1,
    }],
    customer_email: user.email,
    success_url: process.env.BASE_URL + '/account?pp=success',
    cancel_url:  process.env.BASE_URL + '/membership?pp=cancelled',
    metadata,
    payment_intent_data: { metadata },
  });

  res.json({ url: session.url });
});

module.exports = router;
