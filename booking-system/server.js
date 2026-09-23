/**
 * server.js
 * Main Express server for Soki booking system.
 * Run: node server.js (or npm run dev for auto-reload)
 */

require('dotenv').config();

// Losse spaties in env-vars (bijv. bij kopiëren in het Railway-dashboard) breken
// Stripe-URLs en API-keys — hier één keer opschonen voor het hele proces.
for (const key of ['BASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PUBLISHABLE_KEY']) {
  if (process.env[key]) process.env[key] = process.env[key].trim();
}
if (process.env.BASE_URL) process.env.BASE_URL = process.env.BASE_URL.replace(/\/+$/, '');

// ─── Production safety checks ────────────────────────────────────────────────
// Refuse to boot in production with missing secrets: a silent fallback here
// means forgeable login tokens or unverified payment webhooks.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION) {
  const missing = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev_secret_change_me') missing.push('JWT_SECRET');
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push('STRIPE_WEBHOOK_SECRET');
  if (missing.length) {
    console.error(`FATAL: missing required env var(s) in production: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const express   = require('express');
require('./utils/async-errors');
const cors      = require('cors');
const path      = require('path');
const rateLimit = require('express-rate-limit');
const { sendReminderEmail } = require('./utils/email');

const { initializeDB, getPool, queries } = require('./db/database');
const authRoutes          = require('./routes/auth');
const bookingRoutes       = require('./routes/bookings');
const paymentRoutes       = require('./routes/payments');
const adminRoutes         = require('./routes/admin');
const messageRoutes       = require('./routes/messages');
const subscriptionRoutes  = require('./routes/subscriptions');
const waitlistRoutes      = require('./routes/waitlist');
const webhookRoutes       = require('./routes/webhooks');
const giftCardRoutes      = require('./routes/gift-cards');
const punchPassRoutes     = require('./routes/punch-passes');
const buddyRoutes         = require('./routes/buddies');

const app  = express();
const PORT = process.env.PORT || 3001;

// Achter Railway's proxy: nodig zodat express-rate-limit het echte client-IP ziet
app.set('trust proxy', 1);

// ─── Middleware ───────────────────────────────────────────────────────────────
// Webhook route must come before express.json() — Stripe needs the raw body
app.use('/api/webhooks', webhookRoutes);

// Oude railway.app-URL staat nog in Google: stuur bezoekers 301 door naar het
// eigen domein (alleen GET-paginaverkeer, API-calls blijven ongemoeid)
app.use((req, res, next) => {
  // req.hostname leest X-Forwarded-Host (Railway's proxy herschrijft de Host-header)
  const host = req.hostname || '';
  if (host.endsWith('.railway.app') && req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.redirect(301, 'https://www.sokisocialsauna.nl' + req.originalUrl);
  }
  next();
});

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  // Report-only: eerst kijken wat er zou breken voordat we echt gaan blokkeren
  res.setHeader('Content-Security-Policy-Report-Only',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://js.stripe.com https://accounts.google.com https://www.googletagmanager.com https://connect.facebook.net https://analytics.tiktok.com; frame-src https://js.stripe.com https://hooks.stripe.com https://accounts.google.com https://www.google.com; connect-src 'self' https://api.stripe.com https://accounts.google.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com");
  next();
});

const allowedOrigins = [
  process.env.BASE_URL || 'http://localhost:3001',
  'https://sokisocialsauna.nl',
  'https://www.sokisocialsauna.nl',
];
app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)) }));
app.use(express.json());

// Rate limiting on auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth/login',         authLimiter);
app.use('/api/auth/register',      authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/verify-email',        rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/resend-verification', rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false }));
app.use('/api/admin/login',        rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false }));
app.use('/api/messages/feedback',  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/api/messages/contact',   rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/api/bookings', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method !== 'POST',
  message: { error: 'Te veel pogingen — wacht 15 minuten en probeer het opnieuw. / Too many requests — please wait 15 minutes and try again.' },
}));

// Cadeaubonnen: purchase = card-testing-doelwit, check = brute force op codes
const giftMsg = { error: 'Te veel pogingen — wacht 15 minuten en probeer het opnieuw. / Too many requests — please wait 15 minutes and try again.' };
app.use('/api/gift-cards/purchase', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: giftMsg }));
app.use('/api/gift-cards/confirm',  rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: giftMsg }));
app.use('/api/gift-cards/check',    rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: giftMsg }));

// Waitlist gaat via onze Brevo-API-key; zonder limiet is dat een gratis mass-subscribe-kanaal
app.use('/api/waitlist', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));

// Buddy-zoeken: limiet tegen het afscrapen van het ledenbestand
app.use('/api/buddies/search', rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));

// ─── Static files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (req.path.toLowerCase().startsWith('/booking-system')) return res.status(404).end();
  next();
});
app.use(express.static(path.join(__dirname, '..'), {
  index:    'index.html',
  dotfiles: 'deny',
}));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/waitlist',      waitlistRoutes);
app.use('/api/gift-cards',   giftCardRoutes);
app.use('/api/punch-passes', punchPassRoutes);
app.use('/api/buddies',      buddyRoutes);

// Public config (non-secret values for frontend)
app.get('/api/config', (_req, res) => {
  res.json({
    googleClientId:   process.env.GOOGLE_CLIENT_ID    || '',
    baseUrl:          process.env.BASE_URL            || 'http://localhost:3001',
    // Tracking pixel IDs — empty by default (loader will no-op).
    // Fill in .env when ready to activate GA4 / Meta / TikTok.
    ga4MeasurementId: process.env.GA4_MEASUREMENT_ID || '',
    metaPixelId:      process.env.META_PIXEL_ID      || '',
    tiktokPixelId:    process.env.TIKTOK_PIXEL_ID    || '',
  });
});

// Session types (public read)
app.get('/api/session-types', async (req, res) => {
  res.json(await queries.getSessionTypes());
});

// Available slots for a month, optionally filtered by session type
app.get('/api/slots', async (req, res) => {
  const typeId = req.query.session_type_id ? parseInt(req.query.session_type_id) : null;
  const year   = parseInt(req.query.year);
  const month  = parseInt(req.query.month);
  if ((typeId !== null && isNaN(typeId)) || isNaN(year) || isNaN(month) || month < 1 || month > 12 || year < 2020 || year > 2100)
    return res.status(400).json({ error: 'session_type_id, year and month must be valid numbers' });

  const slots = await queries.getSlotsForMonth(typeId, year, month);
  const result = slots.map(s => ({
    ...s,
    capacity:   s.max_capacity || s.type_capacity,
    spots_left: (s.max_capacity || s.type_capacity) - s.booked,
    is_full:    (s.max_capacity || s.type_capacity) - s.booked <= 0,
  }));
  res.json(result);
});

// Next N upcoming slots (homepage widget + sessions programme)
// Query params:
//   limit         (default 3, max 200)
//   include_full  ('1' to include sold-out slots — used by /sessions programme)
app.get('/api/upcoming-slots', async (req, res) => {
  const limit       = Math.min(parseInt(req.query.limit) || 3, 200);
  const includeFull = req.query.include_full === '1';

  const havingClause = includeFull
    ? ''
    : `HAVING (COALESCE(ts.max_capacity, st.max_capacity)) - COALESCE(SUM(CASE WHEN b.status != 'cancelled' AND (b.hold_until IS NULL OR b.hold_until > NOW()) THEN b.group_size ELSE 0 END), 0) > 0`;

  const { rows: slots } = await getPool().query(`
    SELECT ts.id, ts.session_type_id, ts.date, ts.start_time, ts.end_time,
           ts.max_capacity, ts.is_cancelled, ts.is_private, ts.artist,
           st.name         AS session_name,
           COALESCE(ts.price_cents, st.price_cents)  AS price_cents,
           st.color        AS color,
           st.duration_min AS duration_min,
           st.id           AS type_id,
           st.max_capacity AS type_capacity,
           COALESCE(SUM(CASE WHEN b.status != 'cancelled' AND (b.hold_until IS NULL OR b.hold_until > NOW()) THEN b.group_size ELSE 0 END), 0)::int AS booked
    FROM time_slots ts
    JOIN session_types st ON st.id = ts.session_type_id
    LEFT JOIN bookings b ON b.time_slot_id = ts.id
    WHERE ts.is_cancelled = FALSE AND ts.is_private = FALSE
      -- date/start_time zijn VARCHAR; vergelijk als timestamp in NL-tijd (server draait in UTC)
      AND (ts.date::text || ' ' || ts.start_time)::timestamp > NOW() AT TIME ZONE 'Europe/Amsterdam'
    GROUP BY ts.id, st.name, st.price_cents, st.color, st.duration_min, st.id, st.max_capacity
    ${havingClause}
    ORDER BY ts.date ASC, ts.start_time ASC
    LIMIT $1
  `, [limit]);

  res.json(slots.map(s => ({
    ...s,
    capacity:   s.max_capacity || s.type_capacity,
    spots_left: (s.max_capacity || s.type_capacity) - s.booked,
  })));
});

// Single slot detail (veld-whitelist: geen interne notities e.d. naar buiten)
app.get('/api/slots/:id', async (req, res) => {
  const slotId = parseInt(req.params.id);
  if (isNaN(slotId)) return res.status(400).json({ error: 'Invalid slot id' });
  const slot = await queries.getSlotById(slotId);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  const capacity  = slot.max_capacity || slot.type_capacity;
  const spotsLeft = capacity - slot.booked;
  res.json({
    id:              slot.id,
    session_type_id: slot.session_type_id,
    type_id:         slot.type_id ?? slot.session_type_id,
    session_name:    slot.session_name,
    date:            slot.date,
    start_time:      slot.start_time,
    end_time:        slot.end_time,
    duration_min:    slot.duration_min,
    color:           slot.color,
    price_cents:     slot.price_cents,
    artist:          slot.artist || null,
    is_private:      slot.is_private,
    is_cancelled:    slot.is_cancelled,
    capacity,
    spots_left: spotsLeft,
    is_full:    spotsLeft <= 0,
  });
});

// ─── QR Check-in ──────────────────────────────────────────────────────────────
const crypto = require('crypto');
// QR/deellink-sleutels: eigen secret-basis zodat een JWT_SECRET-rotatie niet
// alle geprinte QR-links stuk maakt. Zonder KANTINE_KEY_SECRET verandert er niets.
const LINK_KEY_BASE = process.env.KANTINE_KEY_SECRET || process.env.JWT_SECRET || 'dev_secret_change_me';
function checkinSig(bookingId) {
  return crypto.createHmac('sha256', LINK_KEY_BASE)
    .update(String(bookingId)).digest('hex').slice(0, 16);
}
function validCheckinSig(sig, bookingId) {
  const expected = checkinSig(bookingId);
  const provided = String(sig || '');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

// ─── Combi-deal Kantine: permanente deelbare kokspagina ───────────────────
// Sleutel is afgeleid van LINK_KEY_BASE, dus de link blijft altijd geldig
// zonder extra configuratie.
function kantineKey() {
  return crypto.createHmac('sha256', LINK_KEY_BASE)
    .update('kantine-combi-view').digest('hex').slice(0, 32);
}
function validKantineKey(key) {
  const expected = kantineKey();
  const provided = String(key || '');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

app.get('/api/kantine/combi', async (req, res) => {
  if (!validKantineKey(req.query.key))
    return res.status(403).json({ error: 'Ongeldige link' });
  const stats = await queries.getKantineCombiStats();
  res.json(stats);
});

// AVG-minimale ticketscan voor Kantine: alleen geldigheid, datum en aantal
// diners — géén naam of e-mail. Vereist de kantinesleutel én de handtekening
// uit de QR-code van het ticket.
function kantineScanInfo(booking) {
  const combi = (booking.kantine_addon_cents || 0) > 0;
  return {
    id:           booking.id,
    date:         booking.date,
    start_time:   booking.start_time,
    end_time:     booking.end_time,
    session_name: booking.session_name,
    status:       booking.status,
    combi,
    diners:       combi ? booking.group_size : 0,
    redeemed_at:  booking.kantine_redeemed_at || null,
  };
}

app.get('/api/kantine/scan/:bookingId', async (req, res) => {
  if (!validKantineKey(req.query.key))
    return res.status(403).json({ error: 'Ongeldige link' });
  const { bookingId } = req.params;
  if (!validCheckinSig(req.query.sig, bookingId))
    return res.status(403).json({ error: 'Ongeldige QR-code' });
  const booking = await queries.getBookingById(bookingId);
  if (!booking) return res.status(404).json({ error: 'Boeking niet gevonden' });
  res.json(kantineScanInfo(booking));
});

app.post('/api/kantine/redeem/:bookingId', async (req, res) => {
  if (!validKantineKey(req.query.key))
    return res.status(403).json({ error: 'Ongeldige link' });
  const { bookingId } = req.params;
  if (!validCheckinSig(req.query.sig, bookingId))
    return res.status(403).json({ error: 'Ongeldige QR-code' });
  const booking = await queries.getBookingById(bookingId);
  if (!booking) return res.status(404).json({ error: 'Boeking niet gevonden' });
  if (booking.status !== 'confirmed')
    return res.status(400).json({ error: 'Boeking is niet bevestigd', ...kantineScanInfo(booking) });
  if ((booking.kantine_addon_cents || 0) === 0)
    return res.status(400).json({ error: 'Geen combi-deal bij deze boeking', ...kantineScanInfo(booking) });
  const result = await queries.redeemKantineBooking(bookingId);
  if (!result)
    return res.status(409).json({ error: 'Al verzilverd', already_redeemed: true, ...kantineScanInfo(booking) });
  res.json({ redeemed: true, ...kantineScanInfo({ ...booking, kantine_redeemed_at: result.kantine_redeemed_at }) });
});

app.get('/api/checkin/:bookingId', async (req, res) => {
  const { bookingId } = req.params;
  const { sig } = req.query;
  if (!validCheckinSig(sig, bookingId))
    return res.status(403).json({ error: 'Invalid check-in link' });

  const booking = await queries.getBookingById(bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'confirmed') return res.status(400).json({ error: 'Booking is not confirmed', status: booking.status });

  const checkinUrl = `${process.env.BASE_URL || 'http://localhost:3001'}/checkin?bid=${bookingId}&sig=${sig}`;
  const QRCode = require('qrcode');
  const qr_data_url = await QRCode.toDataURL(checkinUrl, {
    width: 200, margin: 1,
    color: { dark: '#4A1C0C', light: '#ffffff' },
  });

  res.json({
    id:            booking.id,
    customer_name: booking.customer_name,
    session_name:  booking.session_name,
    date:          booking.date,
    start_time:    booking.start_time,
    end_time:      booking.end_time,
    group_size:    booking.group_size,
    kantine_addon_cents: booking.kantine_addon_cents || 0,
    checked_in:    booking.checked_in,
    qr_data_url,
  });
});

async function isStaffOrAdminRequest(req) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return false;
  let payload;
  try {
    payload = require('jsonwebtoken').verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
  } catch { return false; }
  try {
    // Revocatiecheck tegen de DB, net als requireAdmin/requireStaff: een
    // gebumpte token_version (wachtwoordreset/deactivatie) telt hier ook.
    if (payload.type === 'admin') {
      const v = await queries.getAdminTokenVersion(payload.adminId);
      return v !== null && (payload.tv || 0) === v;
    }
    if (payload.type === 'staff') {
      const staff = await queries.getStaffById(payload.staffId);
      return !!staff && staff.is_active && (payload.tv || 0) === (staff.token_version || 0);
    }
  } catch { return false; }
  return false;
}

app.post('/api/checkin/:bookingId', async (req, res) => {
  const { bookingId } = req.params;
  const { sig } = req.query;
  if (!validCheckinSig(sig, bookingId))
    return res.status(403).json({ error: 'Invalid check-in link' });

  const booking = await queries.getBookingById(bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'confirmed')
    return res.status(400).json({ error: 'Booking is not confirmed', status: booking.status });

  // Via QR-link alleen op de sessiedag zelf inchecken (voorkomt dat gasten
  // zichzelf weken vooraf "aanwezig" melden); staff mag altijd.
  const todayNL = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date());
  if (String(booking.date).slice(0, 10) !== todayNL && !(await isStaffOrAdminRequest(req)))
    return res.status(403).json({ error: 'Inchecken kan alleen op de dag van de sessie zelf.' });

  await queries.checkInBooking(bookingId, true);

  // Check for milestone after check-in
  // Milestones staan tijdelijk uit; bezoeken tellen gewoon door via bookings.
  // Zet MILESTONES_ENABLED op true om het weer aan te zetten.
  const MILESTONES_ENABLED = false;
  if (MILESTONES_ENABLED) try {
    const { getMilestoneForVisit, generatePromoCode } = require('./utils/milestones');
    const { sendMilestoneEmail } = require('./utils/email');

    const visitCount = await queries.getUserVisitCount(booking.user_id);
    const milestone  = getMilestoneForVisit(visitCount);

    if (milestone) {
      const promoCode = milestone.code_prefix ? generatePromoCode(milestone.code_prefix, booking.user_id) : null;
      const claimed   = await queries.claimMilestone(booking.user_id, milestone.visits, promoCode);
      if (claimed) {
        milestone.promo_code = promoCode || undefined;
        await sendMilestoneEmail({
          customer_name:  booking.customer_name,
          customer_email: booking.customer_email,
          milestone,
          lang: 'nl',
        });
      }
    }
  } catch (mErr) {
    console.error('Milestone check error (non-fatal):', mErr.message);
  }

  res.json({ ok: true });
});

app.get('/api/milestones', require('./routes/auth').requireAuth, async (req, res) => {
  const { getUserMilestoneStats, getClaimedMilestones } = queries;
  const { MILESTONES, getNextMilestone } = require('./utils/milestones');

  const stats    = await getUserMilestoneStats(req.user.userId);
  const claimed  = await getClaimedMilestones(req.user.userId);
  const next     = getNextMilestone(stats.total_visits);

  res.json({
    total_visits:   stats.total_visits,
    total_bookings: stats.total_bookings,
    milestones:     MILESTONES,
    claimed,
    next_milestone: next,
  });
});

// ─── Waitlist (Brevo) ─────────────────────────────────────────────────────────
app.post('/api/waitlist', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  try {
    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key':      process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body: JSON.stringify({
        email,
        listIds:        [parseInt(process.env.BREVO_LIST_ID || '3')],
        updateEnabled:  true,
      }),
    });
    if (response.status === 201 || response.status === 204) {
      return res.json({ ok: true });
    }
    const data = await response.json().catch(() => ({}));
    // Brevo returns 400 with code "duplicate_parameter" if already subscribed — treat as success
    if (data.code === 'duplicate_parameter') {
      return res.json({ ok: true });
    }
    console.error('[Brevo]', response.status, data);
    return res.status(500).json({ error: 'Could not save your email. Please try again.' });
  } catch (err) {
    console.error('[Brevo] fetch error:', err.message);
    return res.status(500).json({ error: 'Could not save your email. Please try again.' });
  }
});

// ─── Page routes ─────────────────────────────────────────────────────────────
app.get('/login',           (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')))
app.get('/payment-return', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'payment-return.html')))
app.get('/reset-password', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/booking', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'booking.html')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, '..', 'privacy.html')));
app.get('/terms',   (_req, res) => res.sendFile(path.join(__dirname, '..', 'terms.html')));
app.get('/cookies', (_req, res) => res.sendFile(path.join(__dirname, '..', 'cookies.html')));
app.get('/account', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));
app.get('/membership', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'membership.html')));
app.get('/checkin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
app.get('/ticket',  (_req, res) => res.sendFile(path.join(__dirname, 'public', 'ticket.html')));
app.get('/waiver',      (_req, res) => res.sendFile(path.join(__dirname, 'public', 'waiver.html')));
app.get('/gift-card',  (_req, res) => res.sendFile(path.join(__dirname, 'public', 'gift-card.html')));
app.get('/kantine', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'kantine.html')));
app.get('/admin',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/admin/*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

// ─── Global error handling ───────────────────────────────────────────────────
// Vangt alle route-fouten (incl. async, via utils/async-errors) — server blijft draaien
app.use((err, _req, res, _next) => {
  console.error('Unhandled route error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Er ging iets mis. Probeer het opnieuw. / Something went wrong. Please try again.' });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// ─── Start ────────────────────────────────────────────────────────────────────
initializeDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🔥 Soki booking server running on http://localhost:${PORT}`);
    console.log(`   Booking:  http://localhost:${PORT}/booking`);
    console.log(`   Account:  http://localhost:${PORT}/account`);
    console.log(`   Admin:    http://localhost:${PORT}/admin\n`);
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});

