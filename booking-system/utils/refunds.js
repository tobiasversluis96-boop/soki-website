/**
 * utils/refunds.js
 * Eén plek voor "betaling van een boeking (deels) terugstorten": klant-,
 * admin-, slot- en membership-annuleringen gebruiken allemaal dezelfde regels,
 * zodat een wijziging in de refundlogica niet op vier plekken hoeft.
 */
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// claimed: de boekingsrij zoals claimBookingCancel die teruggeeft (actuele
// betaalstatus). pct: percentage van het betaalde bedrag (100 = alles).
// Retourneert { refunded, refundedCents, alreadyRefunded, failed, error }.
// Gooit nooit: de aanroeper beslist wat een mislukte refund betekent.
async function refundBookingCharge(claimed, pct = 100) {
  const none = { refunded: false, refundedCents: 0, alreadyRefunded: false, failed: false };
  const intentId = claimed.stripe_payment_intent_id;
  if (!intentId || claimed.stripe_payment_status !== 'succeeded' || !(pct > 0)) return none;
  try {
    // Bij (deels) met credits betaalde boekingen is via Stripe minder dan
    // total_cents betaald (alleen diner, of extra personen + diner), of zelfs
    // niets (oude intent van een afgebroken betaalpoging): refund berekenen
    // over wat er écht is afgerekend.
    let chargedCents = claimed.total_cents;
    if (Number(claimed.credits_used) > 0) {
      const intent = await stripe.paymentIntents.retrieve(intentId);
      chargedCents = intent.amount_received || 0;
    }
    if (!(chargedCents > 0)) return none;
    const refundedCents = pct === 100 ? chargedCents : Math.floor(chargedCents * pct / 100);
    const args = { payment_intent: intentId };
    // Alleen bij een deelrefund een bedrag meegeven; zonder bedrag stort Stripe
    // de hele (resterende) betaling terug
    if (pct !== 100) args.amount = refundedCents;
    await stripe.refunds.create(args);
    return { ...none, refunded: true, refundedCents };
  } catch (err) {
    if (err.code === 'charge_already_refunded') return { ...none, alreadyRefunded: true };
    console.error(`Stripe refund failed for booking #${claimed.id}:`, err.message);
    return { ...none, failed: true, error: err };
  }
}

// Onbetaalde boeking geannuleerd: de open betaalintentie sluiten zodat er niet
// alsnog betaald wordt. Lukt het niet (al betaald of verlopen), dan vangt de
// webhook een late betaling op met een refund.
async function cancelOpenIntent(claimed) {
  const intentId = claimed.stripe_payment_intent_id;
  const status   = claimed.stripe_payment_status;
  if (!intentId || status === 'succeeded' || status === 'processing') return;
  try { await stripe.paymentIntents.cancel(intentId); } catch (e) { /* zie boven */ }
}

module.exports = { refundBookingCharge, cancelOpenIntent };
