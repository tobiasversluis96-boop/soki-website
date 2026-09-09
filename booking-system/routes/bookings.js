/**
 * routes/bookings.js
 * Create and list customer bookings.
 */

const express = require('express');
const { queries, getPool } = require('../db/database');
const { requireAuth } = require('./auth');
const { sendWaitlistNotification, sendAutoBookedEmail, sendBookingConfirmation, sendSelfCancelledEmail } = require('../utils/email');

const router = express.Router();

// POST /api/bookings — create a pending booking
router.post('/', requireAuth, async (req, res) => {
  const { slot_id, promo_code, kantine_addon } = req.body;
  let { group_size } = req.body;
  if (!slot_id || !group_size)
    return res.status(400).json({ error: 'slot_id and group_size are required' });

  const slot = await queries.getSlotById(slot_id);
  if (!slot)             return res.status(404).json({ error: 'Slot not found' });
  if (slot.is_cancelled) return res.status(400).json({ error: 'This slot has been cancelled' });

  const capacity  = slot.max_capacity || slot.type_capacity;
  const spotsLeft = capacity - slot.booked;

  if (slot.is_private) {
    // Privéverhuur: één boeking claimt het hele slot voor de afgesproken totaalprijs;
    // group_size van de client wordt genegeerd zodat de prijs niet te manipuleren is.
    if (spotsLeft <= 0)
      return res.status(409).json({ error: 'Dit privéslot is al geboekt.', spots_left: 0 });
    group_size = spotsLeft;
  } else if (group_size < 1 || group_size > 15) {
    return res.status(400).json({ error: 'group_size must be between 1 and 15' });
  }

  if (group_size > spotsLeft)
    return res.status(409).json({ error: `Only ${spotsLeft} spot(s) remaining`, spots_left: spotsLeft });

  // Free-slot rule: each account may book only ONE free (price_cents=0) session
  // (geldt niet voor privéverhuur — daar bepaalt SOKI zelf de prijs/groep)
  if (slot.price_cents === 0 && !slot.is_private) {
    const used = await queries.countUserFreeSlotBookings(req.user.userId);
    if (used > 0) {
      return res.status(409).json({
        error: 'Je hebt al een gratis sessie geboekt. Elk account mag één gratis sessie ervaren.',
        code: 'FREE_ALREADY_USED',
      });
    }
    if (group_size > 1) {
      return res.status(400).json({
        error: 'Voor een gratis sessie kun je alleen voor jezelf boeken (1 persoon).',
        code: 'FREE_GROUP_TOO_LARGE',
      });
    }
  }

  // Validate promo / test code
  const testCode = process.env.TEST_BOOKING_CODE;
  const isFree   = testCode && promo_code && promo_code.trim().toUpperCase() === testCode.toUpperCase();

  // Validate milestone reward code or gift card
  let milestoneEntry = null;
  let giftCard       = null;
  let discountCents  = 0;
  // Privéverhuur: price_cents is de totaalprijs voor de hele groep, niet per persoon
  const grossTotal = slot.is_private ? slot.price_cents : slot.price_cents * group_size;

  // Medehuurderskorting: percentage over ÉÉN plek (alleen de eigen plek van de
  // accounthouder), niet bij privéverhuur of gratis sessies.
  let cotenantCents = 0;
  let isHuurder = false;
  if (!isFree && !slot.is_private && slot.price_cents > 0) {
    const bookingUser = await queries.getUserById(req.user.userId);
    const pct = bookingUser ? Number(bookingUser.discount_pct) || 0 : 0;
    isHuurder = pct > 0;
    if (pct > 0) cotenantCents = Math.round(slot.price_cents * pct / 100);
  }

  // Combi ticket De Kantine: 2-gangendiner, €12 p.p. — huurders (accounts met
  // huurderskorting) betalen hun vaste Kantine-prijs van €10 p.p. Alleen bij
  // betaalde losse sessies (niet gratis, niet privéverhuur); creditsboekingen
  // worden in confirm-member geweigerd zolang er een addon op de boeking staat.
  const KANTINE_ADDON_CENTS = isHuurder ? 1000 : 1200;
  let kantineCents = 0;
  if (kantine_addon === true && !isFree && !slot.is_private && slot.price_cents > 0)
    kantineCents = KANTINE_ADDON_CENTS * group_size;

  if (!isFree && promo_code) {
    const bookingTotal = grossTotal - cotenantCents + kantineCents;

    // Check gift card first
    giftCard = await queries.getGiftCardByCode(promo_code.trim());
    if (giftCard) {
      if (giftCard.status === 'pending')
        return res.status(400).json({ error: 'Deze cadeaubon is nog niet geactiveerd.' });
      if (giftCard.status === 'depleted')
        return res.status(400).json({ error: 'Deze cadeaubon is volledig gebruikt.' });
      if (giftCard.status === 'expired' || new Date(giftCard.expires_at) < new Date())
        return res.status(400).json({ error: 'Deze cadeaubon is verlopen.' });
      // Saldo dat al gereserveerd is op andere lopende (pending) boekingen telt niet
      // mee als beschikbaar — voorkomt dubbel besteden van dezelfde bon.
      const { rows: reservedRows } = await getPool().query(
        `SELECT COALESCE(SUM(pending_discount_cents), 0)::int AS reserved
         FROM bookings
         WHERE pending_gift_card_id = $1 AND status = 'pending'
           AND (hold_until IS NULL OR hold_until > NOW())`,
        [giftCard.id]
      );
      const available = giftCard.remaining_amount_cents - reservedRows[0].reserved;
      if (available <= 0)
        return res.status(400).json({ error: 'Het saldo van deze cadeaubon is al in gebruik voor een andere boeking.' });
      discountCents = Math.min(available, bookingTotal);
    } else {
      // Try milestone code
      milestoneEntry = await queries.getMilestoneByCode(promo_code.trim());
      if (!milestoneEntry) {
        return res.status(400).json({ error: 'Ongeldige promotiecode.' });
      }
      if (slot.is_private)
        return res.status(400).json({ error: 'Promotiecodes zijn niet geldig voor privéverhuur.' });
      const { MILESTONES } = require('../utils/milestones');
      const milestoneDef = MILESTONES.find(m => m.visits === milestoneEntry.milestone);
      if (milestoneDef) {
        if (milestoneEntry.milestone === 5) {
          if (group_size < 2)
            return res.status(400).json({ error: 'Deze code is geldig voor een groep van minimaal 2 personen.' });
          discountCents = slot.price_cents;
        } else if (milestoneEntry.milestone === 25) {
          discountCents = grossTotal;
        }
      }
    }
  }

  const totalCents = isFree ? 0 : Math.max(0, grossTotal - cotenantCents + kantineCents - discountCents);
  let booking;
  try {
    booking = await queries.createBooking(req.user.userId, slot_id, group_size, totalCents, isFree ? 0 : kantineCents);
  } catch (err) {
    if (err.code === 'NO_CAPACITY')
      return res.status(409).json({ error: err.message, spots_left: err.spots_left });
    throw err;
  }

  // Fully free: confirm immediately without Stripe.
  // Inwisselen gebeurt VÓÓR het bevestigen: als het bonsaldo intussen op is
  // (parallelle boeking), wordt deze boeking geannuleerd i.p.v. gratis bevestigd.
  if (isFree || totalCents === 0) {
    const pool = getPool();
    if (giftCard && discountCents > 0) {
      const redeemed = await queries.redeemGiftCard(giftCard.id, discountCents);
      if (!redeemed) {
        await pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [booking.id]);
        return res.status(409).json({ error: 'Het saldo van deze cadeaubon is net gebruikt voor een andere boeking. Probeer opnieuw.' });
      }
    }
    if (milestoneEntry) await queries.redeemMilestoneCode(milestoneEntry.id);
    await pool.query(
      "UPDATE bookings SET status = 'confirmed', stripe_payment_status = 'free', confirmation_sent = TRUE WHERE id = $1",
      [booking.id]
    );
    try {
      const fullBooking = await queries.getBookingById(booking.id);
      await sendBookingConfirmation(fullBooking);
    } catch (e) { console.error('Promo email error:', e.message); }
    return res.status(201).json({ booking_id: booking.id, total_cents: 0, free: true, slot, group_size });
  }

  // Partial discount: store the promo on the booking — it is only actually
  // redeemed once payment succeeds (payments /confirm or the Stripe webhook),
  // so an abandoned checkout never costs the customer their code/balance.
  if (milestoneEntry || giftCard) {
    await queries.setBookingPendingPromo(
      booking.id,
      giftCard ? giftCard.id : null,
      milestoneEntry ? milestoneEntry.id : null,
      discountCents
    );
  }

  res.status(201).json({
    booking_id:     booking.id,
    total_cents:    totalCents,
    discount_cents: discountCents,
    cotenant_discount_cents: cotenantCents,
    kantine_addon_cents: kantineCents,
    gift_card_remaining: giftCard ? Math.max(0, giftCard.remaining_amount_cents - discountCents) : undefined,
    slot,
    group_size,
  });
});

