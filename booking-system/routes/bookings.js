/**
 * routes/bookings.js
 * Create and list customer bookings.
 */

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { queries, getPool } = require('../db/database');
const { requireAuth } = require('./auth');
const { sendBookingConfirmation, sendSelfCancelledEmail } = require('../utils/email');
const { promoteWaitlist } = require('../utils/waitlist-promote');
const nlTime = require('../utils/nl-time');

const router = express.Router();

// Wat de klant van een slot te zien krijgt (geen interne notities e.d.)
function publicSlot(slot) {
  const capacity = slot.max_capacity || slot.type_capacity;
  return {
    id:              slot.id,
    session_type_id: slot.session_type_id,
    session_name:    slot.session_name,
    date:            slot.date,
    start_time:      slot.start_time,
    end_time:        slot.end_time,
    price_cents:     slot.price_cents,
    artist:          slot.artist,
    is_private:      slot.is_private,
    capacity,
    spots_left:      capacity - slot.booked,
  };
}

// Annuleer openstaande (pending) boekingen van een gebruiker. Met newBookingId
// worden alleen óudere pendings geannuleerd, zodat bij parallelle requests
// altijd de nieuwste boeking overleeft en ze elkaar niet allebei wegannuleren.
// Boekingen waarvan de betaling al gelukt of onderweg is blijven staan.
async function supersedePendingBookings(userId, newBookingId = null) {
  const stalePending = await queries.getPendingBookingsByUser(userId);
  for (const old of stalePending) {
    if (newBookingId !== null && old.id >= newBookingId) continue;
    if (old.stripe_payment_intent_id) {
      try {
        await stripe.paymentIntents.cancel(old.stripe_payment_intent_id);
      } catch (e) {
        try {
          const intent = await stripe.paymentIntents.retrieve(old.stripe_payment_intent_id);
          if (intent && (intent.status === 'succeeded' || intent.status === 'processing')) continue;
        } catch (e2) { /* intent onbekend bij Stripe - boeking kan gewoon weg */ }
      }
    }
    await queries.cancelBooking(old.id);
  }
}

