/**
 * utils/community-rate.js
 * Community Rate: een beperkt aantal goedkopere plekken op rustige sessies,
 * bedoeld voor gasten voor wie de normale prijs even niet op te brengen is.
 *
 * Spelregels (yield-management):
 *  - alleen op rustige tijdvakken (WINDOWS, per weekdag, o.b.v. bezettingsdata)
 *  - nooit op Aufguss / Ambient / specials / privéverhuur / gratis sessies
 *  - pas boekbaar vanaf RELEASE_HOURS uur vóór de sessie (anders eet de
 *    korting reguliere omzet op)
 *  - max MAX_PER_SLOT plekken per sessie, max 1 per persoon, alleen solo
 *  - alleen zolang er nog ruim plek is (MIN_FREE_SEATS): de laatste stoelen
 *    blijven voor de volle prijs
 *  - niet combineerbaar met promocodes, huurderskorting of credits
 */

const RELEASE_HOURS   = parseInt(process.env.COMMUNITY_RELEASE_HOURS) || 24; // zoveel uur vóór de start komt het tarief vrij
const MAX_PER_SLOT    = 2;   // max aantal Community Rate-plekken per sessie
const MIN_FREE_SEATS  = 4;   // alleen aanbieden zolang er minstens zoveel plekken vrij zijn
const PRICE_SHORT     = 1000; // €10 voor sessies tot en met 70 min
const PRICE_LONG      = 1500; // €15 voor langere sessies (Extended)
const LONG_FROM_MIN   = 71;

// Rustige tijdvakken per weekdag (0=zo..6=za), o.b.v. bezetting sep/okt 2026.
// Een sessie valt in het venster als de starttijd binnen [van, tot) ligt.
const WINDOWS = {
  0: [['10:00', '13:00']], // zo-ochtend (4-38% bezet; middag loopt vol)
  3: [['15:00', '19:00']], // wo-middag/vooravond (24-28%)
  4: [['10:00', '19:00']], // do t/m vooravond (11-20%)
  5: [['10:00', '18:00']], // vr-middag (27-32%; avond uitgesloten)
  6: [['08:00', '12:00']], // za-ochtend (18-21%; vanaf de middag drukker)
};

// Sessies die nooit meedoen, ongeacht het tijdvak
const EXCLUDED_NAME = /aufguss|opgieting|ambient|special/i;

function nowNL() {
  // 'YYYY-MM-DD HH:MM:SS' in NL-tijd; date/start_time in de DB zijn VARCHAR
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' });
}

function minutesBetween(start, end) {
  const [sh, sm] = String(start).split(':').map(Number);
  const [eh, em] = String(end).split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

function communityPriceCents(slot) {
  return minutesBetween(slot.start_time, slot.end_time) >= LONG_FROM_MIN ? PRICE_LONG : PRICE_SHORT;
}

// Valt dit slot (ongeacht het moment van vragen) in een Community Rate-venster?
function inCommunityWindow(slot) {
  if (!slot || slot.is_private || slot.is_cancelled) return false;
  if (!(slot.price_cents > 0)) return false;
  if (EXCLUDED_NAME.test(slot.session_name || '')) return false;
  const [y, m, d] = String(slot.date).split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  const windows = WINDOWS[weekday];
  if (!windows) return false;
  const start = String(slot.start_time).slice(0, 5);
  return windows.some(([from, to]) => start >= from && start < to);
}

// Is het tarief op dit moment boekbaar voor dit slot? (venster + vrijgavetijd)
// now is NL-wandkloktijd ('YYYY-MM-DD HH:MM:SS'); de +24u gebeurt als lokale
// wandklokoptelling, dus onafhankelijk van de tijdzone van de server.
function communityOpen(slot, now = nowNL()) {
  if (!inCommunityWindow(slot)) return false;
  const slotStart = slot.date + ' ' + String(slot.start_time).slice(0, 5);
  if (slotStart <= now) return false; // al begonnen
  const release = new Date(new Date(now.replace(' ', 'T')).getTime() + RELEASE_HOURS * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const releaseStr = `${release.getFullYear()}-${pad(release.getMonth() + 1)}-${pad(release.getDate())} ${pad(release.getHours())}:${pad(release.getMinutes())}`;
  return slotStart <= releaseStr;
}

module.exports = {
  RELEASE_HOURS, MAX_PER_SLOT, MIN_FREE_SEATS,
  communityPriceCents, inCommunityWindow, communityOpen, nowNL,
};
