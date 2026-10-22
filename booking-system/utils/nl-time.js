/**
 * utils/nl-time.js
 * Slots slaan datum en tijd op als NL-wandkloktijd (VARCHAR). Voor
 * "hoeveel uur nog tot de sessie" is wandklok-rekenen niet genoeg: rond de
 * zomer-/wintertijdwissel scheelt dat een uur, precies op de 24u/48u-grens
 * van de annuleringsregels. Deze helpers rekenen via echte tijdstippen.
 */

const TZ = 'Europe/Amsterdam';

// Offset (in minuten) van Europe/Amsterdam t.o.v. UTC op een gegeven moment
function nlOffsetMinutes(at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

function normalizeDate(date) {
  if (date instanceof Date)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return String(date).slice(0, 10);
}

// NL-wandklok (YYYY-MM-DD + HH:MM[:SS]) -> echt tijdstip (Date)
function nlToDate(date, time) {
  const [y, m, d] = normalizeDate(date).split('-').map(Number);
  const [hh, mm, ss] = String(time || '00:00').split(':').map(Number);
  if ([y, m, d, hh, mm].some(Number.isNaN)) return null;
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss || 0);
  // Eerste gok met de offset van dat wandklokmoment, daarna corrigeren voor
  // het geval de gok net aan de andere kant van een DST-wissel viel.
  let guess = new Date(wall - nlOffsetMinutes(new Date(wall)) * 60000);
  guess = new Date(wall - nlOffsetMinutes(guess) * 60000);
  return guess;
}

// Uren tot de start van een slot (negatief = al begonnen)
function hoursUntil(date, time, now = new Date()) {
  const at = nlToDate(date, time);
  if (!at) return NaN;
  return (at.getTime() - now.getTime()) / 36e5;
}

module.exports = { nlToDate, hoursUntil, normalizeDate, TZ };