// ─── Reminder cron (runs every hour) ─────────────────────────────────────────
setInterval(async () => {
  try {
    const bookings = await queries.getBookingsNeedingReminder();
    for (const booking of bookings) {
      try {
        await sendReminderEmail(booking);
        await queries.markReminderSent(booking.id);
        console.log(`✓ Reminder sent: booking #${booking.id}`);
      } catch (err) {
        console.error(`Reminder failed for booking #${booking.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Reminder cron error:', err.message);
  }
}, 60 * 60 * 1000); // every hour

// ─── Bedankmail na eerste bezoek (runs every hour) ───────────────────────────
// Verstuurt 1 dag na iemands állereerste check-in een bedankmail met reviewvraag.
// Alleen tussen 10:00 en 21:00 NL-tijd; de vlag first_visit_thanks_sent voorkomt dubbelen.
setInterval(async () => {
  try {
    const hourNL = Number(new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: 'numeric', hour12: false }).format(new Date()));
    if (hourNL < 10 || hourNL >= 21) return;

    const users = await queries.getUsersNeedingFirstVisitThanks();
    for (const user of users) {
      try {
        const { sendFirstVisitThanksEmail } = require('./utils/email');
        await sendFirstVisitThanksEmail(user);
        await queries.markFirstVisitThanksSent(user.id);
        console.log(`✓ First-visit thanks sent: user #${user.id}`);
      } catch (err) {
        console.error(`First-visit thanks failed for user #${user.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('First-visit thanks cron error:', err.message);
  }
}, 60 * 60 * 1000); // every hour

// ─── Pending booking cleanup (runs every 15 minutes) ─────────────────────────
setInterval(async () => {
  try {
    const { rowCount } = await getPool().query(`
      UPDATE bookings SET status = 'cancelled'
      WHERE status = 'pending'
        AND created_at < NOW() - INTERVAL '1 hour'
    `);
    if (rowCount > 0) console.log(`✓ Cleaned up ${rowCount} expired pending booking(s)`);
  } catch (err) {
    console.error('Pending cleanup error:', err.message);
  }
}, 15 * 60 * 1000); // every 15 minutes

// ─── Walk-in hold cleanup (runs every minute) ────────────────────────────────
setInterval(async () => {
  try {
    const cancelled = await queries.expireStaleHolds();
    if (cancelled > 0) console.log(`✓ Expired ${cancelled} walk-in hold(s)`);
  } catch (err) {
    console.error('Hold cleanup error:', err.message);
  }
}, 60 * 1000); // every minute
