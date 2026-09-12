/**
 * utils/discount-codes.js
 * Validatie van admin-beheerde kortingscodes (boekingen + strippenkaart).
 */
const { queries } = require('../db/database');

// context: 'booking' | 'punch_pass'
// Resultaat: { notFound: true } | { error: '...' } | { code: row }
async function validateDiscountCode(code, userId, context) {
  const row = await queries.getDiscountCodeByCode(code);
  if (!row) return { notFound: true };
  if (!row.is_active)
    return { error: 'Deze kortingscode is niet meer geldig.' };
  if (row.applies_to !== 'both' && row.applies_to !== context)
    return { error: context === 'booking'
      ? 'Deze kortingscode geldt niet voor sessieboekingen.'
      : 'Deze kortingscode geldt niet voor de strippenkaart.' };
  if (row.valid_until && new Date(row.valid_until).setHours(23, 59, 59, 999) < Date.now())
    return { error: 'Deze kortingscode is verlopen.' };
  if (row.max_uses !== null && row.use_count >= row.max_uses)
    return { error: 'Deze kortingscode is al volledig gebruikt.' };
  if (row.once_per_customer && await queries.hasUserUsedDiscountCode(row.id, userId))
    return { error: 'Je hebt deze kortingscode al gebruikt.' };
  return { code: row };
}

function discountAmount(row, baseCents) {
  const raw = row.discount_pct
    ? Math.round(baseCents * row.discount_pct / 100)
    : (row.discount_cents || 0);
  return Math.max(0, Math.min(raw, baseCents));
}

module.exports = { validateDiscountCode, discountAmount };
