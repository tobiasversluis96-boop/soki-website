/**
 * db/database.js
 * PostgreSQL database using node-postgres (pg).
 * Railway injects DATABASE_URL automatically when you add a Postgres plugin.
 */

const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);

// TLS: with DATABASE_CA_CERT set (PEM contents) the server certificate is fully
// verified; without it we still encrypt but can't verify the cert (Railway's
// internal proxy doesn't present a publicly-trusted certificate).
const sslConfig = process.env.DATABASE_CA_CERT
  ? { ca: process.env.DATABASE_CA_CERT, rejectUnauthorized: true }
  : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
});

function getPool() { return pool; }

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL      PRIMARY KEY,
    name          TEXT        NOT NULL,
    email         TEXT        UNIQUE NOT NULL,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id            SERIAL      PRIMARY KEY,
    email         TEXT        UNIQUE NOT NULL,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS session_types (
    id           SERIAL  PRIMARY KEY,
    name         TEXT    NOT NULL,
    description  TEXT,
    duration_min INTEGER NOT NULL,
    price_cents  INTEGER NOT NULL,
    max_capacity INTEGER NOT NULL DEFAULT 15,
    color        TEXT    DEFAULT '#D94D1A',
    is_active    BOOLEAN DEFAULT TRUE
  );

  CREATE TABLE IF NOT EXISTS time_slots (
    id              SERIAL      PRIMARY KEY,
    session_type_id INTEGER     NOT NULL REFERENCES session_types(id),
    date            VARCHAR(10) NOT NULL,
    start_time      VARCHAR(5)  NOT NULL,
    end_time        VARCHAR(5)  NOT NULL,
    max_capacity    INTEGER,
    is_cancelled    BOOLEAN     DEFAULT FALSE,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id                       SERIAL      PRIMARY KEY,
    user_id                  INTEGER     NOT NULL REFERENCES users(id),
    time_slot_id             INTEGER     NOT NULL REFERENCES time_slots(id),
    group_size               INTEGER     NOT NULL DEFAULT 1,
    status                   TEXT        DEFAULT 'pending',
    stripe_payment_intent_id TEXT,
    stripe_payment_status    TEXT,
    total_cents              INTEGER     NOT NULL,
    notes                    TEXT,
    confirmation_sent        BOOLEAN     DEFAULT FALSE,
    created_at               TIMESTAMPTZ DEFAULT NOW()
  );
