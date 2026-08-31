/**
 * scripts/update-plan-prices.js
 *
 * One-off migration: bump Everyday Member to €49 and Unlimited to €99.
 * - Creates a NEW Stripe Price for each plan (Stripe prices are immutable)
 * - Archives the OLD Stripe Price
 * - Updates the subscription_plans row (price_cents + stripe_price_id)
 *
 * Existing subscribers keep the OLD price (Stripe doesn't auto-migrate them).
 * Only new subscriptions after this runs will use the new price.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TARGETS = [
  { name: 'Everyday Member', new_cents: 4900 },
  { name: 'Unlimited',       new_cents: 9900 },
];

(async () => {
  const { rows: plans } = await pool.query('SELECT * FROM subscription_plans');
  console.log(`Found ${plans.length} plan(s) in DB.\n`);

  for (const target of TARGETS) {
    const plan = plans.find(p => p.name === target.name);
    if (!plan) { console.log(`⚠ Skipping "${target.name}" — not in DB`); continue; }

    if (plan.price_cents === target.new_cents) {
      console.log(`✓ "${plan.name}" already at €${target.new_cents / 100}, skipping.\n`);
      continue;
    }

    console.log(`→ Updating "${plan.name}": €${plan.price_cents / 100} → €${target.new_cents / 100}`);
    const oldStripePriceId = plan.stripe_price_id;

    // Fetch old price to reuse its Product
    const oldPrice = await stripe.prices.retrieve(oldStripePriceId);
    const productId = oldPrice.product;
    console.log(`  Stripe product: ${productId}`);
    console.log(`  Old Stripe price: ${oldStripePriceId} (€${oldPrice.unit_amount / 100})`);

    // Create new Stripe price
    const newPrice = await stripe.prices.create({
      product: productId,
      unit_amount: target.new_cents,
      currency: 'eur',
      recurring: { interval: 'month' },
    });
    console.log(`  New Stripe price: ${newPrice.id} (€${newPrice.unit_amount / 100})`);

    // Update DB
    await pool.query(
      'UPDATE subscription_plans SET price_cents = $1, stripe_price_id = $2 WHERE id = $3',
      [target.new_cents, newPrice.id, plan.id]
    );
    console.log(`  DB row ${plan.id} updated.`);

    // Archive old Stripe price so it can't be used for new subscriptions
    await stripe.prices.update(oldStripePriceId, { active: false });
    console.log(`  Old Stripe price archived.\n`);
  }

  console.log('Done. Existing subscriptions on old prices are unaffected.');
  await pool.end();
  process.exit(0);
})().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
