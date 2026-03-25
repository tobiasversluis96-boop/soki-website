/**
 * utils/email.js
 * Nodemailer helpers for booking confirmation emails.
 */

const nodemailer = require('nodemailer');

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
    </div>
    <div class="footer">
      Gietijzerstraat 3, Utrecht · info@sokisocialsauna.nl
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
  <div class="footer">Gietijzerstraat 3, Utrecht · info@sokisocialsauna.nl</div>
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
  <div class="footer">Gietijzerstraat 3, Utrecht · info@sokisocialsauna.nl</div>
</div></body></html>`.trim();

  await transporter.sendMail({ from, to: `${booking.customer_name} <${booking.customer_email}>`, subject: `Herinnering: ${booking.session_name} morgen`, text, html });
}

module.exports = { sendBookingConfirmation, sendPasswordResetEmail, sendReminderEmail };
