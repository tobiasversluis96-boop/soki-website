/**
 * utils/special.js
 * "Special": losse eenmalige sessies (bijv. een Aufguss mini masterclass) met
 * een eigen naam, prijs en capaciteit per slot. Ze hangen onder het vaste
 * sessietype "Special" (aangemaakt in db/database.js). Spelregels:
 *  - naam van de special staat in time_slots.edition, prijs in price_cents
 *  - niet te boeken met membershipcredits, Unlimited of strippenkaart
 *  - nooit Community Rate (zie utils/community-rate.js)
 */

const SPECIAL_TYPE_NAME = 'Special';

function isSpecialName(name) {
  return /^special$/i.test(String(name || '').trim());
}

// Werkt met slot-rijen (session_name) én sessietype-rijen (name)
function isSpecial(row) {
  if (!row) return false;
  return isSpecialName(row.session_name !== undefined ? row.session_name : row.name);
}

// Werkelijke duur van een slot in minuten (start/eind zijn 'HH:MM')
function slotMinutes(startTime, endTime) {
  const [sh, sm] = String(startTime || '').split(':').map(Number);
  const [eh, em] = String(endTime || '').split(':').map(Number);
  if ([sh, sm, eh, em].some(Number.isNaN)) return null;
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  return mins > 0 ? mins : null;
}

module.exports = { SPECIAL_TYPE_NAME, isSpecialName, isSpecial, slotMinutes };
