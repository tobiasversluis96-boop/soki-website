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
  // pg geeft DATE-kolommen soms als JS Date terug, soms als 'YYYY-MM-DD'-string
  const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
  if (dateStr instanceof Date) return dateStr.toLocaleDateString('en-GB', opts);
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', opts);
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
      // Lege string bij boekingen zonder combi-deal: de Brevo-template plakt deze
      // param direct in het detailblok, dus de regel verdwijnt dan volledig.
      KANTINE_LINE:   booking.kantine_addon_cents > 0 ? 'Combi ticket De Kantine: vegan 2-gangendiner / vegan 2-course dinner ✓<br>' : '',
      TOTAL:          `€${(booking.total_cents / 100).toFixed(2)}`,
      CHECKIN_URL:    `${process.env.BASE_URL || 'http://localhost:3001'}/ticket?bid=${booking.id}&sig=${generateCheckinSig(booking.id)}`,
      MANAGE_URL:     `${process.env.BASE_URL || 'http://localhost:3001'}/account`,
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

// Huisstijl gelijk aan de Brevo-nieuwsbrief (crème #ffecd3, donkerbruin #4a1c0c, tan #f2c299)
const EMAIL_LOGO  = 'https://img.mailinblue.com/10958046/images/content_library/original/6a96d22f8ac0d97f596c4c60.png';
const EMAIL_FONT  = "'Montserrat',Arial,Helvetica,sans-serif";
const EMAIL_MUTED = '#8a6a58';

function emailButton(url, label) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:24px auto;">
      <tr>
        <td align="center" style="background-color:#4a1c0c;border-radius:4px;">
          <a href="${url}" style="display:inline-block;padding:14px 32px;font-family:${EMAIL_FONT};font-size:16px;font-weight:bold;color:#f0efea;text-decoration:none;">${label}</a>
        </td>
      </tr>
    </table>`;
}

function emailLayout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="nl">
<body style="margin:0;padding:0;background-color:#ffecd3;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffecd3;">
    <tr>
      <td align="center" style="padding:32px 16px 0;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;">
          <tr>
            <td align="center" style="padding:0 0 28px;">
              <img src="${EMAIL_LOGO}" alt="SOKI - Social Sauna" width="250" style="display:block;width:250px;max-width:80%;height:auto;border:0;">
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 8px 20px;">
              <h1 style="margin:0;font-family:'Arial Black',${EMAIL_FONT};font-size:28px;line-height:1.25;color:#4a1c0c;">${title}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:0 8px 36px;font-family:${EMAIL_FONT};font-size:16px;line-height:1.6;color:#4a1c0c;">
              ${bodyHtml}
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td align="center" style="padding:0 16px 32px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background-color:#4a1c0c;">
          <tr>
            <td align="center" style="padding:28px 16px;font-family:${EMAIL_FONT};color:#f0efea;">
              <div style="font-size:16px;font-weight:bold;">SOKI - Social Sauna</div>
              <div style="font-size:14px;margin-top:6px;">Europalaan 2B, 3526 KS, Utrecht</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
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
    htmlContent: emailLayout('Bevestig je e-mailadres', `
        <p style="margin:0 0 16px;">Hoi ${escapeHtml(name)},</p>
        <p style="margin:0 0 16px;">Bevestig je e-mailadres met deze code:<br>
           <span style="color:${EMAIL_MUTED};">Confirm your email address with this code:</span></p>
        <div style="background-color:#f2c299;padding:20px 24px;border-radius:4px;text-align:center;margin:0 0 20px;">
          <span style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#4a1c0c;">${escapeHtml(code)}</span>
        </div>
        <p style="margin:0 0 16px;">Vul deze code in op je accountpagina — je vindt het invulveld in de balk bovenaan.<br>
           <span style="color:${EMAIL_MUTED};">Enter this code on your account page — you'll find the input field in the banner at the top.</span></p>
        ${emailButton(`${process.env.BASE_URL || 'https://www.sokisocialsauna.nl'}/account`, 'Naar mijn account / Go to my account')}
        <p style="margin:0 0 16px;">De code is 15 minuten geldig. / This code is valid for 15 minutes.</p>
        <p style="margin:0;color:${EMAIL_MUTED};font-size:13px;">Heb je geen account aangemaakt bij SOKI? Dan kun je deze mail negeren.<br>
           Didn't create a SOKI account? You can safely ignore this email.</p>`),
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