// POST /api/bookings - create a pending booking
router.post('/', requireAuth, async (req, res) => {
  const { slot_id, promo_code, kantine_addon } = req.body;
  let { group_size } = req.body;
  if (!slot_id || !group_size)
    return res.status(400).json({ error: 'slot_id and group_size are required' });

  const slot = await queries.getSlotById(slot_id);
  if (!slot)             return res.status(404).json({ error: 'Slot not found' });
  if (slot.is_cancelled) return res.status(400).json({ error: 'This slot has been cancelled' });

  // date/start_time zijn VARCHAR; vergelijk in NL-tijd (server draait in UTC)
  const nowNL = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  if (slot.date + ' ' + slot.start_time < nowNL)
    return res.status(400).json({ error: 'This session has already started and can no longer be booked' });

  const capacity  = slot.max_capacity || slot.type_capacity;
  // Eigen oude pending boekingen op dit slot tellen niet mee als bezet: die
  // worden vlak vóór het aanmaken vervangen (supersedePendingBookings). De
  // supersede zelf gebeurt bewust pas ná alle validaties, zodat een afgewezen
  // request nooit iemands lopende boeking annuleert.
  const { rows: ownPendingRows } = await getPool().query(
    `SELECT COALESCE(SUM(group_size), 0)::int AS seats FROM bookings
     WHERE user_id = $1 AND time_slot_id = $2 AND status = 'pending'
       AND COALESCE(is_walkin, FALSE) = FALSE
       AND (hold_until IS NULL OR hold_until > NOW())
       AND COALESCE(stripe_payment_status, '') NOT IN ('succeeded', 'processing')`,
    [req.user.userId, slot_id]
  );
  const spotsLeft = capacity - slot.booked + ownPendingRows[0].seats;

  if (slot.is_private) {
    // Privéverhuur: één boeking claimt het hele slot voor de afgesproken totaalprijs;
    // group_size van de client wordt genegeerd zodat de prijs niet te manipuleren is.
    if (spotsLeft <= 0)
      return res.status(409).json({ error: 'Dit privéslot is al geboekt.', spots_left: 0 });
    group_size = spotsLeft;
  } else if (group_size < 1 || group_size > 15) {
    return res.status(400).json({ error: 'group_size must be between 1 and 15' });
  } else if (group_size > 8) {
    // Max 8 p.p. boeking; grotere groepen alleen via privéverhuur (rust voor
    // andere bezoekers) - daarvoor moet je contact opnemen.
    return res.status(400).json({
      error: 'Maximaal 8 personen per boeking. Grotere groep? Mail hello@sokisocialsauna.nl voor privéverhuur.',
      code: 'GROUP_TOO_LARGE',
    });
  }

  if (group_size > spotsLeft)
    return res.status(409).json({ error: `Only ${spotsLeft} spot(s) remaining`, spots_left: spotsLeft });

  // Community Rate: goedkopere plek op rustige sessies, alleen solo, max 2 per
  // sessie en 1 p.p., vrijgegeven vanaf 24u vooraf, niet combineerbaar met
  // kortingen of credits. Zie utils/community-rate.js voor de spelregels.
  const isCommunity = req.body.community_rate === true;
  const communityRules = isCommunity ? require('../utils/community-rate') : null;
  if (isCommunity) {
    if (group_size !== 1)
      return res.status(400).json({ error: 'Community Rate geldt alleen voor je eigen plek (1 persoon).', code: 'COMMUNITY_SOLO' });
    if (promo_code)
      return res.status(400).json({ error: 'Community Rate is niet combineerbaar met promotiecodes of cadeaubonnen.', code: 'COMMUNITY_NO_PROMO' });
    if (!communityRules.communityOpen(slot))
      return res.status(400).json({ error: 'Community Rate is voor deze sessie (nog) niet beschikbaar.', code: 'COMMUNITY_CLOSED' });
    if (spotsLeft < communityRules.MIN_FREE_SEATS)
      return res.status(409).json({ error: 'Deze sessie zit al goed vol - er zijn alleen nog reguliere tickets.', code: 'COMMUNITY_FULL' });
    const { rows: commRows } = await getPool().query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE user_id = $2)::int AS mine
       FROM bookings
       WHERE time_slot_id = $1 AND is_community_rate = TRUE AND status != 'cancelled'
         AND (hold_until IS NULL OR hold_until > NOW())
         AND NOT (user_id = $2 AND status = 'pending'
                  AND COALESCE(stripe_payment_status, '') NOT IN ('succeeded', 'processing'))`,
      [slot_id, req.user.userId]
    );
    if (commRows[0].mine > 0)
      return res.status(409).json({ error: 'Je hebt al een Community Rate-ticket voor deze sessie (max 1 per persoon).', code: 'COMMUNITY_OWN' });
    if (commRows[0].total >= communityRules.MAX_PER_SLOT)
      return res.status(409).json({ error: 'De Community Rate-plekken voor deze sessie zijn al vergeven.', code: 'COMMUNITY_FULL' });
  }

  // Free-slot rule: each account may book only ONE free (price_cents=0) session
  // (geldt niet voor privéverhuur - daar bepaalt SOKI zelf de prijs/groep)
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

  // Validate promo / test code (testcode werkt bewust nooit in productie:
  // het is een sleutel die élke boeking gratis maakt)
  const testCode = process.env.NODE_ENV === 'production' ? null : process.env.TEST_BOOKING_CODE;
  const isFree   = testCode && promo_code && promo_code.trim().toUpperCase() === testCode.toUpperCase();

  // Validate milestone reward code or gift card
  let milestoneEntry = null;
  let giftCard       = null;
  let discountCode   = null;
  let discountCents  = 0;
  // Privéverhuur: price_cents is de totaalprijs voor de hele groep, niet per persoon
  const grossTotal = slot.is_private ? slot.price_cents
    : isCommunity ? communityRules.communityPriceCents(slot)
    : slot.price_cents * group_size;

  // Medehuurderskorting: percentage over ÉÉN plek (alleen de eigen plek van de
  // accounthouder), niet bij privéverhuur of gratis sessies.
  let cotenantCents = 0;
  let isHuurder = false;
  if (!isFree && !slot.is_private && !isCommunity && slot.price_cents > 0) {
    const bookingUser = await queries.getUserById(req.user.userId);
    const pct = bookingUser ? Number(bookingUser.discount_pct) || 0 : 0;
    isHuurder = pct > 0;
    if (pct > 0) cotenantCents = Math.round(slot.price_cents * pct / 100);
  }

  // Combi ticket Kantine: 2-gangendiner, €12 p.p. - huurders (accounts met
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
      // mee als beschikbaar - voorkomt dubbel besteden van dezelfde bon. Eigen
      // pendings tellen niet mee: die worden zo direct gesuperseded.
      const { rows: reservedRows } = await getPool().query(
        `SELECT COALESCE(SUM(pending_discount_cents), 0)::int AS reserved
         FROM bookings
         WHERE pending_gift_card_id = $1 AND status = 'pending' AND user_id != $2
           AND (hold_until IS NULL OR hold_until > NOW())`,
        [giftCard.id, req.user.userId]
      );
      const available = giftCard.remaining_amount_cents - reservedRows[0].reserved;
      if (available <= 0)
        return res.status(400).json({ error: 'Het saldo van deze cadeaubon is al in gebruik voor een andere boeking.' });
      discountCents = Math.min(available, bookingTotal);
    } else {
      // Try milestone code
      milestoneEntry = await queries.getMilestoneByCode(promo_code.trim());
      if (milestoneEntry) {
        // Milestone-codes zijn persoonlijk - alleen de eigenaar mag ze gebruiken
        if (milestoneEntry.user_id !== req.user.userId)
          return res.status(400).json({ error: 'Ongeldige promotiecode.' });
        if (slot.is_private)
          return res.status(400).json({ error: 'Promotiecodes zijn niet geldig voor privéverhuur.' });
        const { rows: msPending } = await getPool().query(
          `SELECT 1 FROM bookings WHERE pending_milestone_id = $1 AND status = 'pending' AND user_id != $2
             AND (hold_until IS NULL OR hold_until > NOW()) LIMIT 1`,
          [milestoneEntry.id, req.user.userId]
        );
        if (msPending[0])
          return res.status(400).json({ error: 'Deze code is al in gebruik voor een andere boeking.' });
        if (milestoneEntry.milestone === 5) {
          if (group_size < 2)
            return res.status(400).json({ error: 'Deze code is geldig voor een groep van minimaal 2 personen.' });
          discountCents = slot.price_cents;
        } else if (milestoneEntry.milestone === 25) {
          // Eén gratis sessie: de eigen plek, niet de hele groep
          discountCents = Math.min(slot.price_cents, grossTotal);
        } else {
          // Mijlpaal 10 (sauna hat) en 50 (VIP) zijn geen boekingskorting: niet
          // als €0-korting aan de boeking hangen - de code zou bij betaling
          // verbrand worden zonder dat de klant er iets voor terugkrijgt.
          return res.status(400).json({ error: 'Deze beloning wissel je niet in bij een boeking - neem hem mee naar de balie of mail ons.' });
        }
      } else {
        // Try admin-managed discount code
        const { validateDiscountCode, discountAmount } = require('../utils/discount-codes');
        const result = await validateDiscountCode(promo_code, req.user.userId, 'booking');
        if (result.notFound)
          return res.status(400).json({ error: 'Ongeldige promotiecode.' });
        if (result.error)
          return res.status(400).json({ error: result.error });
        if (slot.is_private)
          return res.status(400).json({ error: 'Promotiecodes zijn niet geldig voor privéverhuur.' });
        discountCode = result.code;
        discountCents = discountAmount(discountCode, bookingTotal);
      }
    }
  }

  const totalCents = isFree ? 0 : Math.max(0, grossTotal - cotenantCents + kantineCents - discountCents);

  // Max 1 open boeking per gebruiker: eerdere onafgemaakte boekingen worden
  // vervangen door de nieuwe. Loopt de betaling van een oude boeking nog
  // (of is die al gelukt), dan blijft die staan. Dit gebeurt pas nu, ná alle
  // validaties: een afgewezen request laat bestaande boekingen ongemoeid.
  await supersedePendingBookings(req.user.userId);

  let booking;
  try {
    booking = await queries.createBooking(req.user.userId, slot_id, group_size, totalCents, isFree ? 0 : kantineCents, isCommunity);
  } catch (err) {
    if (err.code === 'NO_CAPACITY')
      return res.status(409).json({ error: err.message, spots_left: err.spots_left });
    if (err.code === 'NO_COMMUNITY')
      return res.status(409).json({ error: err.message, code: 'COMMUNITY_FULL' });
    throw err;
  }

  // Nogmaals na het aanmaken: twee parallelle requests kunnen allebei langs de
  // eerste supersede-check komen; deze naloop (alleen oudere pendings)
  // herstelt "max 1 pending" alsnog.
  try {
    await supersedePendingBookings(req.user.userId, booking.id);
  } catch (e) {
    console.error('Supersede after create failed (non-fatal):', e.message);
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
      // Vastleggen wat er van de bon af is: zonder dit krijgt een volledig
      // met cadeaubon betaalde boeking bij annuleren nooit het saldo terug
      await pool.query(
        'UPDATE bookings SET applied_gift_card_id = $2, applied_gift_discount_cents = $3 WHERE id = $1',
        [booking.id, giftCard.id, discountCents]
      );
    }
    if (milestoneEntry) {
      const redeemed = await queries.redeemMilestoneCode(milestoneEntry.id);
      if (!redeemed) {
        await pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [booking.id]);
        return res.status(409).json({ error: 'Deze code is net al gebruikt. Probeer opnieuw.' });
      }
      await pool.query('UPDATE bookings SET applied_milestone_id = $2 WHERE id = $1', [booking.id, milestoneEntry.id]);
    }
    if (discountCode) await queries.redeemDiscountCode(discountCode.id, req.user.userId, { bookingId: booking.id });
    await pool.query(
      "UPDATE bookings SET status = 'confirmed', stripe_payment_status = 'free', confirmation_sent = TRUE WHERE id = $1",
      [booking.id]
    );
    try {
      const fullBooking = await queries.getBookingById(booking.id);
      await sendBookingConfirmation(fullBooking);
    } catch (e) { console.error('Promo email error:', e.message); }
    return res.status(201).json({ booking_id: booking.id, total_cents: 0, free: true, slot: publicSlot(slot), group_size });
  }

  // Partial discount: store the promo on the booking - it is only actually
  // redeemed once payment succeeds (payments /confirm or the Stripe webhook),
  // so an abandoned checkout never costs the customer their code/balance.
  if (giftCard) {
    // Atomair reserveren onder rijlock: parallelle boekingen kunnen niet
    // allebei hetzelfde saldo claimen.
    const reserved = await queries.reserveGiftCardOnBooking(booking.id, giftCard.id, discountCents);
    if (!reserved) {
      await queries.cancelBooking(booking.id);
      return res.status(409).json({ error: 'Het saldo van deze cadeaubon is net gebruikt voor een andere boeking. Probeer opnieuw.' });
    }
  } else if (milestoneEntry || discountCode) {
    await queries.setBookingPendingPromo(
      booking.id,
      null,
      milestoneEntry ? milestoneEntry.id : null,
      discountCents,
      discountCode ? discountCode.id : null
    );
  }

  res.status(201).json({
    booking_id:     booking.id,
    total_cents:    totalCents,
    community_rate: isCommunity || undefined,
    discount_cents: discountCents,
    cotenant_discount_cents: cotenantCents,
    kantine_addon_cents: kantineCents,
    gift_card_remaining: giftCard ? Math.max(0, giftCard.remaining_amount_cents - discountCents) : undefined,
    slot: publicSlot(slot),
    group_size,
  });
});

// GET /api/bookings - list bookings for logged-in user
router.get('/', requireAuth, async (req, res) => {
  const bookings = await queries.getBookingsByUser(req.user.userId);
  res.json(bookings);
});

// GET /api/bookings/:id - single booking detail
router.get('/:id', requireAuth, async (req, res) => {
  const booking = await queries.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.user_id !== req.user.userId)
    return res.status(403).json({ error: 'Access denied' });
  res.json(booking);
});

// GET /api/bookings/:id/qr - get QR check-in URL for confirmed booking
router.get('/:id/qr', requireAuth, async (req, res) => {
  const booking = await queries.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.user_id !== req.user.userId) return res.status(403).json({ error: 'Access denied' });
  if (booking.status !== 'confirmed') return res.status(400).json({ error: 'Booking not confirmed' });
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', process.env.KANTINE_KEY_SECRET || process.env.JWT_SECRET || 'dev_secret_change_me')
    .update(String(booking.id)).digest('hex').slice(0, 16);
  const url = `${process.env.BASE_URL || 'http://localhost:3001'}/checkin?bid=${booking.id}&sig=${sig}`;
  res.json({ url, booking_id: booking.id });
});

// PATCH /api/bookings/:id/cancel - user cancels their own booking
router.patch('/:id/cancel', requireAuth, async (req, res) => {
  const booking = await queries.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.user_id !== req.user.userId)
    return res.status(403).json({ error: 'Access denied' });
  if (booking.status === 'cancelled')
    return res.status(400).json({ error: 'Booking is already cancelled' });

  // Tiered cancellation policy:
  //   > 48h before → 100% refund
  //   24-48h before → 50% refund (credits: always fully restored)
  //   < 24h before → no refund; credits forfeited
  //   na de start → annuleren kan niet meer (anders telt een bezochte sessie
  //   niet meer mee, bijv. voor de regel "één gratis sessie per account")
  // Uren tot de sessie via echte tijdstippen (DST-proof), zie utils/nl-time.
  const dateStr    = nlTime.normalizeDate(booking.date);
  const hoursUntil = nlTime.hoursUntil(booking.date, booking.start_time);
  if (Number.isNaN(hoursUntil))
    return res.status(500).json({ error: 'Could not determine session time - please contact us to cancel' });
  if (hoursUntil <= 0)
    return res.status(400).json({ error: 'Deze sessie is al begonnen of geweest en kan niet meer worden geannuleerd. / This session has already started and can no longer be cancelled.' });
  const refundPct = hoursUntil >= 48 ? 100 : (hoursUntil >= 24 ? 50 : 0);

  // Annulering atomair claimen vóór de refund: twee parallelle cancel-verzoeken
  // zouden anders allebei een (deel)refund aanmaken. De claim geeft de actuele
  // betaalstatus terug (de webhook kan de betaling intussen bevestigd hebben).
  const claimed = await queries.claimBookingCancel(booking.id);
  if (!claimed)
    return res.status(400).json({ error: 'Booking is already cancelled' });
  const payStatus = claimed.stripe_payment_status;
  const intentId  = claimed.stripe_payment_intent_id;
  const creditsUsed = Number(claimed.credits_used) || 0;

  // Refund via Stripe if payment was confirmed
  let refundAmountCents = 0;
  if (refundPct > 0 && intentId && payStatus === 'succeeded') {
    try {
      // Bij (deels) met credits betaalde boekingen is via Stripe minder dan
      // total_cents betaald (alleen diner, of extra personen + diner), of zelfs
      // niets (oude intent van een afgebroken betaalpoging) - refund berekenen
      // over wat er écht is afgerekend.
      let chargedCents = claimed.total_cents;
      if (creditsUsed > 0) {
        const intent = await stripe.paymentIntents.retrieve(intentId);
        chargedCents = intent.amount_received || 0;
      }
      if (chargedCents > 0) {
        refundAmountCents = refundPct === 100 ? chargedCents : Math.floor(chargedCents * refundPct / 100);
        const refundArgs = { payment_intent: intentId };
        // Only pass amount for partial refund; omit for full so Stripe refunds the whole intent
        if (refundPct !== 100) refundArgs.amount = refundAmountCents;
        await stripe.refunds.create(refundArgs);
      }
    } catch (stripeErr) {
      if (stripeErr.code === 'charge_already_refunded') {
        // Al (handmatig via het Stripe-dashboard) terugbetaald: niets meer te doen
        refundAmountCents = 0;
      } else {
        console.error('Stripe refund failed:', stripeErr.message);
        // Claim terugdraaien zodat de klant het opnieuw kan proberen
        await getPool().query('UPDATE bookings SET status = $2 WHERE id = $1', [booking.id, claimed.prev_status]);
        return res.status(502).json({ error: 'Refund failed - please contact us to cancel' });
      }
    }
  } else if (intentId && payStatus !== 'succeeded' && payStatus !== 'processing') {
    // Onbetaalde boeking: de open betaalintentie sluiten, zodat er niet alsnog
    // betaald wordt op een geannuleerde boeking
    try { await stripe.paymentIntents.cancel(intentId); } catch (e) { /* al betaald of verlopen: late betaling wordt door de webhook terugbetaald */ }
  }

  // Membercredits terug (naar strippenkaart óf abonnement) - maar binnen 24u
  // vóór de sessie ben je ze kwijt. Credits uit een vorige maand of van een
  // inmiddels beëindigd membership komen niet terug (credits_lost).
  let creditsRestored = 0;
  let creditsLost = false;
  if (creditsUsed > 0 && hoursUntil >= 24) {
    const restored = await queries.restoreCreditsForBooking(claimed);
    if (restored) {
      creditsRestored = creditsUsed;
      console.log(`✓ ${creditsUsed} credits teruggestort voor user ${booking.user_id}`);
    } else {
      creditsLost = true;
    }
  }
  // Ingewisselde cadeaubon-portie terug (naar rato van het refundpercentage)
  const giftRestored = await queries.restoreGiftCardForBooking(booking.id, refundPct);
  if (giftRestored) console.log(`✓ Cadeaubon ${giftRestored.gift_card_id}: €${(giftRestored.restored_cents / 100).toFixed(2)} teruggestort`);
  // Bij volledige annulering komt een gebruikte korting-/mijlpaalcode weer vrij
  if (refundPct === 100) {
    const released = await queries.releasePromoForBooking(booking.id);
    if (released) console.log(`✓ Promo vrijgegeven voor boeking #${booking.id}:`, released);
  }

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
    target: `booking:${booking.id}`, detail: `refund ${refundPct}% (${refundAmountCents} cents)`, ip: req.ip,
  });

  // Vrijgekomen plek: eerste betaalde wachtlijster automatisch boeken, anders
  // de eerste onbetaalde een mail sturen
  await promoteWaitlist(booking);

  res.json({
    ok: true,
    refunded: refundAmountCents > 0,
    refund_pct: refundPct,
    refund_amount_cents: refundAmountCents,
    payment_processing: payStatus === 'processing',
    credits_restored: creditsRestored,
    credits_lost: creditsLost || undefined,
    gift_restored_cents: giftRestored ? giftRestored.restored_cents : 0,
  });
});