`;

// ─── Seed data ────────────────────────────────────────────────────────────────

async function seedSessionTypes() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM session_types');
  if (rows[0].n > 0) return;

  const sql = `
    INSERT INTO session_types (name, description, duration_min, price_cents, max_capacity, color)
    VALUES ($1, $2, $3, $4, $5, $6)
  `;
  await pool.query(sql, ['Everyday Sauna',      'Free-flow access to our sauna and ice baths. Move at your own pace.',                        50,  1500,  15, '#C4704A']);
  await pool.query(sql, ['Social Sauna',         'Extended session with sauna, ice baths and unlimited lounge time.',                          80,  2000,  15, '#4A1C0C']);
  await pool.query(sql, ['Ambient Sauna',        'Sauna meets immersive DJ set. Cushions, low lighting, deep rest.',                           70,  2500,  12, '#D94D1A']);
  await pool.query(sql, ['Aufguss / Opgieting',  'Traditional ritual with essential oils, visualisation and salt scrub.',                      90,  2500,  10, '#6B2E18']);
}

async function seedTimeSlots() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM time_slots');
  if (rows[0].n > 0) return;

  const sql = `INSERT INTO time_slots (session_type_id, date, start_time, end_time) VALUES ($1, $2, $3, $4)`;
  const today = new Date();

  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function fmt(d)         { return d.toISOString().split('T')[0]; }

  for (let week = 0; week < 4; week++) {
    for (let wd = 3; wd <= 4; wd++) {
      const day = addDays(today, week * 7 + ((wd - today.getDay() + 7) % 7));
      if (day > today) {
        await pool.query(sql, [1, fmt(day), '16:00', '21:00']);
        await pool.query(sql, [1, fmt(day), '18:00', '21:00']);
        await pool.query(sql, [2, fmt(day), '16:00', '22:00']);
      }
    }
    for (let wd = 5; wd <= 6; wd++) {
      const day = addDays(today, week * 7 + ((wd - today.getDay() + 7) % 7));
      if (day > today) {
        await pool.query(sql, [2, fmt(day), '12:00', '14:30']);
        await pool.query(sql, [2, fmt(day), '15:00', '17:30']);
        await pool.query(sql, [3, fmt(day), '19:30', '22:00']);
        await pool.query(sql, [1, fmt(day), '12:00', '13:30']);
      }
    }
    const sun = addDays(today, week * 7 + ((0 - today.getDay() + 7) % 7) || 7);
    if (sun > today) {
      await pool.query(sql, [2, fmt(sun), '12:00', '14:30']);
      await pool.query(sql, [4, fmt(sun), '15:00', '17:00']);
      if (week % 2 === 0) await pool.query(sql, [3, fmt(sun), '15:00', '17:00']);
    }
  }
}

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || 'admin@sokisocialsauna.nl';

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM admin_users');
  if (rows[0].n > 0) {
    // Keep the admin password in sync with ADMIN_PASSWORD so it can be
    // changed from Railway without direct database access
    if (process.env.ADMIN_PASSWORD) {
      const { rows: admins } = await pool.query('SELECT id, password_hash FROM admin_users WHERE email = $1', [email]);
      const admin = admins[0];
      if (admin && !(await bcrypt.compare(process.env.ADMIN_PASSWORD, admin.password_hash))) {
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
        await pool.query('UPDATE admin_users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2', [hash, admin.id]);
        console.log('✓ Admin password updated from ADMIN_PASSWORD env var');
      }
    }
    return;
  }

  // Never seed a guessable default password in production
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
    console.error('✗ Admin NOT seeded: set ADMIN_PASSWORD env var (no default allowed in production)');
    return;
  }

  const password = process.env.ADMIN_PASSWORD || 'soki_admin_2024';
  const hash     = await bcrypt.hash(password, 12);
  await pool.query('INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)', [email, hash]);
  console.log(`✓ Admin seeded: ${email}`);
}

async function seedSubscriptionPlans() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM subscription_plans');
  if (rows[0].n > 0) return;

  // Create Everyday Member plan
  const prod1 = await stripe.products.create({ name: 'Soki Everyday Member' });
  const price1 = await stripe.prices.create({
    product: prod1.id,
    unit_amount: 4900,
    currency: 'eur',
    recurring: { interval: 'month' },
  });
  await pool.query(
    'INSERT INTO subscription_plans (name, credits_per_month, price_cents, stripe_price_id) VALUES ($1, $2, $3, $4)',
    ['Everyday Member', 4, 4900, price1.id]
  );

  // Create Unlimited plan
  const prod2 = await stripe.products.create({ name: 'Soki Unlimited Member' });
  const price2 = await stripe.prices.create({
    product: prod2.id,
    unit_amount: 9900,
    currency: 'eur',
    recurring: { interval: 'month' },
  });
  await pool.query(
    'INSERT INTO subscription_plans (name, credits_per_month, price_cents, stripe_price_id) VALUES ($1, $2, $3, $4)',
    ['Unlimited', null, 9900, price2.id]
  );

  console.log('✓ Subscription plans seeded');
}

// ─── Public init ──────────────────────────────────────────────────────────────

async function initializeDB() {
  await pool.query(SCHEMA);
  // Fix session type prices/durations if they were seeded with wrong values
  await pool.query(`UPDATE session_types SET duration_min=80, price_cents=2000 WHERE name='Social Sauna'`);
  await pool.query(`UPDATE session_types SET duration_min=90, price_cents=2500 WHERE name='Aufguss / Opgieting'`);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_notes TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT');
  await pool.query('ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL');
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in BOOLEAN DEFAULT FALSE');
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT FALSE');
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id          SERIAL      PRIMARY KEY,
    user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject     TEXT        NOT NULL,
    body        TEXT        NOT NULL,
    is_read     BOOLEAN     DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS message_replies (
    id          SERIAL      PRIMARY KEY,
    message_id  INTEGER     NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    body        TEXT        NOT NULL,
    from_admin  BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS waiver_signed_at TIMESTAMPTZ');

  // E-mailverificatie; bestaande accounts worden eenmalig als geverifieerd
  // gemarkeerd zodat alleen nieuwe registraties de code-flow doorlopen
  const { rows: evCol } = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email_verified_at'"
  );
  if (!evCol[0]) {
    await pool.query('ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ');
    await pool.query('UPDATE users SET email_verified_at = NOW()');
  }
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code_expires TIMESTAMPTZ');

  await pool.query(`CREATE TABLE IF NOT EXISTS waitlist (
    id           SERIAL      PRIMARY KEY,
    user_id      INTEGER     NOT NULL REFERENCES users(id),
    time_slot_id INTEGER     NOT NULL REFERENCES time_slots(id),
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    notified_at  TIMESTAMPTZ,
    UNIQUE(user_id, time_slot_id)
  )`);
  await pool.query('ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS group_size INTEGER NOT NULL DEFAULT 1');
  await pool.query('ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS total_cents INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT');
  await pool.query("ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS stripe_payment_status TEXT DEFAULT 'pending'");
  await pool.query('ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS claimed_booking_id INTEGER REFERENCES bookings(id)');

  await pool.query(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS subscription_plans (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    credits_per_month INTEGER,
    price_cents     INTEGER NOT NULL,
    stripe_price_id TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS subscriptions (
    id                      SERIAL PRIMARY KEY,
    user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id                 INTEGER NOT NULL REFERENCES subscription_plans(id),
    status                  TEXT NOT NULL DEFAULT 'active',
    credits_remaining       NUMERIC(6,1),
    credits_reset_at        TIMESTAMPTZ,
    stripe_subscription_id  TEXT UNIQUE,
    stripe_customer_id      TEXT,
    current_period_end      TIMESTAMPTZ,
    cancel_at_period_end    BOOLEAN DEFAULT FALSE,
    created_at              TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS credits_used INTEGER DEFAULT 0');
  // Halve credits (Ambient/Aufguss = 1,5) vereisen decimale kolommen
  await pool.query('ALTER TABLE subscriptions ALTER COLUMN credits_remaining TYPE NUMERIC(6,1)');
  await pool.query('ALTER TABLE bookings ALTER COLUMN credits_used TYPE NUMERIC(6,1)');
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hold_until TIMESTAMPTZ');
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_walkin BOOLEAN DEFAULT FALSE');
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pending_gift_card_id INTEGER');
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pending_milestone_id INTEGER');
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pending_discount_cents INTEGER');
  // token_version makes JWTs revocable: bump it and all outstanding tokens die
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0');

  // Append-only security audit log — never UPDATE or DELETE rows in this table
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (
    id          SERIAL      PRIMARY KEY,
    at          TIMESTAMPTZ DEFAULT NOW(),
    actor_type  TEXT,
    actor_id    INTEGER,
    actor_email TEXT,
    action      TEXT        NOT NULL,
    target      TEXT,
    detail      TEXT,
    ip          TEXT
  )`);
  await pool.query('ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS price_cents INTEGER');
  await pool.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pause_resumes_at TIMESTAMPTZ');

  await pool.query(`CREATE TABLE IF NOT EXISTS staff_users (
    id            SERIAL      PRIMARY KEY,
    name          TEXT        NOT NULL,
    email         TEXT        UNIQUE NOT NULL,
    password_hash TEXT        NOT NULL,
    is_active     BOOLEAN     DEFAULT TRUE,
    perm_revenue   BOOLEAN    DEFAULT FALSE,
    perm_bookings  BOOLEAN    DEFAULT FALSE,
    perm_slots     BOOLEAN    DEFAULT FALSE,
    perm_generate  BOOLEAN    DEFAULT FALSE,
    perm_schedule  BOOLEAN    DEFAULT TRUE,
    perm_customers BOOLEAN    DEFAULT FALSE,
    perm_messages  BOOLEAN    DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS user_milestones (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    milestone    INTEGER NOT NULL,
    achieved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    promo_code   TEXT,
    redeemed_at  TIMESTAMPTZ,
    UNIQUE(user_id, milestone)
  )`);
  await pool.query(`ALTER TABLE user_milestones ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ`);

  await pool.query(`CREATE TABLE IF NOT EXISTS gift_cards (
    id                       SERIAL      PRIMARY KEY,
    code                     TEXT        UNIQUE NOT NULL,
    initial_amount_cents     INTEGER     NOT NULL,
    remaining_amount_cents   INTEGER     NOT NULL,
    purchaser_name           TEXT        NOT NULL,
    purchaser_email          TEXT        NOT NULL,
    recipient_name           TEXT        NOT NULL,
    recipient_email          TEXT        NOT NULL,
    message                  TEXT,
    stripe_payment_intent_id TEXT,
    status                   TEXT        NOT NULL DEFAULT 'pending',
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    expires_at               TIMESTAMPTZ NOT NULL
  )`);

  await seedSessionTypes();
  await seedTimeSlots();
  await seedAdmin();
  await seedSubscriptionPlans();
  console.log('✓ Database ready (PostgreSQL)');
}

// ─── Query helpers ────────────────────────────────────────────────────────────

