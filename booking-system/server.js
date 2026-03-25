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
const webhookRoutes       = require('./routes/webhooks');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────
// Webhook route must come before express.json() — Stripe needs the raw body
app.use('/api/webhooks', webhookRoutes);

app.use(cors());
app.use(express.json());

// Rate limiting on auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth/login',         authLimiter);
app.use('/api/auth/register',      authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/api/admin/login',        rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));

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

// ─── Page routes ─────────────────────────────────────────────────────────────
app.get('/login',           (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')))
app.get('/payment-return', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'payment-return.html')))
app.get('/reset-password', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/booking', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'booking.html')));
app.get('/account', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));
app.get('/membership', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'membership.html')));
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
