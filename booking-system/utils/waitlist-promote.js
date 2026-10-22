/**
 * utils/waitlist-promote.js
 * Zodra er een plek vrijkomt in een slot: de eerste vooruitbetaalde
 * wachtlijst-inschrijving automatisch omzetten in een boeking, anders de
 * eerste onbetaalde wachtende een mailtje sturen. Gedeeld door klant-,
 * admin- en webhook-annuleringen zodat de drie paden nooit uit elkaar lopen.
 */
const { queries, getPool } = require('../db/database');
const { sendWaitlistNotification, sendAutoBookedEmail } = require('./email');
const nlTime = require('./nl-time');

// slotInfo: { time_slot_id, session_name, date, start_time, end_time }
// Fouten worden gelogd, nooit gegooid: een annulering mag hier niet op stuklopen.
async function promoteWaitlist(slotInfo) {
  const slotId = slotInfo.time_slot_id;
  // Een sessie die al begonnen of geweest is krijgt geen wachtlijster meer
  // toegewezen (bijv. bij een refund achteraf van een bezochte sessie)
  if (slotInfo.date && slotInfo.start_time && !(nlTime.hoursUntil(slotInfo.date, slotInfo.start_time) > 0)) return null;
  try {
    const paidWaiter = await queries.getFirstPaidWaitlistUser(slotId);
    if (paidWaiter) {
      // Boeking aanmaken en daarna de wachtlijst-entry atomair claimen; bij een
      // verloren claim-race (gelijktijdige annulering elders) wordt de nieuwe
      // boeking weer geannuleerd - nooit twee boekingen op één betaling.
      const newBooking = await queries.createBooking(
        paidWaiter.user_id, slotId, paidWaiter.group_size, paidWaiter.total_cents
      );
      const claimed = await queries.claimWaitlistEntry(paidWaiter.id, newBooking.id);
      if (!claimed) {
        await queries.cancelBooking(newBooking.id);
        return null;
      }
      await getPool().query(
        "UPDATE bookings SET status = 'confirmed', stripe_payment_intent_id = $2, stripe_payment_status = 'succeeded', confirmation_sent = TRUE WHERE id = $1",
        [newBooking.id, paidWaiter.stripe_payment_intent_id]
      );
      const fullBooking = await queries.getBookingById(newBooking.id);
      await sendAutoBookedEmail(fullBooking);
      console.log(`✓ Auto-booked waitlist user ${paidWaiter.user_id} into booking #${newBooking.id}`);
      return { auto_booked: newBooking.id };
    }

    const waitUser = await queries.getFirstUnnotifiedWaitlistUser(slotId);
    if (waitUser) {
      await sendWaitlistNotification({
        customer_name:  waitUser.customer_name,
        customer_email: waitUser.customer_email,
        session_name:   slotInfo.session_name,
        date:           slotInfo.date,
        start_time:     slotInfo.start_time,
        end_time:       slotInfo.end_time,
        slot_id:        slotId,
      });
      await queries.markWaitlistNotified(waitUser.id);
      return { notified: waitUser.id };
    }
  } catch (err) {
    console.error('Waitlist auto-book error (non-fatal):', err.message);
  }
  return null;
}

module.exports = { promoteWaitlist };
