/**
 * server.js
 * Main Express server for Soki booking system.
 * Run: node server.js (or npm run dev for auto-reload)
 */

require('dotenv').config();
const express   = require('express');
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

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────
// Webhook route must come before express.json() — Stripe needs the raw body
app.use('/api/webhooks', webhookRoutes);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

const allowedOrigin = process.env.BASE_URL || 'http://localhost:3001';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

// Rate limiting on auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth/login',         authLimiter);
app.use('/api/auth/register',      authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/api/admin/login',        rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false }));
app.use('/api/bookings', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }));

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

// Public config (non-secret values for frontend)
app.get('/api/config', (_req, res) => {
  res.json({
    sanityProjectId:  process.env.SANITY_PROJECT_ID  || '',
    sanityDataset:    process.env.SANITY_DATASET      || 'production',
    googleClientId:   process.env.GOOGLE_CLIENT_ID    || '',
    baseUrl:          process.env.BASE_URL            || 'http://localhost:3001',
  });
});

// Session types (public read)
app.get('/api/session-types', async (req, res) => {
  res.json(await queries.getSessionTypes());
});

// Available slots for a session type + month
app.get('/api/slots', async (req, res) => {
  const { session_type_id, year, month } = req.query;
  if (!session_type_id || !year || !month)
    return res.status(400).json({ error: 'session_type_id, year and month are required' });

  const slots = await queries.getSlotsForMonth(
    parseInt(session_type_id),
    parseInt(year),
    parseInt(month)
  );
  const result = slots.map(s => ({
    ...s,
    capacity:   s.max_capacity || s.type_capacity,
    spots_left: (s.max_capacity || s.type_capacity) - s.booked,
    is_full:    (s.max_capacity || s.type_capacity) - s.booked <= 0,
  }));
  res.json(result);
});

// Next N available slots (homepage widget)
app.get('/api/upcoming-slots', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 3, 10);
  const today = new Date().toISOString().slice(0, 10);

  const { rows: slots } = await getPool().query(`
    SELECT ts.*,
           st.name         AS session_name,
           st.price_cents  AS price_cents,
           st.color        AS color,
           st.duration_min AS duration_min,
           st.id           AS type_id,
           st.max_capacity AS type_capacity,
           COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.group_size ELSE 0 END), 0)::int AS booked
    FROM time_slots ts
    JOIN session_types st ON st.id = ts.session_type_id
    LEFT JOIN bookings b ON b.time_slot_id = ts.id
    WHERE ts.date >= $1 AND ts.is_cancelled = FALSE
    GROUP BY ts.id, st.name, st.price_cents, st.color, st.duration_min, st.id, st.max_capacity
    HAVING (COALESCE(ts.max_capacity, st.max_capacity)) - COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.group_size ELSE 0 END), 0) > 0
    ORDER BY ts.date ASC, ts.start_time ASC
    LIMIT $2
  `, [today, limit]);

  res.json(slots.map(s => ({
    ...s,
    capacity:   s.max_capacity || s.type_capacity,
    spots_left: (s.max_capacity || s.type_capacity) - s.booked,
  })));
});

// Single slot detail
app.get('/api/slots/:id', async (req, res) => {
  const slot = await queries.getSlotById(req.params.id);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  const capacity  = slot.max_capacity || slot.type_capacity;
  const spotsLeft = capacity - slot.booked;
  res.json({ ...slot, capacity, spots_left: spotsLeft, is_full: spotsLeft <= 0 });
});

// ─── QR Check-in ──────────────────────────────────────────────────────────────
const crypto = require('crypto');
function checkinSig(bookingId) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev_secret_change_me')
    .update(String(bookingId)).digest('hex').slice(0, 16);
}

app.get('/api/checkin/:bookingId', async (req, res) => {
  const { bookingId } = req.params;
  const { sig } = req.query;
  if (!sig || sig !== checkinSig(bookingId))
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
    customer_email: booking.customer_email,
    session_name:  booking.session_name,
    date:          booking.date,
    start_time:    booking.start_time,
    end_time:      booking.end_time,
    group_size:    booking.group_size,
    checked_in:    booking.checked_in,
    qr_data_url,
  });
});

app.post('/api/checkin/:bookingId', async (req, res) => {
  const { bookingId } = req.params;
  const { sig } = req.query;
  if (!sig || sig !== checkinSig(bookingId))
    return res.status(403).json({ error: 'Invalid check-in link' });

  const booking = await queries.getBookingById(bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  await queries.checkInBooking(bookingId, true);

  // Check for milestone after check-in
  try {
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

app.get('/api/milestones', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET || 'dev_secret_change_me');
    const { getUserMilestoneStats, getClaimedMilestones } = require('./db/database').queries;
    const { MILESTONES, getNextMilestone } = require('./utils/milestones');

    const stats    = await getUserMilestoneStats(decoded.userId);
    const claimed  = await getClaimedMilestones(decoded.userId);
    const next     = getNextMilestone(stats.total_visits);

    res.json({
      total_visits:   stats.total_visits,
      total_bookings: stats.total_bookings,
      milestones:     MILESTONES,
      claimed,
      next_milestone: next,
    });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
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
app.get('/account', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));
app.get('/membership', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'membership.html')));
app.get('/checkin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
app.get('/ticket',  (_req, res) => res.sendFile(path.join(__dirname, 'public', 'ticket.html')));
app.get('/waiver',      (_req, res) => res.sendFile(path.join(__dirname, 'public', 'waiver.html')));
app.get('/gift-card',  (_req, res) => res.sendFile(path.join(__dirname, 'public', 'gift-card.html')));
app.get('/admin',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/admin/*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

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
