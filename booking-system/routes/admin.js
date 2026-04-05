/**
 * routes/admin.js
 * Admin-only routes: auth, bookings management, slot management, analytics.
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { queries } = require('../db/database');
const { sendWaitlistNotification, sendAutoBookedEmail } = require('../utils/email');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

// ─── Admin auth middleware ────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Admin authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'admin') throw new Error('Not an admin token');
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

// ─── Staff auth middleware ─────────────────────────────────────────────────────

function requireStaff(perm) {
  return function(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.type === 'admin') { req.admin = payload; return next(); }
      if (payload.type === 'staff') {
        if (!payload.is_active) return res.status(403).json({ error: 'Account deactivated' });
        if (perm && !payload.permissions.includes(perm))
          return res.status(403).json({ error: 'Permission denied' });
        req.staff = payload;
        return next();
      }
      throw new Error('Invalid token type');
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

// ─── Admin login ──────────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email and password are required' });

  const admin = await queries.getAdminByEmail(email);
  if (admin) {
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ adminId: admin.id, type: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
    return res.json({ token, type: 'admin' });
  }

  const staff = await queries.getStaffByEmail(email);
  if (!staff) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, staff.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  if (!staff.is_active) return res.status(403).json({ error: 'Account deactivated' });

  const permKeys = ['revenue','bookings','slots','generate','schedule','customers','messages'];
  const permissions = permKeys.filter(k => staff['perm_' + k]);
  const token = jwt.sign(
    { staffId: staff.id, type: 'staff', name: staff.name, email: staff.email, is_active: staff.is_active, permissions },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
  res.json({ token, type: 'staff', permissions });
});

// ─── Bookings ────────────────────────────────────────────────────────────────

router.get('/bookings', requireStaff('bookings'), async (req, res) => {
  const bookings = await queries.getAllBookings(req.query);
  res.json(bookings);
});

// ─── CSV export ──────────────────────────────────────────────────────────────

router.get('/bookings/export.csv', requireStaff('bookings'), async (req, res) => {
  const bookings = await queries.getAllBookings(req.query);

  const header = 'id,customer_name,customer_email,session_name,date,start_time,end_time,group_size,total_euros,status,created_at\n';
  const rows   = bookings.map(b => [
    b.id,
    `"${b.customer_name}"`,
    b.customer_email,
    `"${b.session_name}"`,
    b.date,
    b.start_time,
    b.end_time,
    b.group_size,
    (b.total_cents / 100).toFixed(2),
    b.status,
    b.created_at,
  ].join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="soki-bookings.csv"');
  res.send(header + rows);
});

router.get('/bookings/:id', requireAdmin, async (req, res) => {
  const booking = await queries.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  res.json(booking);
});

router.patch('/bookings/:id/cancel', requireAdmin, async (req, res) => {
  const booking = await queries.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  let refunded = false;
  if (booking.stripe_payment_intent_id && booking.stripe_payment_status === 'succeeded') {
    try {
      await stripe.refunds.create({ payment_intent: booking.stripe_payment_intent_id });
      refunded = true;
    } catch (stripeErr) {
      console.error('Stripe refund failed (non-fatal):', stripeErr.message);
    }
  }

  await queries.cancelBooking(req.params.id);

  // Auto-book first paid waitlist user, then fall back to notifying unpaid ones
  try {
    const paidWaiter = await queries.getFirstPaidWaitlistUser(booking.time_slot_id);
    if (paidWaiter) {
      const newBooking = await queries.createBooking(
        paidWaiter.user_id, booking.time_slot_id, paidWaiter.group_size, paidWaiter.total_cents
      );
      const pool = require('../db/database').getPool();
      await pool.query(
        "UPDATE bookings SET status = 'confirmed', stripe_payment_intent_id = $2, stripe_payment_status = 'succeeded', confirmation_sent = TRUE WHERE id = $1",
        [newBooking.id, paidWaiter.stripe_payment_intent_id]
      );
      await queries.claimWaitlistEntry(paidWaiter.id, newBooking.id);
      const fullBooking = await queries.getBookingById(newBooking.id);
      await sendAutoBookedEmail(fullBooking);
      console.log(`✓ Auto-booked waitlist user ${paidWaiter.user_id} into booking #${newBooking.id}`);
    } else {
      const waitUser = await queries.getFirstUnnotifiedWaitlistUser(booking.time_slot_id);
      if (waitUser) {
        await sendWaitlistNotification({
          customer_name:  waitUser.customer_name,
          customer_email: waitUser.customer_email,
          session_name:   booking.session_name,
          date:           booking.date,
          start_time:     booking.start_time,
          end_time:       booking.end_time,
          slot_id:        booking.time_slot_id,
        });
        await queries.markWaitlistNotified(waitUser.id);
      }
    }
  } catch (wErr) {
    console.error('Waitlist auto-book error (non-fatal):', wErr.message);
  }

  res.json({ ok: true, refunded });
});

// ─── Slots ───────────────────────────────────────────────────────────────────

router.get('/slots', requireStaff('slots'), async (req, res) => {
  const slots = await queries.getAllSlots(req.query);
  res.json(slots);
});

router.post('/slots/bulk', requireAdmin, async (req, res) => {
  const { slots } = req.body;
  if (!Array.isArray(slots) || !slots.length)
    return res.status(400).json({ error: 'slots array is required' });

  const results = { created: 0, skipped: 0, errors: [] };
  for (const s of slots) {
    try {
      await queries.createSlot(s.session_type_id, s.date, s.start_time, s.end_time, s.max_capacity || null, s.notes || null);
      results.created++;
    } catch (err) {
      results.skipped++;
      results.errors.push(`${s.date} ${s.start_time}: ${err.message}`);
    }
  }
  res.json(results);
});

router.post('/slots', requireAdmin, async (req, res) => {
  const { session_type_id, date, start_time, end_time, max_capacity, notes } = req.body;
  if (!session_type_id || !date || !start_time || !end_time)
    return res.status(400).json({ error: 'session_type_id, date, start_time, end_time are required' });

  const slot = await queries.createSlot(session_type_id, date, start_time, end_time, max_capacity, notes);
  res.status(201).json({ id: slot.id });
});

router.put('/slots/:id', requireAdmin, async (req, res) => {
  const { date, start_time, end_time, max_capacity, notes } = req.body;
  if (!date || !start_time || !end_time)
    return res.status(400).json({ error: 'date, start_time, end_time are required' });

  await queries.updateSlot(req.params.id, { date, start_time, end_time, max_capacity, notes });
  res.json({ ok: true });
});

router.delete('/slots/:id', requireAdmin, async (req, res) => {
  await queries.cancelSlot(req.params.id);
  res.json({ ok: true });
});

// ─── Session types ────────────────────────────────────────────────────────────

router.get('/session-types', requireAdmin, async (req, res) => {
  const types = await queries.getAllSessionTypes();
  res.json(types);
});

// ─── Analytics ────────────────────────────────────────────────────────────────

router.get('/analytics', requireStaff('revenue'), async (req, res) => {
  const data = await queries.getAnalytics();
  res.json(data);
});

// ─── Schedule ────────────────────────────────────────────────────────────

router.get('/schedule', requireStaff('schedule'), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = await queries.getScheduleByDate(date);
  res.json(rows);
});

router.patch('/bookings/:id/checkin', requireStaff('schedule'), async (req, res) => {
  const { checked_in } = req.body;
  await queries.checkInBooking(req.params.id, !!checked_in);
  res.json({ ok: true });
});

// ─── Customers ───────────────────────────────────────────────────────────

router.get('/customers', requireStaff('customers'), async (req, res) => {
  const users = await queries.getAllUsers();
  res.json(users);
});

router.get('/customers/:id', requireStaff('customers'), async (req, res) => {
  const bookings = await queries.getUserBookings(req.params.id);
  res.json(bookings);
});

router.patch('/customers/:id/notes', requireAdmin, async (req, res) => {
  const { notes } = req.body;
  await queries.updateUserAdminNotes(req.params.id, notes ?? null);
  res.json({ ok: true });
});

// ─── Messages ─────────────────────────────────────────────────────────────────

// GET /api/admin/messages
router.get('/messages', requireStaff('messages'), async (req, res) => {
  const msgs = await queries.getAllMessages();
  res.json(msgs);
});

// GET /api/admin/messages/unread-count
router.get('/messages/unread-count', requireAdmin, async (req, res) => {
  const count = await queries.getUnreadMessageCount();
  res.json({ count });
});

// PATCH /api/admin/messages/:id/read
router.patch('/messages/:id/read', requireStaff('messages'), async (req, res) => {
  await queries.markMessageRead(req.params.id);
  res.json({ ok: true });
});

// POST /api/admin/messages/:id/reply
router.post('/messages/:id/reply', requireStaff('messages'), async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'body is required' });

  const message = await queries.getMessageById(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found' });

  const reply = await queries.replyToMessage(req.params.id, body.trim(), true);

  // Send reply email to customer (non-fatal)
  try {
    const { sendMessageReply } = require('../utils/email');
    await sendMessageReply({
      customer_name:    message.user_name,
      customer_email:   message.user_email,
      original_subject: message.subject,
      original_body:    message.body,
      reply_body:       body.trim(),
    });
  } catch (e) { console.error('Reply email failed:', e.message); }

  res.status(201).json(reply);
});

// ─── Enhanced Analytics ──────────────────────────────────────────────────────

router.get('/analytics/enhanced', requireStaff('revenue'), async (req, res) => {
  try {
  const { getPool } = require('../db/database');
  const pool = getPool();

  const [
    revenuePerWeek,
    occupancy,
    peakDays,
    customerRetention,
    forwardView,
    subscriptionMRR,
    cancellationRate,
    revenuePerMonth,
  ] = await Promise.all([

    // 1. Weekly revenue for last 12 weeks (confirmed bookings only)
    pool.query(`
      SELECT
        TO_CHAR(ts.date::date, 'IYYY-"W"IW') AS week,
        COALESCE(SUM(b.total_cents), 0)::int AS revenue_cents,
        COUNT(b.id)::int AS bookings
      FROM bookings b
      JOIN time_slots ts ON ts.id = b.time_slot_id
      WHERE b.status = 'confirmed'
        AND ts.date >= TO_CHAR(CURRENT_DATE - INTERVAL '11 weeks', 'YYYY-MM-DD')
      GROUP BY week
      ORDER BY week
    `),

    // 2. Occupancy rate per session type (last 30 days)
    pool.query(`
      SELECT
        st.name,
        st.color,
        COUNT(DISTINCT ts.id)::int AS total_slots,
        COALESCE(SUM(COALESCE(ts.max_capacity, st.max_capacity)), 0)::int AS total_capacity,
        COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.group_size ELSE 0 END), 0)::int AS booked
      FROM session_types st
      LEFT JOIN time_slots ts ON ts.session_type_id = st.id
        AND ts.date >= TO_CHAR(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')
        AND ts.date <= TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')
        AND ts.is_cancelled = FALSE
      LEFT JOIN bookings b ON b.time_slot_id = ts.id
      WHERE st.is_active = TRUE
      GROUP BY st.id, st.name, st.color
      ORDER BY st.price_cents
    `),

    // 3. Peak days heatmap — bookings by day-of-week and hour
    pool.query(`
      SELECT
        EXTRACT(DOW FROM ts.date::date)::int AS dow,
        SUBSTRING(ts.start_time, 1, 2)::int AS hour,
        COUNT(b.id)::int AS bookings
      FROM bookings b
      JOIN time_slots ts ON ts.id = b.time_slot_id
      WHERE b.status != 'cancelled'
        AND ts.date >= TO_CHAR(CURRENT_DATE - INTERVAL '90 days', 'YYYY-MM-DD')
      GROUP BY dow, hour
      ORDER BY dow, hour
    `),

    // 4. New vs returning customers per month (last 6 months)
    pool.query(`
      WITH first_bookings AS (
        SELECT user_id, MIN(created_at) AS first_booking_at
        FROM bookings WHERE status != 'cancelled'
        GROUP BY user_id
      ),
      monthly AS (
        SELECT
          TO_CHAR(DATE_TRUNC('month', b.created_at), 'YYYY-MM') AS month,
          b.user_id,
          CASE WHEN DATE_TRUNC('month', b.created_at) = DATE_TRUNC('month', fb.first_booking_at)
               THEN 'new' ELSE 'returning' END AS customer_type
        FROM bookings b
        JOIN first_bookings fb ON fb.user_id = b.user_id
        WHERE b.status != 'cancelled'
          AND b.created_at >= CURRENT_DATE - INTERVAL '6 months'
      )
      SELECT
        month,
        COUNT(*) FILTER (WHERE customer_type = 'new')::int AS new_customers,
        COUNT(*) FILTER (WHERE customer_type = 'returning')::int AS returning_customers
      FROM monthly
      GROUP BY month
      ORDER BY month
    `),

    // 5. Forward view — next 14 days slots with fill rate
    pool.query(`
      SELECT
        ts.date,
        ts.start_time,
        ts.end_time,
        st.name AS session_name,
        st.color,
        COALESCE(ts.max_capacity, st.max_capacity) AS capacity,
        COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.group_size ELSE 0 END), 0)::int AS booked
      FROM time_slots ts
      JOIN session_types st ON st.id = ts.session_type_id
      LEFT JOIN bookings b ON b.time_slot_id = ts.id
      WHERE ts.date >= TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')
        AND ts.date <= TO_CHAR(CURRENT_DATE + INTERVAL '13 days', 'YYYY-MM-DD')
        AND ts.is_cancelled = FALSE
      GROUP BY ts.id, ts.date, ts.start_time, ts.end_time, st.name, st.color, ts.max_capacity, st.max_capacity
      ORDER BY ts.date, ts.start_time
    `),

    // 6. Subscription MRR + active member counts
    pool.query(`
      SELECT
        p.name AS plan_name,
        p.price_cents,
        p.credits_per_month,
        COUNT(s.id)::int AS active_count
      FROM subscription_plans p
      LEFT JOIN subscriptions s ON s.plan_id = p.id AND s.status = 'active'
      GROUP BY p.id, p.name, p.price_cents, p.credits_per_month
      ORDER BY p.price_cents
    `),

    // 7. Cancellation rate per month (last 6 months)
    pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', b.created_at), 'YYYY-MM') AS month,
        COUNT(*) FILTER (WHERE b.status = 'cancelled')::int AS cancelled,
        COUNT(*)::int AS total
      FROM bookings b
      WHERE b.created_at >= CURRENT_DATE - INTERVAL '6 months'
      GROUP BY month
      ORDER BY month
    `),

    // 8. Monthly revenue for last 12 months
    pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', ts.date::date), 'YYYY-MM') AS month,
        COALESCE(SUM(b.total_cents), 0)::int AS revenue_cents,
        COUNT(b.id)::int AS bookings
      FROM bookings b
      JOIN time_slots ts ON ts.id = b.time_slot_id
      WHERE b.status = 'confirmed'
        AND ts.date >= TO_CHAR(DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months'), 'YYYY-MM-DD')
        AND ts.date < TO_CHAR(DATE_TRUNC('month', CURRENT_DATE + INTERVAL '1 month'), 'YYYY-MM-DD')
      GROUP BY month
      ORDER BY month
    `),
  ]);

  // Compute MRR
  const mrr = subscriptionMRR.rows.reduce((sum, p) => sum + (p.price_cents * p.active_count), 0);

  // Compute current month projection
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const currentEntry = revenuePerMonth.rows.find(r => r.month === currentMonth);
  const daysElapsed = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const currentMonthProjection = currentEntry && daysElapsed > 0
    ? Math.round(currentEntry.revenue_cents / daysElapsed * daysInMonth)
    : 0;

  res.json({
    revenuePerWeek:    revenuePerWeek.rows,
    occupancy:         occupancy.rows,
    peakDays:          peakDays.rows,
    customerRetention: customerRetention.rows,
    forwardView:       forwardView.rows,
    subscriptionPlans: subscriptionMRR.rows,
    mrr,
    cancellationRate:  cancellationRate.rows,
    revenuePerMonth:   revenuePerMonth.rows,
    currentMonthProjection,
  });
  } catch (err) {
    console.error('Enhanced analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GDPR ─────────────────────────────────────────────────────────────────────

// DELETE /api/admin/customers/:id — anonymise user PII (GDPR erasure)
router.delete('/customers/:id', requireAdmin, async (req, res) => {
  await queries.deleteUser(req.params.id);
  res.json({ ok: true });
});

// ─── Waitlist ─────────────────────────────────────────────────────────────────

router.get('/waitlist/:slotId', requireStaff('schedule'), async (req, res) => {
  const list = await queries.getWaitlistForSlot(req.params.slotId);
  res.json(list);
});

// ─── Staff management (admin only) ───────────────────────────────────────────

router.get('/staff', requireAdmin, async (req, res) => {
  const staff = await queries.getAllStaff();
  res.json(staff);
});

router.post('/staff', requireAdmin, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email, and password are required' });

  const existing = await queries.getStaffByEmail(email);
  if (existing) return res.status(409).json({ error: 'Email already in use' });

  const passwordHash = await bcrypt.hash(password, 12);
  const staff = await queries.createStaff(name, email, passwordHash);
  res.status(201).json(staff);
});

router.patch('/staff/:id', requireAdmin, async (req, res) => {
  const { is_active, perm_revenue, perm_bookings, perm_slots, perm_generate, perm_schedule, perm_customers, perm_messages } = req.body;
  await queries.updateStaffPermissions(req.params.id, {
    is_active, perm_revenue, perm_bookings, perm_slots, perm_generate, perm_schedule, perm_customers, perm_messages,
  });
  res.json({ ok: true });
});

router.post('/staff/:id/reset-password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password is required' });

  const passwordHash = await bcrypt.hash(password, 12);
  await queries.updateStaffPassword(req.params.id, passwordHash);
  res.json({ ok: true });
});

router.post('/staff/change-own-password', requireStaff(null), async (req, res) => {
  if (!req.staff) return res.status(403).json({ error: 'Only staff members can change their own password' });

  const { old_password, new_password } = req.body;
  if (!old_password || !new_password)
    return res.status(400).json({ error: 'old_password and new_password are required' });

  const staff = await queries.getStaffById(req.staff.staffId);
  if (!staff) return res.status(404).json({ error: 'Staff not found' });

  const valid = await bcrypt.compare(old_password, staff.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const passwordHash = await bcrypt.hash(new_password, 12);
  await queries.updateStaffPassword(staff.id, passwordHash);
  res.json({ ok: true });
});

module.exports = router;
module.exports.requireAdmin = requireAdmin;