// GET /api/bookings — list bookings for logged-in user
router.get('/', requireAuth, async (req, res) => {
  const bookings = await queries.getBookingsByUser(req.user.userId);
  res.json(bookings);
});

// GET /api/bookings/:id — single booking detail
router.get('/:id', requireAuth, async (req, res) => {
  const booking = await queries.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.user_id !== req.user.userId)
    return res.status(403).json({ error: 'Access denied' });
  res.json(booking);
});

// GET /api/bookings/:id/qr — get QR check-in URL for confirmed booking
router.get('/:id/qr', requireAuth, async (req, res) => {
  const booking = await queries.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.user_id !== req.user.userId) return res.status(403).json({ error: 'Access denied' });
  if (booking.status !== 'confirmed') return res.status(400).json({ error: 'Booking not confirmed' });
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev_secret_change_me')
    .update(String(booking.id)).digest('hex').slice(0, 16);
  const url = `${process.env.BASE_URL || 'http://localhost:3001'}/checkin?bid=${booking.id}&sig=${sig}`;
  res.json({ url, booking_id: booking.id });
});

// PATCH /api/bookings/:id/cancel — user cancels their own booking
router.patch('/:id/cancel', requireAuth, async (req, res) => {
  const booking = await queries.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.user_id !== req.user.userId)
    return res.status(403).json({ error: 'Access denied' });
  if (booking.status === 'cancelled')
    return res.status(400).json({ error: 'Booking is already cancelled' });

  // Tiered cancellation policy (cancelling is always allowed before the session):
  //   > 48h before → 100% refund
  //   24-48h before → 50% refund (credits: always fully restored)
  //   < 24h before → no refund; credits forfeited
  // pg returns DATE columns as JS Date objects and TIME as 'HH:MM:SS' —
  // normalise both before combining, otherwise this yields Invalid Date/NaN.
  const dateStr = booking.date instanceof Date
    ? `${booking.date.getFullYear()}-${String(booking.date.getMonth() + 1).padStart(2, '0')}-${String(booking.date.getDate()).padStart(2, '0')}`
    : String(booking.date).slice(0, 10);
  const timeStr = String(booking.start_time).length === 5 ? booking.start_time + ':00' : String(booking.start_time);
  const sessionDatetime = new Date(`${dateStr}T${timeStr}`);
  const hoursUntil = (sessionDatetime - Date.now()) / 36e5;
  if (Number.isNaN(hoursUntil))
    return res.status(500).json({ error: 'Could not determine session time — please contact us to cancel' });
  const refundPct = hoursUntil >= 48 ? 100 : (hoursUntil >= 24 ? 50 : 0);

  // Refund via Stripe if payment was confirmed
  let refundAmountCents = 0;
  if (refundPct > 0 && booking.stripe_payment_intent_id && booking.stripe_payment_status === 'succeeded') {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      // Bij (deels) met credits betaalde boekingen is via Stripe minder dan total_cents
      // betaald (alleen diner, of extra personen + diner) — refund berekenen over wat
      // er écht is afgerekend, dus het bedrag van de payment intent zelf.
      const chargedCents = booking.credits_used > 0
        ? (await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id)).amount_received
        : booking.total_cents;
      refundAmountCents = refundPct === 100
        ? chargedCents
        : Math.floor(chargedCents * refundPct / 100);
      const refundArgs = { payment_intent: booking.stripe_payment_intent_id };
      // Only pass amount for partial refund; omit for full so Stripe refunds the whole intent
      if (refundPct !== 100) refundArgs.amount = refundAmountCents;
      await stripe.refunds.create(refundArgs);
    } catch (stripeErr) {
      console.error('Stripe refund failed:', stripeErr.message);
      return res.status(502).json({ error: 'Refund failed — please contact us to cancel' });
    }
  }

  await queries.cancelBooking(req.params.id);

  // Membercredits terug (naar strippenkaart óf abonnement) — maar binnen 24u vóór de sessie ben je ze kwijt
  let creditsRestored = 0;
  if (booking.credits_used > 0 && hoursUntil >= 24) {
    const restored = await queries.restoreCreditsForBooking(booking);
    if (restored) {
      creditsRestored = booking.credits_used;
      console.log(`✓ ${booking.credits_used} credits teruggestort voor user ${booking.user_id}`);
    }
  }
  // Ingewisselde cadeaubon-portie terug (naar rato van het refundpercentage)
  const giftRestored = await queries.restoreGiftCardForBooking(booking.id, refundPct);
  if (giftRestored) console.log(`✓ Cadeaubon ${giftRestored.gift_card_id}: €${(giftRestored.restored_cents / 100).toFixed(2)} teruggestort`);

  try {
    await sendSelfCancelledEmail({
      customer_name:       booking.customer_name,
      customer_email:      booking.customer_email,
      session_name:        booking.session_name,
      date:                dateStr,
      start_time:          booking.start_time,
      end_time:            booking.end_time,
      refund_amount_cents: refundAmountCents,
      refund_pct:          refundPct,
      credits_restored:    creditsRestored,
    });
  } catch (e) {
    console.error('Self-cancel email failed (non-fatal):', e.message);
  }

  queries.auditLog({
    actor_type: 'customer', actor_id: req.user.userId, action: 'booking_cancelled',
    target: `booking:${req.params.id}`, detail: `refund ${refundPct}% (${refundAmountCents} cents)`, ip: req.ip,
  });

  // Auto-book first paid waitlist user, then fall back to notifying unpaid ones
  try {
    const paidWaiter = await queries.getFirstPaidWaitlistUser(booking.time_slot_id);
    if (paidWaiter) {
      // Create a confirmed booking for them (payment already collected)
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
      // No paid waiters — notify first unpaid waitlist user
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

  res.json({
    ok: true,
    refunded: booking.stripe_payment_status === 'succeeded',
    refund_pct: refundPct,
    refund_amount_cents: refundAmountCents,
    credits_restored: creditsRestored,
  });
});

