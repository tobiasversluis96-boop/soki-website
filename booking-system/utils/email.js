const { BrevoClient } = require('@getbrevo/brevo');
const crypto = require('crypto');

function generateCheckinSig(bookingId) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev_secret_change_me')
    .update(String(bookingId))
    .digest('hex')
    .slice(0, 16);
}

let client;
function getClient() {
  if (!client) client = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });
  return client;
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

async function send(templateId, to, name, params) {
  await getClient().transactionalEmails.sendTransacEmail({
    to: [{ email: to, name }],
    templateId: Number(templateId),
    params,
  });
}

async function sendBookingConfirmation(booking) {
  await send(
    process.env.BREVO_TEMPLATE_CONFIRMATION,
    booking.customer_email,
    booking.customer_name,
    {
      CUSTOMER_NAME:  booking.customer_name,
      BOOKING_ID:     booking.id,
      SESSION_NAME:   booking.session_name,
      DATE:           formatDate(booking.date),
      START_TIME:     booking.start_time,
      END_TIME:       booking.end_time,
      GROUP_SIZE:     booking.group_size,
      TOTAL:          `€${(booking.total_cents / 100).toFixed(2)}`,
      CHECKIN_URL:    `${process.env.BASE_URL || 'http://localhost:3001'}/ticket?bid=${booking.id}&sig=${generateCheckinSig(booking.id)}`,
    }
  );
}

async function sendReminderEmail(booking) {
  await send(
    process.env.BREVO_TEMPLATE_REMINDER,
    booking.customer_email,
    booking.customer_name,
    {
      CUSTOMER_NAME: booking.customer_name,
      SESSION_NAME:  booking.session_name,
      DATE:          formatDate(booking.date),
      START_TIME:    booking.start_time,
      END_TIME:      booking.end_time,
      GROUP_SIZE:    booking.group_size,
      TOTAL:         `€${(booking.total_cents / 100).toFixed(2)}`,
      CHECKIN_URL:   `${process.env.BASE_URL || 'http://localhost:3001'}/ticket?bid=${booking.id}&sig=${generateCheckinSig(booking.id)}`,
    }
  );
}

async function sendPasswordResetEmail({ name, email, token }) {
  await send(
    process.env.BREVO_TEMPLATE_PASSWORD_RESET,
    email,
    name,
    {
      CUSTOMER_NAME: name,
      RESET_URL:     `${process.env.BASE_URL || 'http://localhost:3001'}/reset-password?token=${token}`,
    }
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Geen Brevo-template nodig: de code-mail wordt als kant-en-klare HTML verstuurd
async function sendVerificationEmail({ name, email, code }) {
  await getClient().transactionalEmails.sendTransacEmail({
    to: [{ email, name }],
    sender: {
      email: process.env.EMAIL_FROM,
      name:  process.env.EMAIL_FROM_NAME || 'SOKI Social Sauna',
    },
    subject: `${code} — bevestig je e-mailadres / confirm your email`,
    htmlContent: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#4A1C0C;">
        <h2 style="color:#D94D1A;margin-bottom:0.5rem;">SOKI Social Sauna</h2>
        <p>Hoi ${escapeHtml(name)},</p>
        <p>Bevestig je e-mailadres met deze code:<br>
           <span style="color:#8C7B6B;">Confirm your email address with this code:</span></p>
        <p style="font-size:32px;font-weight:bold;letter-spacing:6px;background:#FBEFE3;padding:16px 24px;border-radius:12px;text-align:center;">${escapeHtml(code)}</p>
        <p>De code is 15 minuten geldig. / This code is valid for 15 minutes.</p>
        <p style="color:#8C7B6B;font-size:13px;">Heb je geen account aangemaakt bij SOKI? Dan kun je deze mail negeren.<br>
           Didn't create a SOKI account? You can safely ignore this email.</p>
      </div>`,
  });
}

async function sendWaitlistNotification({ customer_name, customer_email, session_name, date, start_time, end_time }) {
  await send(
    process.env.BREVO_TEMPLATE_WAITLIST,
    customer_email,
    customer_name,
    {
      CUSTOMER_NAME: customer_name,
      SESSION_NAME:  session_name,
      DATE:          formatDate(date),
      START_TIME:    start_time,
      END_TIME:      end_time,
      BOOK_URL:      `${process.env.BASE_URL || 'http://localhost:3001'}/booking`,
    }
  );
}

async function sendAutoBookedEmail({ id, customer_name, customer_email, session_name, date, start_time, end_time, group_size, total_cents }) {
  await send(
    process.env.BREVO_TEMPLATE_AUTO_BOOKED,
    customer_email,
    customer_name,
    {
      CUSTOMER_NAME: customer_name,
      BOOKING_ID:    id,
      SESSION_NAME:  session_name,
      DATE:          formatDate(date),
      START_TIME:    start_time,
      END_TIME:      end_time,
      GROUP_SIZE:    group_size,
      TOTAL:         `€${(total_cents / 100).toFixed(2)}`,
      CHECKIN_URL:   `${process.env.BASE_URL || 'http://localhost:3001'}/ticket?bid=${id}&sig=${generateCheckinSig(id)}`,
    }
  );
}

async function sendMessageReply({ customer_name, customer_email, original_subject, original_body, reply_body }) {
  await send(
    process.env.BREVO_TEMPLATE_MESSAGE_REPLY,
    customer_email,
    customer_name,
    {
      CUSTOMER_NAME:    customer_name,
      REPLY_BODY:       reply_body,
      ORIGINAL_SUBJECT: original_subject || '',
      ORIGINAL_BODY:    original_body,
    }
  );
}

async function sendMilestoneEmail({ customer_name, customer_email, milestone, lang = 'nl' }) {
  await send(
    process.env.BREVO_TEMPLATE_MILESTONE,
    customer_email,
    customer_name,
    {
      CUSTOMER_NAME:     customer_name,
      MILESTONE_EMOJI:   milestone.emoji,
      MILESTONE_LABEL:   lang === 'nl' ? milestone.label_nl  : milestone.label_en,
      MILESTONE_VISITS:  milestone.visits,
      MILESTONE_REWARD:  lang === 'nl' ? milestone.reward_nl : milestone.reward_en,
      PROMO_CODE:        milestone.promo_code || '',
    }
  );
}

async function sendGiftCardEmail(card) {
  const expires = new Date(card.expires_at).toLocaleDateString('nl-NL', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  await send(
    process.env.BREVO_TEMPLATE_GIFT_CARD,
    card.recipient_email,
    card.recipient_name,
    {
      RECIPIENT_NAME:  card.recipient_name,
      PURCHASER_NAME:  card.purchaser_name,
      AMOUNT:          `€${(card.initial_amount_cents / 100).toFixed(2).replace('.', ',')}`,
      CODE:            card.code,
      EXPIRES:         expires,
      MESSAGE:         card.message || '',
      BOOK_URL:        `${process.env.BASE_URL || 'https://sokisocialsauna.nl'}/booking`,
    }
  );
}

module.exports = {
  sendBookingConfirmation,
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendReminderEmail,
  sendWaitlistNotification,
  sendAutoBookedEmail,
  sendMessageReply,
  sendMilestoneEmail,
  sendGiftCardEmail,
  generateCheckinSig,
};