// Bevestiging als de gast zélf annuleert (template 8)
async function sendSelfCancelledEmail({ customer_name, customer_email, session_name, date, start_time, end_time, refund_amount_cents = 0, refund_pct = 0, credits_restored = 0 }) {
  await send(
    process.env.BREVO_TEMPLATE_SELF_CANCELLED,
    customer_email,
    customer_name,
    {
      CUSTOMER_NAME:    customer_name,
      SESSION_NAME:     session_name,
      DATE:             formatDate(date),
      START_TIME:       start_time,
      END_TIME:         end_time,
      REFUND_AMOUNT:    refund_amount_cents > 0 ? `€${(refund_amount_cents / 100).toFixed(2)}` : '',
      REFUND_PCT:       refund_amount_cents > 0 ? String(refund_pct) : '',
      CREDITS_RESTORED: credits_restored > 0 ? String(credits_restored) : '',
    }
  );
}

// Bevestiging "je staat op de wachtlijst" zodra de betaling binnen is (template 9)
async function sendWaitlistJoinedEmail({ customer_name, customer_email, session_name, date, start_time, end_time, group_size, total_cents }) {
  await send(
    process.env.BREVO_TEMPLATE_WAITLIST_JOINED,
    customer_email,
    customer_name,
    {
      CUSTOMER_NAME: customer_name,
      SESSION_NAME:  session_name,
      DATE:          formatDate(date),
      START_TIME:    start_time,
      END_TIME:      end_time,
      GROUP_SIZE:    group_size,
      TOTAL:         `€${(total_cents / 100).toFixed(2)}`,
    }
  );
}

// Ontvangstbevestiging van een bericht via het platform (template 10)
async function sendMessageReceivedEmail({ customer_name, customer_email, subject, body }) {
  await send(
    process.env.BREVO_TEMPLATE_MESSAGE_RECEIVED,
    customer_email,
    customer_name,
    {
      CUSTOMER_NAME:   customer_name,
      MESSAGE_SUBJECT: subject,
      MESSAGE_BODY:    body,
    }
  );
}

// Welkomstmail bij start van een membership (template 11)
async function sendMemberWelcomeEmail({ customer_name, customer_email, plan_name, credits_per_month, price_cents }) {
  await send(
    process.env.BREVO_TEMPLATE_MEMBER_WELCOME,
    customer_email,
    customer_name,
    {
      CUSTOMER_NAME: customer_name,
      PLAN_NAME:     plan_name,
      CREDITS:       credits_per_month != null ? String(credits_per_month) : '',
      PRICE:         `€${(price_cents / 100).toFixed(2)}`,
    }
  );
}

// Bevestiging van opzegging membership (template 12)
async function sendMemberCancelledEmail({ customer_name, customer_email, plan_name, ends_at }) {
  const d = ends_at instanceof Date ? ends_at : new Date(ends_at);
  await send(
    process.env.BREVO_TEMPLATE_MEMBER_CANCELLED,
    customer_email,
    customer_name,
    {
      CUSTOMER_NAME: customer_name,
      PLAN_NAME:     plan_name,
      ENDS_AT:       d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    }
  );
}

// Melding dat een maandelijkse membershipbetaling is mislukt (template 13)
async function sendPaymentFailedEmail({ customer_name, customer_email, plan_name, amount_cents }) {
  await send(
    process.env.BREVO_TEMPLATE_PAYMENT_FAILED,
    customer_email,
    customer_name,
    {
      CUSTOMER_NAME: customer_name,
      PLAN_NAME:     plan_name,
      AMOUNT:        amount_cents ? `€${(amount_cents / 100).toFixed(2)}` : '',
    }
  );
}

