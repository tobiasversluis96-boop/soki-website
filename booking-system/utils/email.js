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
  const id = Number(templateId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Brevo template id is missing or invalid (got: ${JSON.stringify(templateId)})`);
  }
  await getClient().transactionalEmails.sendTransacEmail({
    to: [{ email: to, name }],
    sender: {
      email: process.env.EMAIL_FROM,
      name:  process.env.EMAIL_FROM_NAME || 'SOKI Social Sauna',
    },
    templateId: id,
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

// Geen Brevo-template nodig: de cadeaubon-mail wordt als kant-en-klare HTML verstuurd
async function sendGiftCardEmail(card) {
  const expiresNl = new Date(card.expires_at).toLocaleDateString('nl-NL', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const expiresEn = new Date(card.expires_at).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const amount  = `€${(card.initial_amount_cents / 100).toFixed(2).replace('.', ',')}`;
  const bookUrl = `${process.env.BASE_URL || 'https://sokisocialsauna.nl'}/booking`;
  const messageBlock = card.message
    ? `<p style="background:#FBEFE3;border-left:4px solid #D94D1A;padding:12px 16px;border-radius:0 12px 12px 0;font-style:italic;">&ldquo;${escapeHtml(card.message)}&rdquo;<br>
         <span style="color:#8C7B6B;font-style:normal;font-size:13px;">&mdash; ${escapeHtml(card.purchaser_name)}</span></p>`
    : '';
  await getClient().transactionalEmails.sendTransacEmail({
    to: [{ email: card.recipient_email, name: card.recipient_name }],
    sender: {
      email: process.env.EMAIL_FROM,
      name:  process.env.EMAIL_FROM_NAME || 'SOKI Social Sauna',
    },
    subject: `Je hebt een cadeaubon van ${amount} gekregen! / You've received a ${amount} gift card!`,
    htmlContent: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#4A1C0C;">
        <h2 style="color:#D94D1A;margin-bottom:0.5rem;">SOKI Social Sauna</h2>
        <p>Hoi ${escapeHtml(card.recipient_name)},</p>
        <p><strong>${escapeHtml(card.purchaser_name)}</strong> heeft een cadeaubon voor je gekocht!<br>
           <span style="color:#8C7B6B;">${escapeHtml(card.purchaser_name)} bought you a gift card!</span></p>
        ${messageBlock}
        <div style="background:#FBEFE3;padding:24px;border-radius:12px;text-align:center;margin:16px 0;">
          <div style="font-size:36px;font-weight:bold;color:#D94D1A;">${amount}</div>
          <div style="color:#8C7B6B;font-size:13px;margin:8px 0 4px;">Cadeauboncode / Gift card code</div>
          <div style="font-size:24px;font-weight:bold;letter-spacing:3px;">${escapeHtml(card.code)}</div>
        </div>
        <p>Vul de code in bij het afrekenen van je boeking op
           <a href="${bookUrl}" style="color:#D94D1A;">sokisocialsauna.nl</a>.<br>
           <span style="color:#8C7B6B;">Enter the code at checkout when booking your session.</span></p>
        <p style="color:#8C7B6B;font-size:13px;">Geldig tot ${expiresNl}. / Valid until ${expiresEn}.</p>
      </div>`,
  });
}

// Geen Brevo-template nodig: de annuleringsmail wordt als kant-en-klare HTML verstuurd
async function sendBookingCancelledEmail(booking, { refunded = false, creditsRestored = 0 } = {}) {
  const [y, m, d] = String(booking.date).split('-').map(Number);
  const dateNl = new Date(y, m - 1, d).toLocaleDateString('nl-NL', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const dateEn = new Date(y, m - 1, d).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const amount  = `€${((booking.total_cents || 0) / 100).toFixed(2).replace('.', ',')}`;
  const bookUrl = `${process.env.BASE_URL || 'https://sokisocialsauna.nl'}/booking`;
  const refundBlock = refunded
    ? `<p style="background:#FBEFE3;border-left:4px solid #D94D1A;padding:12px 16px;border-radius:0 12px 12px 0;">
         Je betaling van <strong>${amount}</strong> wordt automatisch teruggestort. Het bedrag staat binnen 5&ndash;10 werkdagen op je rekening.<br>
         <span style="color:#8C7B6B;">Your payment of <strong>${amount}</strong> will be refunded automatically. It will appear on your account within 5&ndash;10 business days.</span></p>`
    : '';
  const creditsBlock = creditsRestored > 0
    ? `<p style="background:#FBEFE3;border-left:4px solid #D94D1A;padding:12px 16px;border-radius:0 12px 12px 0;">
         Je gebruikte credits (${creditsRestored}) zijn teruggezet op je account.<br>
         <span style="color:#8C7B6B;">The credits you used (${creditsRestored}) have been returned to your account.</span></p>`
    : '';
  await getClient().transactionalEmails.sendTransacEmail({
    to: [{ email: booking.customer_email, name: booking.customer_name }],
    sender: {
      email: process.env.EMAIL_FROM,
      name:  process.env.EMAIL_FROM_NAME || 'SOKI Social Sauna',
    },
    subject: `Je sessie op ${dateNl} is geannuleerd / Your session on ${dateEn} has been cancelled`,
    htmlContent: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#4A1C0C;">
        <h2 style="color:#D94D1A;margin-bottom:0.5rem;">SOKI Social Sauna</h2>
        <p>Hoi ${escapeHtml(booking.customer_name)},</p>
        <p>Helaas gaat de sessie <strong>${escapeHtml(booking.session_name)}</strong> op <strong>${dateNl}</strong> (${booking.start_time}&ndash;${booking.end_time}) niet door. Onze excuses voor het ongemak.<br>
           <span style="color:#8C7B6B;">Unfortunately, the <strong>${escapeHtml(booking.session_name)}</strong> session on <strong>${dateEn}</strong> (${booking.start_time}&ndash;${booking.end_time}) has been cancelled. We're sorry for the inconvenience.</span></p>
        ${refundBlock}
        ${creditsBlock}
        <p>We hopen je snel weer te zien &mdash; boek een nieuwe sessie op
           <a href="${bookUrl}" style="color:#D94D1A;">sokisocialsauna.nl</a>.<br>
           <span style="color:#8C7B6B;">We hope to see you again soon &mdash; book a new session at sokisocialsauna.nl.</span></p>
        <p style="color:#8C7B6B;font-size:13px;">Vragen? Antwoord op deze mail. / Questions? Just reply to this email.</p>
      </div>`,
  });
}

module.exports = {
  sendBookingConfirmation,
  sendBookingCancelledEmail,
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