const queries = {

  // Session types
  getSessionTypes: async () => {
    const { rows } = await pool.query('SELECT * FROM session_types WHERE is_active = TRUE ORDER BY price_cents');
    return rows;
  },

  getSessionTypeById: async (id) => {
    const { rows } = await pool.query('SELECT * FROM session_types WHERE id = $1', [id]);
    return rows[0] || null;
  },

  getAllSessionTypes: async () => {
    const { rows } = await pool.query('SELECT * FROM session_types ORDER BY price_cents');
    return rows;
  },

  // Time slots
  getSlotsForMonth: async (sessionTypeId, year, month) => {
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const to   = `${year}-${String(month).padStart(2, '0')}-31`;
    const { rows } = await pool.query(`
      SELECT ts.*,
             st.name         AS session_name,
             COALESCE(ts.price_cents, st.price_cents)  AS price_cents,
             st.max_capacity AS type_capacity,
             COALESCE(SUM(CASE WHEN b.status != 'cancelled' AND (b.hold_until IS NULL OR b.hold_until > NOW()) THEN b.group_size ELSE 0 END), 0)::int AS booked
      FROM time_slots ts
      JOIN session_types st ON st.id = ts.session_type_id
      LEFT JOIN bookings b ON b.time_slot_id = ts.id
      WHERE ts.session_type_id = $1
        AND ts.date BETWEEN $2 AND $3
        AND ts.is_cancelled = FALSE
      GROUP BY ts.id, st.name, st.price_cents, st.max_capacity
      ORDER BY ts.date, ts.start_time
    `, [sessionTypeId, from, to]);
    return rows;
  },

  getSlotById: async (id) => {
    const { rows } = await pool.query(`
      SELECT ts.*,
             st.name         AS session_name,
             COALESCE(ts.price_cents, st.price_cents)  AS price_cents,
             st.max_capacity AS type_capacity,
             COALESCE(SUM(CASE WHEN b.status != 'cancelled' AND (b.hold_until IS NULL OR b.hold_until > NOW()) THEN b.group_size ELSE 0 END), 0)::int AS booked
      FROM time_slots ts
      JOIN session_types st ON st.id = ts.session_type_id
      LEFT JOIN bookings b ON b.time_slot_id = ts.id
      WHERE ts.id = $1
      GROUP BY ts.id, st.name, st.price_cents, st.max_capacity
    `, [id]);
    return rows[0] || null;
  },

  // Users
  getUserByEmail: async (email) => {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] || null;
  },

  getUserById: async (id) => {
    const { rows } = await pool.query('SELECT id, name, email, created_at, waiver_signed_at, email_verified_at FROM users WHERE id = $1', [id]);
    return rows[0] || null;
  },

  createUser: async (name, email, passwordHash) => {
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [name, email, passwordHash]
    );
    return rows[0]; // { id }
  },

  findOrCreateUserByGoogle: async (googleId, email, name) => {
    // 1. Find by google_id
    let { rows } = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    if (rows[0]) return rows[0];

    // 2. Find by email — link existing account
    ({ rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]));
    if (rows[0]) {
      await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, rows[0].id]);
      return rows[0];
    }

    // 3. Create new user (no password)
    ({ rows } = await pool.query(
      'INSERT INTO users (name, email, google_id) VALUES ($1, $2, $3) RETURNING *',
      [name, email, googleId]
    ));
    return rows[0];
  },

  setVerifyCode: async (userId, code, expiresAt) => {
    await pool.query('UPDATE users SET verify_code = $2, verify_code_expires = $3 WHERE id = $1', [userId, code, expiresAt]);
  },

  verifyEmailCode: async (userId, code) => {
    const { rows } = await pool.query(
      `UPDATE users
       SET email_verified_at = NOW(), verify_code = NULL, verify_code_expires = NULL
       WHERE id = $1 AND verify_code = $2 AND verify_code_expires > NOW()
       RETURNING id`,
      [userId, code]
    );
    return !!rows[0];
  },

  markEmailVerified: async (userId) => {
    await pool.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1', [userId]);
  },

  getAllUsers: async () => {
    const { rows } = await pool.query(`
      SELECT u.id, u.name, u.email, u.created_at, u.admin_notes, u.waiver_signed_at,
             COUNT(b.id)::int AS booking_count
      FROM users u
      LEFT JOIN bookings b ON b.user_id = u.id AND b.status != 'cancelled'
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    return rows;
  },

  updateUserAdminNotes: async (userId, notes) => {
    await pool.query('UPDATE users SET admin_notes = $1 WHERE id = $2', [notes, userId]);
  },

  getScheduleByDate: async (date) => {
    const { rows } = await pool.query(`
      SELECT
        ts.id         AS slot_id,
        ts.start_time,
        ts.end_time,
        st.name       AS session_name,
        st.color,
        COALESCE(ts.max_capacity, st.max_capacity) AS capacity,
        b.id          AS booking_id,
        b.group_size,
        b.status,
        b.checked_in,
        u.id          AS user_id,
        u.name        AS customer_name,
        u.email       AS customer_email,
        u.admin_notes
      FROM time_slots ts
      JOIN session_types st ON st.id = ts.session_type_id
      LEFT JOIN bookings b  ON b.time_slot_id = ts.id AND b.status != 'cancelled'
      LEFT JOIN users u     ON u.id = b.user_id
      WHERE ts.date = $1 AND ts.is_cancelled = FALSE
      ORDER BY ts.start_time, b.id
    `, [date]);
    return rows;
  },

  checkInBooking: async (bookingId, value) => {
    await pool.query('UPDATE bookings SET checked_in = $1 WHERE id = $2', [value, bookingId]);
  },

  getUserBookings: async (userId) => {
    const { rows } = await pool.query(`
      SELECT b.id, b.group_size, b.status, b.total_cents, b.created_at,
             ts.date, ts.start_time, ts.end_time,
             st.name AS session_name
      FROM bookings b
      JOIN time_slots ts ON ts.id = b.time_slot_id
      JOIN session_types st ON st.id = ts.session_type_id
      WHERE b.user_id = $1
      ORDER BY ts.date DESC, ts.start_time DESC
    `, [userId]);
    return rows;
  },

  // Bookings
  createBooking: async (userId, slotId, groupSize, totalCents) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the slot row first (no GROUP BY allowed with FOR UPDATE)
      const { rows: slotRows } = await client.query(`
        SELECT ts.id, COALESCE(ts.max_capacity, st.max_capacity) AS capacity
        FROM time_slots ts
        JOIN session_types st ON st.id = ts.session_type_id
        WHERE ts.id = $1 AND ts.is_cancelled = FALSE
        FOR UPDATE OF ts
      `, [slotId]);
      if (!slotRows[0]) throw Object.assign(new Error('Slot not found'), { code: 'SLOT_NOT_FOUND' });
      const { capacity } = slotRows[0];
      // Count existing bookings separately
      const { rows: countRows } = await client.query(
        `SELECT COALESCE(SUM(group_size), 0)::int AS booked FROM bookings WHERE time_slot_id = $1 AND status != 'cancelled' AND (hold_until IS NULL OR hold_until > NOW())`,
        [slotId]
      );
      const booked = countRows[0].booked;
      if (booked + groupSize > capacity) throw Object.assign(new Error(`Only ${capacity - booked} spot(s) remaining`), { code: 'NO_CAPACITY', spots_left: capacity - booked });
      const { rows } = await client.query(
        'INSERT INTO bookings (user_id, time_slot_id, group_size, total_cents) VALUES ($1, $2, $3, $4) RETURNING id',
        [userId, slotId, groupSize, totalCents]
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  getBookingsByUser: async (userId) => {
    const { rows } = await pool.query(`
      SELECT b.*,
             ts.date, ts.start_time, ts.end_time,
             st.name AS session_name, st.duration_min, st.id AS session_type_id
      FROM bookings b
      JOIN time_slots ts ON ts.id = b.time_slot_id
      JOIN session_types st ON st.id = ts.session_type_id
      WHERE b.user_id = $1
      ORDER BY ts.date DESC, ts.start_time DESC
    `, [userId]);
    return rows;
  },

  getBookingById: async (id) => {
    const { rows } = await pool.query(`
      SELECT b.*,
             u.name AS customer_name, u.email AS customer_email,
             ts.date, ts.start_time, ts.end_time,
             st.name AS session_name, st.duration_min
      FROM bookings b
      JOIN users u ON u.id = b.user_id
      JOIN time_slots ts ON ts.id = b.time_slot_id
      JOIN session_types st ON st.id = ts.session_type_id
      WHERE b.id = $1
    `, [id]);
    return rows[0] || null;
  },

  getBookingByPaymentIntent: async (paymentIntentId) => {
    const { rows } = await pool.query(`
      SELECT b.*,
             u.name AS customer_name, u.email AS customer_email,
             ts.date, ts.start_time, ts.end_time,
             st.name AS session_name
      FROM bookings b
      JOIN users u ON u.id = b.user_id
      JOIN time_slots ts ON ts.id = b.time_slot_id
      JOIN session_types st ON st.id = ts.session_type_id
      WHERE b.stripe_payment_intent_id = $1
    `, [paymentIntentId]);
    return rows[0] || null;
  },

  setBookingPendingPromo: async (bookingId, giftCardId, milestoneId, discountCents) => {
    await pool.query(
      `UPDATE bookings
       SET pending_gift_card_id = $2, pending_milestone_id = $3, pending_discount_cents = $4
       WHERE id = $1`,
      [bookingId, giftCardId, milestoneId, discountCents]
    );
  },

  // Redeem a gift card / milestone code attached to a booking, exactly once.
  // The atomic clear-and-return makes concurrent calls (webhook + /confirm) safe:
  // only the first caller gets the pending values back.
  redeemPendingPromo: async (bookingId) => {
    const { rows } = await pool.query(
      `UPDATE bookings b
       SET pending_gift_card_id = NULL, pending_milestone_id = NULL, pending_discount_cents = NULL
       FROM (SELECT id, pending_gift_card_id, pending_milestone_id, pending_discount_cents
             FROM bookings WHERE id = $1 FOR UPDATE) old
       WHERE b.id = old.id
         AND (old.pending_gift_card_id IS NOT NULL OR old.pending_milestone_id IS NOT NULL)
       RETURNING old.pending_gift_card_id AS gift_card_id,
                 old.pending_milestone_id AS milestone_id,
                 old.pending_discount_cents AS discount_cents`,
      [bookingId]
    );
    const p = rows[0];
    if (!p) return null;
    if (p.milestone_id) {
      await pool.query('UPDATE user_milestones SET redeemed_at = NOW() WHERE id = $1', [p.milestone_id]);
    }
    if (p.gift_card_id) {
      await pool.query(
        `UPDATE gift_cards
         SET remaining_amount_cents = remaining_amount_cents - $2,
             status = CASE WHEN remaining_amount_cents - $2 <= 0 THEN 'depleted' ELSE status END
         WHERE id = $1 AND remaining_amount_cents >= $2`,
        [p.gift_card_id, p.discount_cents || 0]
      );
    }
    return p;
  },

  updateBookingPayment: async (bookingId, paymentIntentId, status) => {
    await pool.query(`
      UPDATE bookings
      SET stripe_payment_intent_id = $1,
          stripe_payment_status    = $2,
          status                   = CASE WHEN $2 = 'succeeded' THEN 'confirmed' ELSE status END,
          confirmation_sent        = ($2 = 'succeeded')
      WHERE id = $3
    `, [paymentIntentId, status, bookingId]);
  },

  // Admin
  getAdminByEmail: async (email) => {
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
    return rows[0] || null;
  },

  getAllBookings: async (filters = {}) => {
    let sql = `
      SELECT b.*,
             u.name AS customer_name, u.email AS customer_email,
             ts.date, ts.start_time, ts.end_time,
             st.name AS session_name
      FROM bookings b
      JOIN users u ON u.id = b.user_id
      JOIN time_slots ts ON ts.id = b.time_slot_id
      JOIN session_types st ON st.id = ts.session_type_id
      WHERE 1=1
    `;
    const params = [];
    let p = 1;
    if (filters.from)            { sql += ` AND ts.date >= $${p++}`;  params.push(filters.from); }
    if (filters.to)              { sql += ` AND ts.date <= $${p++}`;  params.push(filters.to); }
    if (filters.session_type_id) { sql += ` AND st.id = $${p++}`;    params.push(filters.session_type_id); }
    if (filters.status)          { sql += ` AND b.status = $${p++}`; params.push(filters.status); }
    sql += ' ORDER BY ts.date ASC, ts.start_time ASC';
    const { rows } = await pool.query(sql, params);
    return rows;
  },

  getAllSlots: async (filters = {}) => {
    let sql = `
      SELECT ts.*,
             st.name AS session_name, COALESCE(ts.price_cents, st.price_cents) AS price_cents, st.max_capacity AS type_capacity,
             COALESCE(SUM(CASE WHEN b.status != 'cancelled' AND (b.hold_until IS NULL OR b.hold_until > NOW()) THEN b.group_size ELSE 0 END), 0)::int AS booked
      FROM time_slots ts
      JOIN session_types st ON st.id = ts.session_type_id
      LEFT JOIN bookings b ON b.time_slot_id = ts.id
      WHERE 1=1
    `;
    const params = [];
    let p = 1;
    if (filters.from) { sql += ` AND ts.date >= $${p++}`; params.push(filters.from); }
    if (filters.to)   { sql += ` AND ts.date <= $${p++}`; params.push(filters.to); }
    sql += ' GROUP BY ts.id, st.name, st.price_cents, st.max_capacity ORDER BY ts.date ASC, ts.start_time ASC';
    const { rows } = await pool.query(sql, params);
    return rows;
  },

  createSlot: async (sessionTypeId, date, startTime, endTime, maxCapacity, notes, priceCents) => {
    const price = (priceCents === null || priceCents === undefined) ? null : parseInt(priceCents);
    const { rows } = await pool.query(`
      INSERT INTO time_slots (session_type_id, date, start_time, end_time, max_capacity, notes, price_cents)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [sessionTypeId, date, startTime, endTime, maxCapacity || null, notes || null, price]);
    return rows[0]; // { id }
  },

  updateSlot: async (id, data) => {
    const price = (data.price_cents === null || data.price_cents === undefined) ? null : parseInt(data.price_cents);
    await pool.query(`
      UPDATE time_slots SET date = $1, start_time = $2, end_time = $3, max_capacity = $4, notes = $5, price_cents = $6
      WHERE id = $7
    `, [data.date, data.start_time, data.end_time, data.max_capacity || null, data.notes || null, price, id]);
  },

  cancelSlot: async (id) => {
    await pool.query('UPDATE time_slots SET is_cancelled = TRUE WHERE id = $1', [id]);
  },

  cancelBooking: async (id) => {
    await pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [id]);
  },

  // Password reset
  createPasswordResetToken: async (userId, token, expiresAt) => {
    // Delete any existing tokens for this user first
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [userId, token, expiresAt]
    );
  },

  getPasswordResetToken: async (token) => {
    const { rows } = await pool.query(
      'SELECT * FROM password_reset_tokens WHERE token = $1 AND expires_at > NOW()',
      [token]
    );
    return rows[0] || null;
  },

  deletePasswordResetToken: async (token) => {
    await pool.query('DELETE FROM password_reset_tokens WHERE token = $1', [token]);
  },

  updateUserPassword: async (userId, passwordHash) => {
    // Bump token_version so all existing sessions are logged out after a reset
    await pool.query(
      'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
      [passwordHash, userId]
    );
  },

  // Fire-and-forget security audit logging — must never break the request flow
  auditLog: ({ actor_type = null, actor_id = null, actor_email = null, action, target = null, detail = null, ip = null }) => {
    pool.query(
      `INSERT INTO audit_log (actor_type, actor_id, actor_email, action, target, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actor_type, actor_id, actor_email, action, target, detail, ip]
    ).catch(err => console.error('Audit log write failed:', err.message));
  },

  getAuditLog: async (limit = 200) => {
    const { rows } = await pool.query(
      'SELECT * FROM audit_log ORDER BY id DESC LIMIT $1',
      [Math.min(limit, 1000)]
    );
    return rows;
  },

  // Token-version lookups for revocable JWTs (one indexed PK query per request)
  getUserTokenVersion: async (id) => {
    const { rows } = await pool.query('SELECT token_version FROM users WHERE id = $1', [id]);
    return rows[0] ? rows[0].token_version : null;
  },

  getAdminTokenVersion: async (id) => {
    const { rows } = await pool.query('SELECT token_version FROM admin_users WHERE id = $1', [id]);
    return rows[0] ? rows[0].token_version : null;
  },

  // Reminder emails
  getBookingsNeedingReminder: async () => {
    const { rows } = await pool.query(`
      SELECT b.id, b.group_size, b.total_cents,
             u.name AS customer_name, u.email AS customer_email,
             ts.date, ts.start_time, ts.end_time,
             st.name AS session_name
      FROM bookings b
      JOIN users u ON u.id = b.user_id
      JOIN time_slots ts ON ts.id = b.time_slot_id
      JOIN session_types st ON st.id = ts.session_type_id
      WHERE b.status = 'confirmed'
        AND b.reminder_sent = FALSE
        AND (ts.date::text || ' ' || ts.start_time)::timestamp BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'
    `);
    return rows;
  },

  markReminderSent: async (bookingId) => {
    await pool.query('UPDATE bookings SET reminder_sent = TRUE WHERE id = $1', [bookingId]);
  },

  // Messages
  createMessage: async (userId, subject, body) => {
    const { rows } = await pool.query(
      'INSERT INTO messages (user_id, subject, body) VALUES ($1, $2, $3) RETURNING *',
      [userId, subject, body]
    );
    return rows[0];
  },

  getMessagesByUser: async (userId) => {
    const { rows } = await pool.query(`
      SELECT m.*,
             COALESCE(json_agg(r ORDER BY r.created_at) FILTER (WHERE r.id IS NOT NULL), '[]') AS replies
      FROM messages m
      LEFT JOIN message_replies r ON r.message_id = m.id
      WHERE m.user_id = $1
      GROUP BY m.id
      ORDER BY m.created_at DESC
    `, [userId]);
    return rows;
  },

  getAllMessages: async () => {
    const { rows } = await pool.query(`
      SELECT m.*,
             u.name AS user_name, u.email AS user_email,
             COALESCE(json_agg(r ORDER BY r.created_at) FILTER (WHERE r.id IS NOT NULL), '[]') AS replies,
             COUNT(r.id) FILTER (WHERE r.id IS NOT NULL)::int AS reply_count
      FROM messages m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN message_replies r ON r.message_id = m.id
      GROUP BY m.id, u.name, u.email
      ORDER BY m.is_read ASC, m.created_at DESC
    `);
    return rows;
  },

  getMessageById: async (messageId) => {
    const { rows } = await pool.query(
      'SELECT m.*, u.name AS user_name, u.email AS user_email FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = $1',
      [messageId]
    );
    return rows[0] || null;
  },

  replyToMessage: async (messageId, body, fromAdmin = true) => {
    const { rows } = await pool.query(
      'INSERT INTO message_replies (message_id, body, from_admin) VALUES ($1, $2, $3) RETURNING *',
      [messageId, body, fromAdmin]
    );
    await pool.query('UPDATE messages SET is_read = TRUE WHERE id = $1', [messageId]);
    return rows[0];
  },

  markMessageRead: async (messageId) => {
    await pool.query('UPDATE messages SET is_read = TRUE WHERE id = $1', [messageId]);
  },

  getUnreadMessageCount: async () => {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM messages WHERE is_read = FALSE");
    return rows[0].n;
  },

  // Subscriptions
  getSubscriptionPlans: async () => {
    const { rows } = await pool.query('SELECT * FROM subscription_plans WHERE is_active = TRUE ORDER BY price_cents');
    return rows;
  },

  getActiveSubscription: async (userId) => {
    const { rows } = await pool.query(`
      SELECT s.*, p.name AS plan_name, p.credits_per_month, p.price_cents
      FROM subscriptions s
      JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.user_id = $1 AND s.status IN ('active', 'past_due')
      ORDER BY s.created_at DESC LIMIT 1
    `, [userId]);
    return rows[0] || null;
  },

  createSubscription: async (userId, planId, stripeSubId, stripeCustomerId, creditsPerMonth, periodEnd) => {
    const creditsRemaining = creditsPerMonth; // null for unlimited
    const resetAt = periodEnd;
    const { rows } = await pool.query(`
      INSERT INTO subscriptions (user_id, plan_id, stripe_subscription_id, stripe_customer_id, credits_remaining, credits_reset_at, current_period_end, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active') RETURNING *
    `, [userId, planId, stripeSubId, stripeCustomerId, creditsRemaining, resetAt, periodEnd]);
    return rows[0];
  },

  updateSubscriptionFromWebhook: async (stripeSubId, status, periodEnd, cancelAtPeriodEnd) => {
    await pool.query(`
      UPDATE subscriptions
      SET status = $2, current_period_end = $3, cancel_at_period_end = $4
      WHERE stripe_subscription_id = $1
    `, [stripeSubId, status, periodEnd, cancelAtPeriodEnd]);
  },

  resetSubscriptionCredits: async (stripeSubId, creditsPerMonth, periodEnd) => {
    // Een overgebleven halve credit gaat mee naar de nieuwe maand
    await pool.query(`
      UPDATE subscriptions
      SET credits_remaining = $2 + (COALESCE(credits_remaining, 0) - floor(COALESCE(credits_remaining, 0))),
          credits_reset_at = $3, current_period_end = $3, status = 'active'
      WHERE stripe_subscription_id = $1
    `, [stripeSubId, creditsPerMonth, periodEnd]);
  },

  deductCredits: async (userId, creditsToUse) => {
    const { rows } = await pool.query(`
      UPDATE subscriptions
      SET credits_remaining = credits_remaining - $2
      WHERE user_id = $1 AND status IN ('active', 'past_due') AND credits_remaining >= $2
      RETURNING *
    `, [userId, creditsToUse]);
    return rows[0] || null;
  },

  cancelSubscription: async (userId) => {
    await pool.query(`
      UPDATE subscriptions SET cancel_at_period_end = TRUE
      WHERE user_id = $1 AND status = 'active'
    `, [userId]);
  },

  getSubscriptionByStripeId: async (stripeSubId) => {
    const { rows } = await pool.query('SELECT * FROM subscriptions WHERE stripe_subscription_id = $1', [stripeSubId]);
    return rows[0] || null;
  },

  getAllSubscriptions: async () => {
    const { rows } = await pool.query(`
      SELECT s.*, u.name AS user_name, u.email AS user_email, p.name AS plan_name, p.price_cents
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id
      JOIN subscription_plans p ON p.id = s.plan_id
      ORDER BY s.created_at DESC
    `);
    return rows;
  },

  getSubscriptionById: async (id) => {
    const { rows } = await pool.query(`
      SELECT s.*, u.name AS user_name, u.email AS user_email, p.name AS plan_name
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id
      JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.id = $1
    `, [id]);
    return rows[0] || null;
  },

  listSubscriptionsByStatus: async (statuses) => {
    const { rows } = await pool.query(`
      SELECT s.*, u.email AS user_email
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id
      WHERE s.status = ANY($1) AND s.stripe_subscription_id IS NOT NULL
    `, [statuses]);
    return rows;
  },

  markSubscriptionPaused: async (id, resumesAt) => {
    await pool.query(`
      UPDATE subscriptions
      SET status = 'paused', paused_at = NOW(), pause_resumes_at = $2
      WHERE id = $1
    `, [id, resumesAt || null]);
  },

  markSubscriptionResumed: async (id) => {
    await pool.query(`
      UPDATE subscriptions
      SET status = 'active', paused_at = NULL, pause_resumes_at = NULL
      WHERE id = $1
    `, [id]);
  },

  markSubscriptionResumedByStripeId: async (stripeSubId) => {
    await pool.query(`
      UPDATE subscriptions
      SET status = 'active', paused_at = NULL, pause_resumes_at = NULL
      WHERE stripe_subscription_id = $1
    `, [stripeSubId]);
  },

  // ─── Walk-in booking flow ────────────────────────────────────────────────
  createGuestUser: async (name, email) => {
    const { rows } = await pool.query(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id, name, email',
      [name, email]
    );
    return rows[0];
  },

  getUpcomingSlotsWithSpots: async () => {
    const { rows } = await pool.query(`
      SELECT
        ts.id,
        ts.date,
        ts.start_time,
        ts.end_time,
        COALESCE(ts.price_cents, st.price_cents) AS price_cents,
        st.duration_min,
        st.id            AS session_type_id,
        st.name          AS session_name,
        COALESCE(ts.max_capacity, st.max_capacity) AS capacity,
        COALESCE(ts.max_capacity, st.max_capacity) - COALESCE((
          SELECT SUM(group_size) FROM bookings b
          WHERE b.time_slot_id = ts.id
            AND b.status != 'cancelled'
            AND (b.hold_until IS NULL OR b.hold_until > NOW())
        ), 0)::int AS spots_left
      FROM time_slots ts
      JOIN session_types st ON st.id = ts.session_type_id
      WHERE ts.is_cancelled = FALSE
        AND (ts.date > CURRENT_DATE OR (ts.date = CURRENT_DATE AND ts.start_time > CURRENT_TIME))
      ORDER BY ts.date, ts.start_time
    `);
    return rows;
  },

  createWalkinBookingWithHold: async (userId, slotId, groupSize, totalCents, holdMinutes) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: slotRows } = await client.query(`
        SELECT ts.id, COALESCE(ts.max_capacity, st.max_capacity) AS capacity
        FROM time_slots ts
        JOIN session_types st ON st.id = ts.session_type_id
        WHERE ts.id = $1 AND ts.is_cancelled = FALSE
        FOR UPDATE OF ts
      `, [slotId]);
      if (!slotRows[0]) throw Object.assign(new Error('Slot not found'), { code: 'SLOT_NOT_FOUND' });
      const { capacity } = slotRows[0];
      const { rows: countRows } = await client.query(
        `SELECT COALESCE(SUM(group_size), 0)::int AS booked
         FROM bookings
         WHERE time_slot_id = $1 AND status != 'cancelled'
           AND (hold_until IS NULL OR hold_until > NOW())`,
        [slotId]
      );
      if (countRows[0].booked + groupSize > capacity) {
        throw Object.assign(new Error(`Only ${capacity - countRows[0].booked} spot(s) left`), { code: 'NO_CAPACITY' });
      }
      const holdUntil = holdMinutes > 0 ? new Date(Date.now() + holdMinutes * 60 * 1000) : null;
      const status = totalCents === 0 ? 'confirmed' : 'pending';
      const { rows } = await client.query(
        `INSERT INTO bookings (user_id, time_slot_id, group_size, total_cents, status, hold_until, is_walkin)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id, status`,
        [userId, slotId, groupSize, totalCents, status, holdUntil]
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  expireStaleHolds: async () => {
    const { rowCount } = await pool.query(`
      UPDATE bookings SET status = 'cancelled'
      WHERE status = 'pending' AND is_walkin = TRUE
        AND hold_until IS NOT NULL AND hold_until < NOW()
    `);
    return rowCount;
  },

  countUserFreeSlotBookings: async (userId) => {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM bookings b
      JOIN time_slots ts ON ts.id = b.time_slot_id
      WHERE b.user_id = $1
        AND b.status != 'cancelled'
        AND ts.price_cents = 0
    `, [userId]);
    return rows[0].n;
  },

  confirmWalkinBooking: async (bookingId, paymentIntentId) => {
    await pool.query(
      "UPDATE bookings SET status = 'confirmed', hold_until = NULL, stripe_payment_status = 'succeeded', stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id) WHERE id = $1",
      [bookingId, paymentIntentId || null]
    );
  },

  getBookingBasic: async (id) => {
    const { rows } = await pool.query(`
      SELECT b.id, b.status, b.total_cents, b.hold_until, b.stripe_payment_status,
             ts.date, ts.start_time, ts.end_time,
             st.name AS session_name,
             u.name AS customer_name, u.email AS customer_email
      FROM bookings b
      JOIN time_slots ts   ON ts.id = b.time_slot_id
      JOIN session_types st ON st.id = ts.session_type_id
      JOIN users u          ON u.id = b.user_id
      WHERE b.id = $1
    `, [id]);
    return rows[0] || null;
  },

  // Waiver
  signWaiver: async (userId) => {
    await pool.query('UPDATE users SET waiver_signed_at = NOW() WHERE id = $1', [userId]);
  },

  // Waitlist
  joinWaitlist: async (userId, slotId, groupSize, totalCents, paymentIntentId) => {
    const { rows } = await pool.query(
      `INSERT INTO waitlist (user_id, time_slot_id, group_size, total_cents, stripe_payment_intent_id, stripe_payment_status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (user_id, time_slot_id) DO NOTHING RETURNING *`,
      [userId, slotId, groupSize, totalCents, paymentIntentId]
    );
    return rows[0] || null;
  },

  markWaitlistPaid: async (paymentIntentId) => {
    await pool.query(
      "UPDATE waitlist SET stripe_payment_status = 'paid' WHERE stripe_payment_intent_id = $1",
      [paymentIntentId]
    );
  },

  getWaitlistEntryByPaymentIntent: async (paymentIntentId) => {
    const { rows } = await pool.query(
      `SELECT w.*, u.name AS customer_name, u.email AS customer_email,
              ts.date, ts.start_time, ts.end_time, st.name AS session_name, COALESCE(ts.price_cents, st.price_cents) AS price_cents
       FROM waitlist w
       JOIN users u ON u.id = w.user_id
       JOIN time_slots ts ON ts.id = w.time_slot_id
       JOIN session_types st ON st.id = ts.session_type_id
       WHERE w.stripe_payment_intent_id = $1`,
      [paymentIntentId]
    );
    return rows[0] || null;
  },

  getFirstPaidWaitlistUser: async (slotId) => {
    const { rows } = await pool.query(`
      SELECT w.id, w.user_id, w.group_size, w.total_cents, w.stripe_payment_intent_id,
             u.name AS customer_name, u.email AS customer_email
      FROM waitlist w
      JOIN users u ON u.id = w.user_id
      WHERE w.time_slot_id = $1
        AND w.stripe_payment_status = 'paid'
        AND w.claimed_booking_id IS NULL
        AND w.notified_at IS NULL
      ORDER BY w.created_at ASC
      LIMIT 1
    `, [slotId]);
    return rows[0] || null;
  },

  claimWaitlistEntry: async (waitlistId, bookingId) => {
    await pool.query(
      'UPDATE waitlist SET claimed_booking_id = $2, notified_at = NOW() WHERE id = $1',
      [waitlistId, bookingId]
    );
  },

  leaveWaitlist: async (userId, slotId) => {
    const { rows } = await pool.query(
      'DELETE FROM waitlist WHERE user_id = $1 AND time_slot_id = $2 RETURNING *',
      [userId, slotId]
    );
    return rows[0] || null;
  },

  getWaitlistEntry: async (userId, slotId) => {
    const { rows } = await pool.query(
      'SELECT * FROM waitlist WHERE user_id = $1 AND time_slot_id = $2',
      [userId, slotId]
    );
    return rows[0] || null;
  },

  getWaitlistPosition: async (userId, slotId) => {
    const entry = await pool.query(
      'SELECT created_at FROM waitlist WHERE user_id = $1 AND time_slot_id = $2',
      [userId, slotId]
    );
    if (!entry.rows[0]) return { position: null, total: 0 };
    const pos = await pool.query(
      'SELECT COUNT(*)::int AS position FROM waitlist WHERE time_slot_id = $1 AND created_at <= $2',
      [slotId, entry.rows[0].created_at]
    );
    const tot = await pool.query(
      'SELECT COUNT(*)::int AS total FROM waitlist WHERE time_slot_id = $1',
      [slotId]
    );
    return { position: pos.rows[0].position, total: tot.rows[0].total };
  },

  getWaitlistForSlot: async (slotId) => {
    const { rows } = await pool.query(`
      SELECT w.id, w.user_id, w.created_at, w.notified_at, w.group_size, w.total_cents, w.stripe_payment_status, w.claimed_booking_id,
             u.name AS customer_name, u.email AS customer_email
      FROM waitlist w
      JOIN users u ON u.id = w.user_id
      WHERE w.time_slot_id = $1
      ORDER BY w.created_at ASC
    `, [slotId]);
    return rows;
  },

  getFirstUnnotifiedWaitlistUser: async (slotId) => {
    const { rows } = await pool.query(`
      SELECT w.id, w.user_id, u.name AS customer_name, u.email AS customer_email
      FROM waitlist w
      JOIN users u ON u.id = w.user_id
      WHERE w.time_slot_id = $1 AND w.notified_at IS NULL AND w.stripe_payment_status != 'paid'
      ORDER BY w.created_at ASC
      LIMIT 1
    `, [slotId]);
    return rows[0] || null;
  },

  markWaitlistNotified: async (waitlistId) => {
    await pool.query('UPDATE waitlist SET notified_at = NOW() WHERE id = $1', [waitlistId]);
  },

  getUserWaitlist: async (userId) => {
    const { rows } = await pool.query(`
      SELECT w.id, w.time_slot_id, w.created_at, w.group_size, w.total_cents, w.stripe_payment_status, w.claimed_booking_id,
             ts.date, ts.start_time, ts.end_time,
             st.name AS session_name, st.color,
             (SELECT COUNT(*)::int FROM waitlist w2 WHERE w2.time_slot_id = w.time_slot_id AND w2.created_at <= w.created_at) AS queue_position
      FROM waitlist w
      JOIN time_slots ts ON ts.id = w.time_slot_id
      JOIN session_types st ON st.id = ts.session_type_id
      WHERE w.user_id = $1 AND ts.date >= CURRENT_DATE::text AND ts.is_cancelled = FALSE
      ORDER BY ts.date ASC, ts.start_time ASC
    `, [userId]);
    return rows;
  },

  deleteUser: async (userId) => {
    // GDPR: remove personal content, anonymise the account row.
    // Bookings stay (anonymised via the users row) for the 7-year fiscal
    // retention duty; gift cards are financial records and stay too.
    await pool.query('DELETE FROM messages WHERE user_id = $1', [userId]); // replies cascade
    await pool.query('DELETE FROM waitlist WHERE user_id = $1 AND claimed_booking_id IS NULL', [userId]);
    await pool.query(
      "UPDATE users SET name = 'Deleted User', email = 'deleted_' || id || '@deleted.local', password_hash = 'DELETED', google_id = NULL, admin_notes = NULL, token_version = token_version + 1 WHERE id = $1",
      [userId]
    );
  },

  getUserDataExport: async (userId) => {
    const { rows: userRows } = await pool.query(
      'SELECT id, name, email, created_at, waiver_signed_at FROM users WHERE id = $1', [userId]
    );
    const user = userRows[0];
    if (!user) return { user: null };

    const [bookings, sub, messages, waitlist, giftCards, milestones] = await Promise.all([
      pool.query(`
        SELECT b.id, b.group_size, b.total_cents, b.status, b.created_at,
               ts.date, ts.start_time, ts.end_time, st.name AS session_name
        FROM bookings b
        JOIN time_slots ts ON ts.id = b.time_slot_id
        JOIN session_types st ON st.id = ts.session_type_id
        WHERE b.user_id = $1
        ORDER BY b.created_at DESC
      `, [userId]),
      pool.query('SELECT status, current_period_end FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId]),
      pool.query(`
        SELECT m.id, m.subject, m.body, m.created_at,
               COALESCE(json_agg(json_build_object('body', r.body, 'from_admin', r.from_admin, 'created_at', r.created_at))
                        FILTER (WHERE r.id IS NOT NULL), '[]') AS replies
        FROM messages m
        LEFT JOIN message_replies r ON r.message_id = m.id
        WHERE m.user_id = $1
        GROUP BY m.id ORDER BY m.created_at DESC
      `, [userId]),
      pool.query(`
        SELECT w.created_at, w.group_size, w.total_cents, ts.date, ts.start_time, st.name AS session_name
        FROM waitlist w
        JOIN time_slots ts ON ts.id = w.time_slot_id
        JOIN session_types st ON st.id = ts.session_type_id
        WHERE w.user_id = $1 ORDER BY w.created_at DESC
      `, [userId]),
      pool.query(`
        SELECT code, initial_amount_cents, remaining_amount_cents, status, created_at, expires_at,
               (purchaser_email = $1) AS purchased_by_me
        FROM gift_cards WHERE purchaser_email = $1 OR recipient_email = $1
      `, [user.email]),
      pool.query('SELECT milestone, achieved_at, redeemed_at FROM user_milestones WHERE user_id = $1 ORDER BY milestone', [userId]),
    ]);

    return {
      user,
      bookings:     bookings.rows,
      subscription: sub.rows[0] || null,
      messages:     messages.rows,
      waitlist:     waitlist.rows,
      gift_cards:   giftCards.rows,
      milestones:   milestones.rows,
    };
  },

  getAnalytics: async () => {
    const [total, confirmed, revenue, perType, perWeek, avgGroup, cancelRate] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS n FROM bookings WHERE status != 'cancelled'"),
      pool.query("SELECT COUNT(*)::int AS n FROM bookings WHERE status = 'confirmed'"),
      pool.query("SELECT COALESCE(SUM(total_cents),0)::int AS n FROM bookings WHERE status = 'confirmed'"),
      pool.query(`
        SELECT st.name, COUNT(b.id)::int AS count
        FROM session_types st
        LEFT JOIN time_slots ts ON ts.session_type_id = st.id
        LEFT JOIN bookings b ON b.time_slot_id = ts.id AND b.status != 'cancelled'
        GROUP BY st.id, st.name ORDER BY count DESC
      `),
      pool.query(`
        SELECT TO_CHAR(ts.date::date, 'IYYY-"W"IW') AS week, COUNT(b.id)::int AS count
        FROM bookings b
        JOIN time_slots ts ON ts.id = b.time_slot_id
        WHERE b.status != 'cancelled'
          AND ts.date >= TO_CHAR(CURRENT_DATE - INTERVAL '8 weeks', 'YYYY-MM-DD')
        GROUP BY week ORDER BY week
      `),
      pool.query("SELECT COALESCE(AVG(group_size),0)::numeric(4,1) AS n FROM bookings WHERE status != 'cancelled'"),
      pool.query("SELECT COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled, COUNT(*)::int AS total FROM bookings"),
    ]);
    return {
      totalBookings:     total.rows[0].n,
      confirmedBookings: confirmed.rows[0].n,
      totalRevenue:      revenue.rows[0].n,
      bookingsPerType:   perType.rows,
      bookingsPerWeek:   perWeek.rows,
      avgGroupSize:      avgGroup.rows[0].n,
      cancellationRate:  cancelRate.rows[0],
    };
  },

  // Staff
  getAllStaff: async () => {
    const { rows } = await pool.query('SELECT id, name, email, is_active, perm_revenue, perm_bookings, perm_slots, perm_generate, perm_schedule, perm_customers, perm_messages, created_at FROM staff_users ORDER BY name');
    return rows;
  },

  getStaffByEmail: async (email) => {
    const { rows } = await pool.query('SELECT * FROM staff_users WHERE email = $1', [email]);
    return rows[0] || null;
  },

  getStaffById: async (id) => {
    const { rows } = await pool.query('SELECT * FROM staff_users WHERE id = $1', [id]);
    return rows[0] || null;
  },

  createStaff: async (name, email, passwordHash) => {
    const { rows } = await pool.query(
      'INSERT INTO staff_users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [name, email, passwordHash]
    );
    return rows[0];
  },

  updateStaffPermissions: async (id, fields) => {
    await pool.query(`
      UPDATE staff_users SET
        is_active      = $2,
        perm_revenue   = $3,
        perm_bookings  = $4,
        perm_slots     = $5,
        perm_generate  = $6,
        perm_schedule  = $7,
        perm_customers = $8,
        perm_messages  = $9
      WHERE id = $1
    `, [id, fields.is_active, fields.perm_revenue, fields.perm_bookings, fields.perm_slots, fields.perm_generate, fields.perm_schedule, fields.perm_customers, fields.perm_messages]);
  },

  updateStaffPassword: async (id, passwordHash) => {
    // Bump token_version so existing staff sessions are logged out
    await pool.query(
      'UPDATE staff_users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
      [passwordHash, id]
    );
  },

  // Milestones
  getUserVisitCount: async (userId) => {
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND checked_in = TRUE",
      [userId]
    );
    return rows[0].count;
  },

  getClaimedMilestones: async (userId) => {
    const { rows } = await pool.query(
      'SELECT milestone, achieved_at, promo_code FROM user_milestones WHERE user_id = $1 ORDER BY milestone',
      [userId]
    );
    return rows;
  },

  getMilestoneByCode: async (code) => {
    const { rows } = await pool.query(
      'SELECT * FROM user_milestones WHERE promo_code = $1 AND redeemed_at IS NULL',
      [code]
    );
    return rows[0] || null;
  },

  redeemMilestoneCode: async (id) => {
    await pool.query('UPDATE user_milestones SET redeemed_at = NOW() WHERE id = $1', [id]);
  },

  claimMilestone: async (userId, milestone, promoCode) => {
    const { rows } = await pool.query(
      'INSERT INTO user_milestones (user_id, milestone, promo_code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING *',
      [userId, milestone, promoCode]
    );
    return rows[0] || null;
  },

  getUserMilestoneStats: async (userId) => {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'confirmed' AND checked_in = TRUE)::int AS total_visits,
        COUNT(*) FILTER (WHERE status = 'confirmed')::int AS total_bookings
      FROM bookings WHERE user_id = $1
    `, [userId]);
    return rows[0];
  },

  // ── Gift cards ──────────────────────────────────────────────────────────────
  createGiftCard: async ({ code, initial_amount_cents, purchaser_name, purchaser_email, recipient_name, recipient_email, message, status }) => {
    const expires_at = new Date();
    expires_at.setFullYear(expires_at.getFullYear() + 1);
    const { rows } = await pool.query(
      `INSERT INTO gift_cards
         (code, initial_amount_cents, remaining_amount_cents, purchaser_name, purchaser_email,
          recipient_name, recipient_email, message, status, expires_at)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [code, initial_amount_cents, purchaser_name, purchaser_email, recipient_name, recipient_email, message || null, status || 'pending', expires_at]
    );
    return rows[0];
  },

  getGiftCardByCode: async (code) => {
    const { rows } = await pool.query(
      `SELECT * FROM gift_cards WHERE UPPER(code) = UPPER($1)`, [code]
    );
    return rows[0] || null;
  },

  getGiftCardById: async (id) => {
    const { rows } = await pool.query('SELECT * FROM gift_cards WHERE id = $1', [id]);
    return rows[0] || null;
  },

  activateGiftCard: async (id, stripe_payment_intent_id) => {
    const { rows } = await pool.query(
      `UPDATE gift_cards SET status = 'active', stripe_payment_intent_id = $2 WHERE id = $1 RETURNING *`,
      [id, stripe_payment_intent_id]
    );
    return rows[0] || null;
  },

  redeemGiftCard: async (id, amount_cents) => {
    const { rows } = await pool.query(
      `UPDATE gift_cards
       SET remaining_amount_cents = remaining_amount_cents - $2,
           status = CASE WHEN remaining_amount_cents - $2 <= 0 THEN 'depleted' ELSE status END
       WHERE id = $1 AND remaining_amount_cents >= $2
       RETURNING *`,
      [id, amount_cents]
    );
    return rows[0] || null;
  },

  getAllGiftCards: async () => {
    const { rows } = await pool.query(
      `SELECT * FROM gift_cards ORDER BY created_at DESC`
    );
    return rows;
  },
};

module.exports = { initializeDB, getPool, queries };