// Bevestiging na aankoop van een strippenkaart (punch pass)
async function sendPunchPassEmail({ customer_name, customer_email, bundle_name, credits, price_cents, expires_at }) {
  const d = expires_at instanceof Date ? expires_at : new Date(expires_at);
  await send(
    process.env.BREVO_TEMPLATE_PUNCH_PASS,
    customer_email,
    customer_name,
    {
      CUSTOMER_NAME: customer_name,
      BUNDLE_NAME:   bundle_name,
      CREDITS:       String(credits),
      PRICE:         `€${(price_cents / 100).toFixed(2)}`,
      EXPIRES_AT:    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
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
    ? `<p style="background-color:#ffffff;border-left:4px solid #f2c299;padding:12px 16px;border-radius:0 4px 4px 0;font-style:italic;margin:0 0 16px;">&ldquo;${escapeHtml(card.message)}&rdquo;<br>
         <span style="color:${EMAIL_MUTED};font-style:normal;font-size:13px;">&mdash; ${escapeHtml(card.purchaser_name)}</span></p>`
    : '';
  await getClient().transactionalEmails.sendTransacEmail({
    to: [{ email: card.recipient_email, name: card.recipient_name }],
    sender: {
      email: process.env.EMAIL_FROM,
      name:  process.env.EMAIL_FROM_NAME || 'SOKI Social Sauna',
    },
    subject: `Je hebt een cadeaubon van ${amount} gekregen! / You've received a ${amount} gift card!`,
    htmlContent: emailLayout('Je hebt een cadeaubon gekregen!', `
        <p style="margin:0 0 16px;">Hoi ${escapeHtml(card.recipient_name)},</p>
        <p style="margin:0 0 16px;"><strong>${escapeHtml(card.purchaser_name)}</strong> heeft een cadeaubon voor je gekocht!<br>
           <span style="color:${EMAIL_MUTED};">${escapeHtml(card.purchaser_name)} bought you a gift card!</span></p>
        ${messageBlock}
        <div style="background-color:#f2c299;padding:24px;border-radius:4px;text-align:center;margin:0 0 20px;">
          <div style="font-size:36px;font-weight:bold;color:#4a1c0c;">${amount}</div>
          <div style="color:#4a1c0c;font-size:13px;margin:8px 0 4px;">Cadeauboncode / Gift card code</div>
          <div style="font-size:24px;font-weight:bold;letter-spacing:3px;color:#4a1c0c;">${escapeHtml(card.code)}</div>
        </div>
        <p style="margin:0 0 16px;">Vul de code in bij het afrekenen van je boeking.<br>
           <span style="color:${EMAIL_MUTED};">Enter the code at checkout when booking your session.</span></p>
        ${emailButton(bookUrl, 'Boek een sessie / Book a session')}
        <p style="margin:0;color:${EMAIL_MUTED};font-size:13px;">Geldig tot ${expiresNl}. / Valid until ${expiresEn}.</p>`),
  });
}

// Geen Brevo-template nodig: de aankoopbevestiging voor de koper wordt als kant-en-klare HTML verstuurd
async function sendGiftCardPurchaseEmail(card) {
  const expiresNl = new Date(card.expires_at).toLocaleDateString('nl-NL', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const expiresEn = new Date(card.expires_at).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const amount  = `€${(card.initial_amount_cents / 100).toFixed(2).replace('.', ',')}`;
  const bookUrl = `${process.env.BASE_URL || 'https://sokisocialsauna.nl'}/booking`;
  await getClient().transactionalEmails.sendTransacEmail({
    to: [{ email: card.purchaser_email, name: card.purchaser_name }],
    sender: {
      email: process.env.EMAIL_FROM,
      name:  process.env.EMAIL_FROM_NAME || 'SOKI Social Sauna',
    },
    subject: `Bevestiging van je cadeaubon van ${amount} / Your ${amount} gift card confirmation`,
    htmlContent: emailLayout('Bedankt voor je aankoop!', `
        <p style="margin:0 0 16px;">Hoi ${escapeHtml(card.purchaser_name)},</p>
        <p style="margin:0 0 16px;">Je cadeaubon voor <strong>${escapeHtml(card.recipient_name)}</strong> is betaald en de code is naar ${escapeHtml(card.recipient_email)} gestuurd.<br>
           <span style="color:${EMAIL_MUTED};">Your gift card for <strong>${escapeHtml(card.recipient_name)}</strong> has been paid and the code has been sent to ${escapeHtml(card.recipient_email)}.</span></p>
        <div style="background-color:#f2c299;padding:24px;border-radius:4px;text-align:center;margin:0 0 20px;">
          <div style="font-size:36px;font-weight:bold;color:#4a1c0c;">${amount}</div>
          <div style="color:#4a1c0c;font-size:13px;margin:8px 0 4px;">Cadeauboncode / Gift card code</div>
          <div style="font-size:24px;font-weight:bold;letter-spacing:3px;color:#4a1c0c;">${escapeHtml(card.code)}</div>
        </div>
        <p style="margin:0 0 16px;">De code is in te wisselen bij het afrekenen van een boeking op
           <a href="${bookUrl}" style="color:#4a1c0c;font-weight:bold;">sokisocialsauna.nl</a>.<br>
           <span style="color:${EMAIL_MUTED};">The code can be redeemed at checkout when booking a session.</span></p>
        <p style="margin:0 0 8px;color:${EMAIL_MUTED};font-size:13px;">Geldig tot ${expiresNl}. / Valid until ${expiresEn}.</p>
        <p style="margin:0;color:${EMAIL_MUTED};font-size:13px;">Vragen? Antwoord op deze mail. / Questions? Just reply to this email.</p>`),
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
    ? `<p style="background-color:#ffffff;border-left:4px solid #f2c299;padding:12px 16px;border-radius:0 4px 4px 0;margin:0 0 16px;">
         Je betaling van <strong>${amount}</strong> wordt automatisch teruggestort. Het bedrag staat binnen 5&ndash;10 werkdagen op je rekening.<br>
         <span style="color:${EMAIL_MUTED};">Your payment of <strong>${amount}</strong> will be refunded automatically. It will appear on your account within 5&ndash;10 business days.</span></p>`
    : '';
  const creditsBlock = creditsRestored > 0
    ? `<p style="background-color:#ffffff;border-left:4px solid #f2c299;padding:12px 16px;border-radius:0 4px 4px 0;margin:0 0 16px;">
         Je gebruikte credits (${creditsRestored}) zijn teruggezet op je account.<br>
         <span style="color:${EMAIL_MUTED};">The credits you used (${creditsRestored}) have been returned to your account.</span></p>`
    : '';
  await getClient().transactionalEmails.sendTransacEmail({
    to: [{ email: booking.customer_email, name: booking.customer_name }],
    sender: {
      email: process.env.EMAIL_FROM,
      name:  process.env.EMAIL_FROM_NAME || 'SOKI Social Sauna',
    },
    subject: `Je sessie op ${dateNl} is geannuleerd / Your session on ${dateEn} has been cancelled`,
    htmlContent: emailLayout('Je sessie is geannuleerd', `
        <p style="margin:0 0 16px;">Hoi ${escapeHtml(booking.customer_name)},</p>
        <p style="margin:0 0 16px;">Helaas gaat de sessie <strong>${escapeHtml(booking.session_name)}</strong> op <strong>${dateNl}</strong> (${booking.start_time}&ndash;${booking.end_time}) niet door. Onze excuses voor het ongemak.<br>
           <span style="color:${EMAIL_MUTED};">Unfortunately, the <strong>${escapeHtml(booking.session_name)}</strong> session on <strong>${dateEn}</strong> (${booking.start_time}&ndash;${booking.end_time}) has been cancelled. We're sorry for the inconvenience.</span></p>
        ${refundBlock}
        ${creditsBlock}
        <p style="margin:0 0 16px;">We hopen je snel weer te zien!<br>
           <span style="color:${EMAIL_MUTED};">We hope to see you again soon!</span></p>
        ${emailButton(bookUrl, 'Boek een nieuwe sessie / Book a new session')}
        <p style="margin:0;color:${EMAIL_MUTED};font-size:13px;">Vragen? Antwoord op deze mail. / Questions? Just reply to this email.</p>`),
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
  sendGiftCardPurchaseEmail,
  sendSelfCancelledEmail,
  sendWaitlistJoinedEmail,
  sendMessageReceivedEmail,
  sendMemberWelcomeEmail,
  sendMemberCancelledEmail,
  sendPaymentFailedEmail,
  sendPunchPassEmail,
  generateCheckinSig,
};
