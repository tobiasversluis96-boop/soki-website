/**
 * utils/stripe-compat.js
 * Webhook-payloads komen binnen in de API-versie van het webhook-endpoint in
 * Stripe, terwijl stripe-node zijn eigen (oudere) versie pint voor API-calls.
 * Sinds Stripe-versie 2025-03-31 ("basil") staan een aantal velden ergens anders:
 *  - subscription.current_period_end/_start  -> per abonnementsregel (items.data[])
 *  - invoice.subscription                    -> invoice.parent.subscription_details.subscription
 * Deze helpers lezen beide formaten, zodat de code werkt ongeacht welke versie
 * het endpoint gebruikt.
 */

function toDate(unixSeconds) {
  const n = Number(unixSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

// Einde van de lopende periode als Date, of null als Stripe hem niet meestuurt
function subscriptionPeriodEnd(stripeSub) {
  if (!stripeSub) return null;
  const top = toDate(stripeSub.current_period_end);
  if (top) return top;
  const items = (stripeSub.items && stripeSub.items.data) || [];
  const ends = items.map(i => Number(i.current_period_end)).filter(n => Number.isFinite(n) && n > 0);
  return ends.length ? new Date(Math.max(...ends) * 1000) : null;
}

// Abonnement-ID van een factuur (string), of null bij een losse factuur
function invoiceSubscriptionId(invoice) {
  if (!invoice) return null;
  const pick = v => (typeof v === 'string' ? v : (v && v.id) || null);
  const direct = pick(invoice.subscription);
  if (direct) return direct;
  const parent = invoice.parent && invoice.parent.subscription_details && pick(invoice.parent.subscription_details.subscription);
  if (parent) return parent;
  const lines = (invoice.lines && invoice.lines.data) || [];
  for (const line of lines) {
    const fromLine = pick(line.subscription)
      || (line.parent && line.parent.subscription_item_details && pick(line.parent.subscription_item_details.subscription));
    if (fromLine) return fromLine;
  }
  return null;
}

module.exports = { subscriptionPeriodEnd, invoiceSubscriptionId };
