/**
 * utils/email.js
 * Nodemailer helpers for booking confirmation emails.
 */

const nodemailer = require('nodemailer');
const crypto = require('crypto');

function generateCheckinSig(bookingId) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev_secret_change_me')
    .update(String(bookingId))
    .digest('hex')
    .slice(0, 16);
}

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'sandbox.smtp.mailtrap.io',
    port: parseInt(process.env.SMTP_PORT || '587'),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function formatDate(dateStr) {
  // dateStr: YYYY-MM-DD
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

async function sendBookingConfirmation(booking) {
  const transporter = getTransporter();
  const from = `${process.env.EMAIL_FROM_NAME || 'Soki Social Sauna'} <${process.env.EMAIL_FROM || 'hello@sokisocialsauna.nl'}>`;

  const dateFormatted  = formatDate(booking.date);
  const totalFormatted = `€${(booking.total_cents / 100).toFixed(2)}`;

  const text = `
Bedankt voor je boeking bij Soki Social Sauna!

Bevestiging #${booking.id}
─────────────────────────────
Sessie:     ${booking.session_name}
Datum:      ${dateFormatted}
Tijd:       ${booking.start_time} – ${booking.end_time}
Groep:      ${booking.group_size} persoon/personen
Totaal:     ${totalFormatted}
─────────────────────────────

Adres: Gietijzerstraat 3, Utrecht

Tot dan!
Soki Social Sauna
  `.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #F2F2F2; margin: 0; padding: 32px 16px; }
    .card { max-width: 520px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; }
    .header { background: #4A1C0C; padding: 40px 32px; text-align: center; }
    .header h1 { color: #F2C299; font-size: 28px; margin: 0 0 4px; letter-spacing: 2px; text-transform: uppercase; }
    .header p  { color: #D94D1A; margin: 0; font-size: 13px; letter-spacing: 1px; text-transform: uppercase; }
    .body { padding: 32px; }
    .row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #F2F2F2; }
    .row:last-child { border-bottom: none; }
    .label { color: #999; font-size: 13px; }
    .value { font-weight: 600; color: #222; font-size: 14px; }
    .total .value { color: #D94D1A; font-size: 18px; }
    .footer { background: #4A1C0C; padding: 24px 32px; text-align: center; color: #F2C299; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Soki</h1>
      <p>sauna van de stad</p>
    </div>
    <div class="body">
      <p style="margin: 0 0 24px; font-size: 16px; color: #333;">Bedankt voor je boeking! We kijken ernaar uit je te verwelkomen.</p>

      <div class="row">
        <span class="label">Boekingsnummer</span>
        <span class="value">#${booking.id}</span>
      </div>
      <div class="row">
        <span class="label">Sessie</span>
        <span class="value">${booking.session_name}</span>
      </div>
      <div class="row">
        <span class="label">Datum</span>
        <span class="value">${dateFormatted}</span>
      </div>
      <div class="row">
        <span class="label">Tijd</span>
        <span class="value">${booking.start_time} – ${booking.end_time}</span>
      </div>
      <div class="row">
        <span class="label">Groepsgrootte</span>
        <span class="value">${booking.group_size} persoon/personen</span>
      </div>
      <div class="row total">
        <span class="label">Totaal betaald</span>
        <span class="value">${totalFormatted}</span>
      </div>
      <div style="text-align:center;margin-top:24px;">
        <a href="${process.env.BASE_URL || 'http://localhost:3001'}/ticket?bid=${booking.id}&sig=${generateCheckinSig(booking.id)}" style="display:inline-block;background:#D94D1A;color:#fff;padding:12px 28px;border-radius:100px;text-decoration:none;font-weight:700;font-size:14px;">Toon QR-code voor inchecken</a>
        <p style="font-size:11px;color:#999;margin-top:8px;">Of laat je boekingsbevestiging zien aan de deur.</p>
      </div>
    </div>
    <div class="footer">
      Gietijzerstraat 3, Utrecht · hello@sokisocialsauna.nl
    </div>
  </div>
</body>
</html>
  `.trim();

  await transporter.sendMail({
    from,
    to: `${booking.customer_name} <${booking.customer_email}>`,
    subject: `Boekingsbevestiging – ${booking.session_name} op ${dateFormatted}`,
    text,
    html,
  });
}

async function sendPasswordResetEmail({ name, email, token }) {
  const transporter = getTransporter();
  const from        = `${process.env.EMAIL_FROM_NAME || 'Soki Social Sauna'} <${process.env.EMAIL_FROM || 'hello@sokisocialsauna.nl'}>`;
  const resetUrl    = `${process.env.APP_URL || 'http://localhost:3001'}/reset-password?token=${token}`;

  const text = `Hi ${name},\n\nYou requested a password reset. Click the link below (valid for 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.\n\nSoki Social Sauna`;
  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#F2F2F2;margin:0;padding:32px 16px;}
.card{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;}
.header{background:#4A1C0C;padding:40px 32px;text-align:center;}
.header h1{color:#F2C299;font-size:28px;margin:0 0 4px;letter-spacing:2px;text-transform:uppercase;}
.body{padding:32px;}
.btn{display:inline-block;background:#D94D1A;color:#fff;padding:14px 32px;border-radius:100px;text-decoration:none;font-weight:700;font-size:15px;margin:24px 0;}
.footer{background:#4A1C0C;padding:24px 32px;text-align:center;color:#F2C299;font-size:12px;}
</style></head><body>
<div class="card">
  <div class="header"><h1>Soki</h1></div>
  <div class="body">
    <p>Hi ${name},</p>
    <p>You requested a password reset. Click the button below — the link is valid for 1 hour.</p>
    <a href="${resetUrl}" class="btn">Reset password</a>
    <p style="font-size:13px;color:#999">If you didn't request this, you can safely ignore this email.</p>
  </div>
  <div class="footer">Gietijzerstraat 3, Utrecht · hello@sokisocialsauna.nl</div>
</div></body></html>`.trim();

  await transporter.sendMail({ from, to: `${name} <${email}>`, subject: 'Reset your Soki password', text, html });
}

async function sendReminderEmail(booking) {
  const transporter    = getTransporter();
  const from           = `${process.env.EMAIL_FROM_NAME || 'Soki Social Sauna'} <${process.env.EMAIL_FROM || 'hello@sokisocialsauna.nl'}>`;
  const dateFormatted  = formatDate(booking.date);
  const totalFormatted = `€${(booking.total_cents / 100).toFixed(2)}`;

  const text = `Reminder: je sessie bij Soki is morgen!\n\nSessie: ${booking.session_name}\nDatum: ${dateFormatted}\nTijd: ${booking.start_time} – ${booking.end_time}\nGroep: ${booking.group_size} persoon/personen\n\nAdres: Gietijzerstraat 3, Utrecht\n\nTot morgen!\nSoki Social Sauna`;
  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#F2F2F2;margin:0;padding:32px 16px;}
.card{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;}
.header{background:#4A1C0C;padding:40px 32px;text-align:center;}
.header h1{color:#F2C299;font-size:28px;margin:0 0 4px;letter-spacing:2px;text-transform:uppercase;}
.header p{color:#D94D1A;margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;}
.body{padding:32px;}
.row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #F2F2F2;}
.row:last-child{border-bottom:none;}
.label{color:#999;font-size:13px;}.value{font-weight:600;color:#222;font-size:14px;}
.footer{background:#4A1C0C;padding:24px 32px;text-align:center;color:#F2C299;font-size:12px;}
</style></head><body>
<div class="card">
  <div class="header"><h1>Soki</h1><p>Tot morgen!</p></div>
  <div class="body">
    <p style="margin:0 0 24px;font-size:16px;color:#333;">Je sessie is morgen — we kijken ernaar uit!</p>
    <div class="row"><span class="label">Sessie</span><span class="value">${booking.session_name}</span></div>
    <div class="row"><span class="label">Datum</span><span class="value">${dateFormatted}</span></div>
    <div class="row"><span class="label">Tijd</span><span class="value">${booking.start_time} – ${booking.end_time}</span></div>
    <div class="row"><span class="label">Groepsgrootte</span><span class="value">${booking.group_size} persoon/personen</span></div>
    <div class="row"><span class="label">Totaal betaald</span><span class="value">${totalFormatted}</span></div>
  </div>
  <div class="footer">Gietijzerstraat 3, Utrecht · hello@sokisocialsauna.nl</div>
</div></body></html>`.trim();

  await transporter.sendMail({ from, to: `${booking.customer_name} <${booking.customer_email}>`, subject: `Herinnering: ${booking.session_name} morgen`, text, html });
}

async function sendWaitlistNotification({ customer_name, customer_email, session_name, date, start_time, end_time, slot_id }) {
  const transporter   = getTransporter();
  const from          = `${process.env.EMAIL_FROM_NAME || 'Soki Social Sauna'} <${process.env.EMAIL_FROM || 'hello@sokisocialsauna.nl'}>`;
  const dateFormatted = formatDate(date);
  const bookUrl       = `${process.env.BASE_URL || 'http://localhost:3001'}/booking`;

  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#F2F2F2;margin:0;padding:32px 16px;}
.card{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;}
.header{background:#4A1C0C;padding:40px 32px;text-align:center;}
.header h1{color:#F2C299;font-size:28px;margin:0 0 4px;letter-spacing:2px;text-transform:uppercase;}
.body{padding:32px;}
.btn{display:inline-block;background:#D94D1A;color:#fff;padding:14px 32px;border-radius:100px;text-decoration:none;font-weight:700;font-size:15px;margin:24px 0;}
.footer{background:#4A1C0C;padding:24px 32px;text-align:center;color:#F2C299;font-size:12px;}
</style></head><body>
<div class="card">
  <div class="header"><h1>Soki</h1><p>Er is een plek vrijgekomen!</p></div>
  <div class="body">
    <p>Hoi ${customer_name},</p>
    <p>Goed nieuws — er is een plek vrijgekomen voor de sessie waar je op de wachtlijst stond:</p>
    <p style="font-size:18px;font-weight:700;color:#D94D1A;">${session_name}</p>
    <p style="color:#666;">${dateFormatted} · ${start_time} – ${end_time}</p>
    <p>Wees er snel bij — de plek is beschikbaar op volgorde van de wachtlijst.</p>
    <a href="${bookUrl}" class="btn">Boek nu</a>
    <p style="font-size:13px;color:#999;">Als je niet meer geïnteresseerd bent, kun je jezelf van de wachtlijst verwijderen via je account.</p>
  </div>
  <div class="footer">Gietijzerstraat 3, Utrecht · hello@sokisocialsauna.nl</div>
</div></body></html>`.trim();

  await transporter.sendMail({
    from,
    to: `${customer_name} <${customer_email}>`,
    subject: `Plek beschikbaar: ${session_name} op ${dateFormatted}`,
    text: `Hoi ${customer_name},\n\nEr is een plek vrijgekomen voor ${session_name} op ${dateFormatted} (${start_time} – ${end_time}).\n\nBoek snel via: ${bookUrl}\n\nSoki Social Sauna`,
    html,
  });
}

async function sendAutoBookedEmail({ id, customer_name, customer_email, session_name, date, start_time, end_time, group_size, total_cents }) {
  const transporter   = getTransporter();
  const from          = `${process.env.EMAIL_FROM_NAME || 'Soki Social Sauna'} <${process.env.EMAIL_FROM || 'hello@sokisocialsauna.nl'}>`;
  const dateFormatted = formatDate(date);
  const total         = `€${(total_cents / 100).toFixed(2)}`;
  const checkinUrl    = `${process.env.BASE_URL || 'http://localhost:3001'}/ticket?bid=${id}&sig=${generateCheckinSig(id)}`;

  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#F2F2F2;margin:0;padding:32px 16px;}
.card{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;}
.header{background:#4A1C0C;padding:40px 32px;text-align:center;}
.header h1{color:#F2C299;font-size:28px;margin:0 0 4px;letter-spacing:2px;text-transform:uppercase;}
.header p{color:#D94D1A;margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;}
.body{padding:32px;}
.row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #F2F2F2;}
.row:last-child{border-bottom:none;}
.label{color:#999;font-size:13px;}.value{font-weight:600;color:#222;font-size:14px;}
.btn{display:inline-block;background:#D94D1A;color:#fff;padding:12px 28px;border-radius:100px;text-decoration:none;font-weight:700;font-size:14px;}
.footer{background:#4A1C0C;padding:24px 32px;text-align:center;color:#F2C299;font-size:12px;}
</style></head><body>
<div class="card">
  <div class="header"><h1>Soki</h1><p>Geautomatisch geboekt!</p></div>
  <div class="body">
    <p style="margin:0 0 24px;font-size:16px;color:#333;">Goed nieuws, ${customer_name}! Er is een plek vrijgekomen en we hebben je automatisch ingeboekt. Je betaling is al verwerkt.</p>
    <div class="row"><span class="label">Boekingsnummer</span><span class="value">#${id}</span></div>
    <div class="row"><span class="label">Sessie</span><span class="value">${session_name}</span></div>
    <div class="row"><span class="label">Datum</span><span class="value">${dateFormatted}</span></div>
    <div class="row"><span class="label">Tijd</span><span class="value">${start_time} – ${end_time}</span></div>
    <div class="row"><span class="label">Groepsgrootte</span><span class="value">${group_size} persoon/personen</span></div>
    <div class="row"><span class="label">Betaald</span><span class="value">${total}</span></div>
    <div style="text-align:center;margin-top:24px;">
      <a href="${checkinUrl}" class="btn">Toon QR-code voor inchecken</a>
    </div>
  </div>
  <div class="footer">Gietijzerstraat 3, Utrecht · hello@sokisocialsauna.nl</div>
</div></body></html>`.trim();

  await transporter.sendMail({
    from,
    to: `${customer_name} <${customer_email}>`,
    subject: `Je bent geboekt! ${session_name} op ${dateFormatted}`,
    text: `Goed nieuws, ${customer_name}! Er is een plek vrijgekomen voor ${session_name} op ${dateFormatted} (${start_time}–${end_time}) en je bent automatisch ingeboekt. Betaling is verwerkt (${total}).\n\nCheck-in QR: ${checkinUrl}\n\nSoki Social Sauna`,
    html,
  });
}

async function sendMessageReply({ customer_name, customer_email, original_subject, original_body, reply_body }) {
  const transporter = getTransporter();
  const from        = `${process.env.EMAIL_FROM_NAME || 'Soki Social Sauna'} <${process.env.EMAIL_FROM || 'hello@sokisocialsauna.nl'}>`;

  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#F2F2F2;margin:0;padding:32px 16px;}
.card{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;}
.header{background:#4A1C0C;padding:28px 32px;}
.logo{font-size:1.6rem;font-weight:700;letter-spacing:.1em;color:#fff;}
.body{padding:32px;}
h2{margin:0 0 8px;font-size:1.15rem;color:#4A1C0C;}
p{margin:0 0 16px;font-size:14px;color:#444;line-height:1.6;}
.reply-box{background:#FFF8F5;border-left:4px solid #D94D1A;border-radius:0 10px 10px 0;padding:16px 20px;margin-bottom:24px;}
.reply-box p{margin:0;color:#3a3a3a;font-size:15px;line-height:1.7;}
.original{background:#F5F5F5;border-radius:10px;padding:14px 18px;margin-bottom:24px;}
.original p{margin:0;color:#888;font-size:13px;font-style:italic;}
.footer{padding:20px 32px;background:#F9F4EF;text-align:center;font-size:12px;color:#aaa;}
</style></head><body>
<div class="card">
  <div class="header"><div class="logo">Soki</div></div>
  <div class="body">
    <h2>Hallo ${customer_name},</h2>
    <p>We hebben je bericht beantwoord:</p>
    <div class="reply-box"><p>${reply_body.replace(/\n/g, '<br>')}</p></div>
    <p style="font-size:13px;color:#999;margin-bottom:6px;">Je oorspronkelijke vraag:</p>
    <div class="original"><p>${original_body.replace(/\n/g, '<br>')}</p></div>
    <p>Heb je nog vragen? Stuur ons gerust nog een bericht via je account.</p>
  </div>
  <div class="footer">Soki Social Sauna · Gietijzerstraat 3, Utrecht</div>
</div>
</body></html>`;

  await transporter.sendMail({
    from,
    to:      `${customer_name} <${customer_email}>`,
    subject: original_subject ? `Re: ${original_subject}` : 'Antwoord van Soki Social Sauna',
    text:    `Hallo ${customer_name},\n\nAntwoord van Soki:\n\n${reply_body}\n\n---\nJe vraag: ${original_body}\n\nSoki Social Sauna`,
    html,
  });
}

async function sendMilestoneEmail({ customer_name, customer_email, milestone, lang = 'nl' }) {
  const transporter = getTransporter();
  const from        = `${process.env.EMAIL_FROM_NAME || 'Soki Social Sauna'} <${process.env.EMAIL_FROM || 'hello@sokisocialsauna.nl'}>`;

  const label  = lang === 'nl' ? milestone.label_nl  : milestone.label_en;
  const reward = lang === 'nl' ? milestone.reward_nl : milestone.reward_en;
  const subject = lang === 'nl'
    ? `${milestone.emoji} Mijlpaal bereikt: ${label}!`
    : `${milestone.emoji} Milestone reached: ${label}!`;

  const promoHtml = milestone.promo_code
    ? `<div style="margin:24px 0;text-align:center;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#999;margin-bottom:8px;">${lang === 'nl' ? 'Jouw beloningscode' : 'Your reward code'}</div>
        <div style="display:inline-block;background:#FFF8F5;border:2px dashed #D94D1A;border-radius:12px;padding:14px 28px;font-size:22px;font-weight:800;letter-spacing:.12em;color:#D94D1A;">${milestone.promo_code}</div>
        <div style="font-size:12px;color:#999;margin-top:8px;">${lang === 'nl' ? 'Gebruik deze code bij je volgende boeking.' : 'Use this code on your next booking.'}</div>
       </div>`
    : '';

  const promoText = milestone.promo_code
    ? `\n${lang === 'nl' ? 'Jouw beloningscode' : 'Your reward code'}: ${milestone.promo_code}\n`
    : '';

  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#F2F2F2;margin:0;padding:32px 16px;}
.card{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;}
.header{background:#4A1C0C;padding:40px 32px;text-align:center;}
.header h1{color:#F2C299;font-size:28px;margin:0 0 4px;letter-spacing:2px;text-transform:uppercase;}
.header p{color:#D94D1A;margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;}
.body{padding:32px;}
.milestone-badge{text-align:center;padding:24px 0 16px;}
.milestone-badge .emoji{font-size:56px;line-height:1;}
.milestone-badge h2{margin:12px 0 4px;font-size:22px;color:#4A1C0C;}
.milestone-badge .visits{font-size:13px;color:#999;}
.reward-box{background:#FFF8F5;border-left:4px solid #D94D1A;border-radius:0 12px 12px 0;padding:16px 20px;margin:20px 0;font-size:15px;color:#3a3a3a;line-height:1.6;}
.footer{background:#4A1C0C;padding:24px 32px;text-align:center;color:#F2C299;font-size:12px;}
</style></head><body>
<div class="card">
  <div class="header"><h1>Soki</h1><p>${lang === 'nl' ? 'Mijlpaal bereikt!' : 'Milestone reached!'}</p></div>
  <div class="body">
    <div class="milestone-badge">
      <div class="emoji">${milestone.emoji}</div>
      <h2>${label}</h2>
      <div class="visits">${milestone.visits} ${lang === 'nl' ? 'bezoeken' : 'visits'}</div>
    </div>
    <p style="font-size:16px;color:#333;margin:0 0 16px;">${lang === 'nl' ? `Gefeliciteerd, ${customer_name}! Je hebt een nieuwe mijlpaal bereikt.` : `Congratulations, ${customer_name}! You've reached a new milestone.`}</p>
    <div class="reward-box">${reward}</div>
    ${promoHtml}
  </div>
  <div class="footer">Gietijzerstraat 3, Utrecht · hello@sokisocialsauna.nl</div>
</div></body></html>`.trim();

  const text = `${lang === 'nl' ? `Gefeliciteerd, ${customer_name}!` : `Congratulations, ${customer_name}!`}\n\n${milestone.emoji} ${label} — ${milestone.visits} ${lang === 'nl' ? 'bezoeken' : 'visits'}\n\n${reward}${promoText}\n\nSoki Social Sauna`;

  await transporter.sendMail({ from, to: `${customer_name} <${customer_email}>`, subject, text, html });
}

async function sendGiftCardEmail(card) {
  const transporter = getTransporter();
  const from = `${process.env.EMAIL_FROM_NAME || 'Soki Social Sauna'} <${process.env.EMAIL_FROM || 'hello@sokisocialsauna.nl'}>`;
  const amount = `€${(card.initial_amount_cents / 100).toFixed(2).replace('.', ',')}`;
  const expires = new Date(card.expires_at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });

  const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body { margin:0; padding:0; background:#F9F4EF; font-family:'DM Sans',Arial,sans-serif; }
  .wrap { max-width:560px; margin:40px auto; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,.08); }
  .header { background:#4A1C0C; padding:36px 40px; text-align:center; }
  .header h1 { color:#F9F4EF; font-size:26px; margin:0 0 4px; letter-spacing:.04em; font-family:Arial,sans-serif; }
  .header p  { color:rgba(249,244,239,.7); margin:0; font-size:14px; }
  .body { padding:36px 40px; }
  .gift-box { background:#F9F4EF; border-radius:12px; padding:28px; text-align:center; margin:20px 0 28px; }
  .gift-amount { font-size:3rem; font-weight:800; color:#4A1C0C; line-height:1; }
  .gift-code { font-size:1.4rem; font-weight:700; letter-spacing:.15em; color:#D94D1A; margin-top:16px; font-family:'Courier New',monospace; }
  .gift-label { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:#8C7B6B; margin-top:6px; }
  .message-box { background:#FFF8F5; border-left:3px solid #D94D1A; padding:14px 18px; border-radius:0 8px 8px 0; margin:0 0 24px; font-style:italic; color:#4A1C0C; }
  p { color:#4A1C0C; line-height:1.7; font-size:15px; margin:0 0 16px; }
  .footer { background:#F9F4EF; padding:20px 40px; text-align:center; font-size:12px; color:#8C7B6B; }
  a { color:#D94D1A; }
</style></head><body>
<div class="wrap">
  <div class="header">
    <h1>🎁 Jij hebt een cadeaubon ontvangen!</h1>
    <p>Van ${card.purchaser_name}</p>
  </div>
  <div class="body">
    <p>Hallo ${card.recipient_name},</p>
    <p><strong>${card.purchaser_name}</strong> heeft jou een Soki Social Sauna cadeaubon gegeven.</p>
    ${card.message ? `<div class="message-box">"${card.message}"</div>` : ''}
    <div class="gift-box">
      <div class="gift-amount">${amount}</div>
      <div class="gift-code">${card.code}</div>
      <div class="gift-label">Jouw cadeauboncode</div>
    </div>
    <p>Gebruik deze code bij het afrekenen op <a href="${process.env.BASE_URL || 'https://sokisocialsauna.nl'}/booking">sokisocialsauna.nl/booking</a>. De bon is geldig tot <strong>${expires}</strong> en kan meerdere keren worden gebruikt totdat het saldo op is.</p>
    <p>Tot ziens bij Soki!<br><strong>Team Soki Social Sauna</strong><br>Europalaan 2B, Utrecht<br><a href="mailto:hello@sokisocialsauna.nl">hello@sokisocialsauna.nl</a></p>
  </div>
  <div class="footer">© Soki Social Sauna · KVK 93466307</div>
</div>
</body></html>`;

  await transporter.sendMail({
    from, to: card.recipient_email,
    subject: `🎁 Je hebt een Soki cadeaubon van ${card.purchaser_name}!`,
    html,
    text: `Hallo ${card.recipient_name},\n\n${card.purchaser_name} heeft jou een Soki cadeaubon gegeven.\n\nBedrag: ${amount}\nCode: ${card.code}\nGeldig tot: ${expires}\n\nGebruik de code op sokisocialsauna.nl/booking.\n\nTot ziens bij Soki!`,
  });
}

module.exports = { sendBookingConfirmation, sendPasswordResetEmail, sendReminderEmail, sendWaitlistNotification, sendAutoBookedEmail, sendMessageReply, generateCheckinSig, sendMilestoneEmail, sendGiftCardEmail };