// POST /api/bookings/:id/confirm-member — confirm booking using subscription credits
router.post('/:id/confirm-member', requireAuth, async (req, res) => {
  const bookingId = parseInt(req.params.id);

  const booking = await queries.getBookingById(bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.user_id !== req.user.userId) return res.status(403).json({ error: 'Access denied' });
  if (booking.status !== 'pending') return res.status(400).json({ error: 'Booking already processed' });
  if (booking.kantine_addon_cents > 0)
    return res.status(400).json({ error: 'Het combi ticket met De Kantine kan niet met credits worden geboekt.' });
  // Credits zijn persoonlijk: groepsboekingen lopen via de deelbetaling (create-intent)
  if ((booking.group_size || 1) > 1)
    return res.status(400).json({ error: 'Credits gelden alleen voor je eigen plek. Boek een groep via de gewone betaling.' });

  // Verify subscription or punch pass
  const sub = await queries.getActiveSubscription(req.user.userId);
  const activePasses = await queries.getActivePunchPasses(req.user.userId);
  if (!sub && activePasses.length === 0)
    return res.status(403).json({ error: 'No active subscription or punch pass' });

  // Server determines the credit cost — never trust the client for this
  const { CREDIT_COST } = require('./subscriptions');
  const slot = await queries.getSlotById(booking.time_slot_id);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  if (slot.is_private)
    return res.status(400).json({ error: 'Privéverhuur kan niet met membershipcredits worden geboekt.' });
  // Unlimited membership = 0 credits
  const creditsToUse = (sub && sub.credits_per_month === null) ? 0 : (CREDIT_COST[slot.session_type_id] || 1.5);

  // Deduct credits + confirm booking in a single transaction
  const pool = getPool();
  const client = await pool.connect();
  let punchPassId = null;
  try {
    await client.query('BEGIN');
    if (creditsToUse > 0) {
      // Eerst het abonnement proberen, anders één strippenkaart (vroegst-verlopend) met genoeg saldo
      const { rows } = await client.query(
        'UPDATE subscriptions SET credits_remaining = credits_remaining - $1 WHERE user_id = $2 AND status IN (\'active\', \'past_due\') AND credits_remaining >= $1 RETURNING *',
        [creditsToUse, req.user.userId]
      );
      if (!rows[0]) {
        const pp = await client.query(`
          UPDATE punch_passes SET credits_remaining = credits_remaining - $1
          WHERE id = (
            SELECT id FROM punch_passes
            WHERE user_id = $2 AND credits_remaining >= $1 AND expires_at > NOW()
            ORDER BY expires_at LIMIT 1
          ) RETURNING id
        `, [creditsToUse, req.user.userId]);
        if (!pp.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Insufficient credits' });
        }
        punchPassId = pp.rows[0].id;
      }
    }
    await client.query(
      "UPDATE bookings SET status = 'confirmed', credits_used = $2, punch_pass_id = $3 WHERE id = $1",
      [bookingId, creditsToUse, punchPassId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Redeem any promo attached at booking time (idempotent, no-op if none)
  await queries.redeemPendingPromo(bookingId);

  // Send confirmation email (non-fatal, guarded by confirmation_sent flag)
  if (!booking.confirmation_sent) {
    try {
      const { sendBookingConfirmation } = require('../utils/email');
      await sendBookingConfirmation({ ...booking });
    } catch (e) { console.error('Email failed:', e.message); }
  }

  res.json({ ok: true, booking_id: bookingId });
});

module.exports = router;