// POST /api/bookings/:id/confirm-member - confirm booking using subscription credits
router.post('/:id/confirm-member', requireAuth, async (req, res) => {
  const bookingId = parseInt(req.params.id);

  const booking = await queries.getBookingById(bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.user_id !== req.user.userId) return res.status(403).json({ error: 'Access denied' });
  if (booking.status !== 'pending') return res.status(400).json({ error: 'Booking already processed' });
  if (booking.kantine_addon_cents > 0)
    return res.status(400).json({ error: 'Het combi ticket met Kantine kan niet met credits worden geboekt.' });
  if (booking.is_community_rate)
    return res.status(400).json({ error: 'Een Community Rate-ticket kan niet met credits worden geboekt.' });
  // Credits zijn persoonlijk: groepsboekingen lopen via de deelbetaling (create-intent)
  if ((booking.group_size || 1) > 1)
    return res.status(400).json({ error: 'Credits gelden alleen voor je eigen plek. Boek een groep via de gewone betaling.' });

  // Verify subscription or punch pass. Alleen een 'active' membership telt:
  // bij een mislukte incasso (past_due) geen credits of Unlimited-toegang.
  const sub = await queries.getEntitledSubscription(req.user.userId);
  const activePasses = await queries.getActivePunchPasses(req.user.userId);
  if (!sub && activePasses.length === 0) {
    if (await queries.getActiveSubscription(req.user.userId))
      return res.status(403).json({ error: 'Je membership heeft een openstaande betaling. Zodra die binnen is, kun je weer met je membership boeken. / Your membership has an outstanding payment. Once it has been received you can book with your membership again.', code: 'MEMBERSHIP_PAST_DUE' });
    return res.status(403).json({ error: 'No active subscription or punch pass' });
  }

  // Server determines the credit cost - never trust the client for this
  const { CREDIT_COST, membershipEndsAt } = require('./subscriptions');
  const slot = await queries.getSlotById(booking.time_slot_id);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  if (slot.is_private)
    return res.status(400).json({ error: 'Privéverhuur kan niet met membershipcredits worden geboekt.' });
  if (await queries.hasCreditsBookingForSlot(req.user.userId, booking.time_slot_id))
    return res.status(400).json({ error: 'Je hebt deze sessie al met je membership of strippenkaart geboekt. Credits gelden alleen voor je eigen plek - extra personen boeken via de gewone betaling.' });
  // Unlimited membership = 0 credits
  const unlimited    = !!(sub && sub.credits_per_month === null);
  const creditsToUse = unlimited ? 0 : (CREDIT_COST[slot.session_type_id] || 1.5);

  // Opgezegd membership: geen sessies ná de einddatum op het membership boeken
  // (de credits komen bij de bevestiging eerst van het membership, pas daarna
  // van een strippenkaart - dus de check geldt zodra het membership betaalt).
  const paysFromSub = sub && (unlimited || (Number(sub.credits_remaining) || 0) >= creditsToUse);
  const endsAt = paysFromSub ? membershipEndsAt(sub) : null;
  if (endsAt && nlTime.nlToDate(slot.date, slot.start_time) > endsAt) {
    const endStr = endsAt.toLocaleDateString('nl-NL', { timeZone: nlTime.TZ, day: 'numeric', month: 'long', year: 'numeric' });
    return res.status(400).json({
      error: `Je membership eindigt op ${endStr}; deze sessie valt daarna. Boek hem via de gewone betaling. / Your membership ends on ${endStr}; this session is after that date. Please book it with a regular payment.`,
      code: 'MEMBERSHIP_ENDED',
    });
  }

  // Een bij het boeken meegegeven bon/code is hier nergens voor nodig (credits
  // dekken de plek volledig): loslaten in plaats van voor niets inwisselen
  await queries.clearPendingPromo(bookingId);

  // Credits afschrijven + bevestigen via de kanonieke, idempotente helper: die
  // locket de boekingsrij en bevestigt alléén een pending boeking. Een dubbel-
  // klik of een race met de betaalwebhook kan zo nooit dubbel afschrijven.
  const result = await queries.confirmBookingWithCredits(bookingId, req.user.userId, creditsToUse, null, null, unlimited ? sub.id : null);
  if (result.insufficient)
    return res.status(400).json({ error: 'Insufficient credits' });
  if (result.already) {
    if (result.ok) return res.json({ ok: true, booking_id: bookingId, already_confirmed: true });
    return res.status(400).json({ error: 'Booking already processed' });
  }

  // Send confirmation email (non-fatal, atomaire claim tegen dubbel versturen)
  if (await queries.claimConfirmationSend(bookingId)) {
    try {
      const { sendBookingConfirmation } = require('../utils/email');
      await sendBookingConfirmation({ ...booking });
    } catch (e) {
      console.error('Email failed:', e.message);
      await queries.unclaimConfirmationSend(bookingId).catch(() => {});
    }
  }

  res.json({ ok: true, booking_id: bookingId });
});

module.exports = router;
