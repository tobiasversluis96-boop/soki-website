# Soki Social Sauna — Website & Booking System

Static website + Node.js booking backend for [Soki Social Sauna](https://sokisocialsauna.nl), Utrecht.

## Project structure

```
soki-website/
├── index.html             # Homepage
├── sessions.html          # Sessions / programme
├── about.html             # About page
├── gallery.html           # Gallery
├── newsletter.html        # Newsletter signup
├── styles.css             # All CSS
├── main.js                # Shared frontend JS
├── translations.js        # EN/NL language strings
├── sanity-content.js      # Fetches content from Sanity CMS
├── images/                # Local images (hero, etc.)
│
├── booking-system/        # Node.js + Express backend
│   ├── server.js
│   ├── package.json
│   ├── .env               # Secret keys (never commit)
│   ├── db/database.js     # PostgreSQL setup + queries
│   ├── routes/            # auth, bookings, payments, admin
│   ├── utils/email.js     # Nodemailer
│   └── public/            # Booking, account, admin pages
│
└── sanity/                # Sanity CMS studio
    ├── sanity.config.js
    ├── sanity.cli.js
    ├── package.json
    └── schemas/           # Content schemas
```

---

## Part 1 — Set up Sanity CMS

Sanity is where you edit texts, images and gallery photos without touching code.

### 1.1 Create a Sanity project

```bash
npm install -g @sanity/cli
cd sanity
npm install
sanity init --env
```

Follow the prompts:
- Create a new project → give it a name like `soki-studio`
- Dataset: `production`
- Note the **Project ID** shown at the end (looks like `abc12def`)

### 1.2 Add the Project ID

Open `sanity/sanity.config.js` and `sanity/sanity.cli.js` and replace `YOUR_PROJECT_ID` with your actual project ID.

Then open `sanity-content.js` (in the root of the website) and replace `YOUR_PROJECT_ID` at the top.

### 1.3 Allow your domain in Sanity CORS settings

Go to [sanity.io/manage](https://sanity.io/manage) → your project → **API** → **CORS Origins**.

Add:
- `http://localhost:3001` (for local development)
- Your production Railway domain (e.g. `https://soki-website.up.railway.app`)

### 1.4 Run the Sanity studio locally

```bash
cd sanity
npm run dev
```

The studio opens at `http://localhost:3333`. Start adding content — all fields are optional, the website falls back to its static HTML if a field is empty.

### 1.5 Deploy the Sanity studio (optional)

To give team members access to the CMS via a URL:

```bash
cd sanity
sanity deploy
```

This deploys the studio to `https://your-project-name.sanity.studio`.

---

## Part 2 — Set up the booking system locally

### 2.1 Install dependencies

```bash
cd booking-system
npm install
```

### 2.2 Create the `.env` file

```bash
cp booking-system/.env.example booking-system/.env
```

A complete `.env.example` is provided in the project root for reference. Or create `booking-system/.env` manually:

```env
PORT=3001

JWT_SECRET=replace_with_a_long_random_string

ADMIN_EMAIL=admin@sokisocialsauna.nl
ADMIN_PASSWORD=your_secure_password

STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...

DATABASE_URL=postgresql://user:password@localhost:5432/soki

SMTP_HOST=sandbox.smtp.mailtrap.io
SMTP_PORT=587
SMTP_USER=your_mailtrap_user
SMTP_PASS=your_mailtrap_password
EMAIL_FROM=hello@sokisocialsauna.nl
EMAIL_FROM_NAME=Soki Social Sauna
```

To generate a secure JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 2.3 Start a local PostgreSQL database

If you have PostgreSQL installed:
```bash
createdb soki
```

Then set `DATABASE_URL=postgresql://localhost/soki` in your `.env`.

Or use Docker:
```bash
docker run --name soki-postgres -e POSTGRES_DB=soki -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres
```

With Docker, set: `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/soki`

### 2.4 Start the server

```bash
cd booking-system
npm run dev
```

Visit `http://localhost:3001`. The database tables and seed data are created automatically on first run.

---

## Part 3 — Deploy to Railway

### 3.1 Push the project to GitHub

```bash
cd /path/to/soki-website
git init
git add .
git commit -m "Initial commit"
```

Create a new repository on GitHub (github.com → New repository), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/soki-website.git
git push -u origin main
```

### 3.2 Create a Railway project

1. Go to [railway.app](https://railway.app) and log in
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `soki-website` repository
4. Railway detects `railway.toml` and configures the build automatically

### 3.3 Add a PostgreSQL database

1. In your Railway project, click **+ New** → **Database** → **PostgreSQL**
2. Railway creates a PostgreSQL instance and automatically injects `DATABASE_URL` into your service — no manual configuration needed

### 3.4 Add environment variables

In Railway: select your service → **Variables** → **Add variable**. Add each of these:

| Variable | Value |
|---|---|
| `JWT_SECRET` | A long random string (run the node command in 2.2) |
| `ADMIN_EMAIL` | `admin@sokisocialsauna.nl` |
| `ADMIN_PASSWORD` | Your secure admin password |
| `STRIPE_SECRET_KEY` | `sk_live_...` |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_...` |
| `SMTP_HOST` | Your SMTP provider host |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | Your SMTP username |
| `SMTP_PASS` | Your SMTP password |
| `EMAIL_FROM` | `hello@sokisocialsauna.nl` |
| `EMAIL_FROM_NAME` | `Soki Social Sauna` |
| `SANITY_PROJECT_ID` | Your Sanity project ID (from [sanity.io/manage](https://sanity.io/manage)) |
| `SANITY_DATASET` | `production` |

> `DATABASE_URL` is injected automatically by Railway — do NOT add it manually.

### 3.5 CI/CD with GitHub Actions

A GitHub Actions workflow (`.github/workflows/deploy.yml`) automatically deploys to Railway on every push to `main`.

To enable it:
1. In Railway: **Account Settings** → **Tokens** → create a project token
2. In GitHub: **Settings** → **Secrets and variables** → **Actions** → add a secret named `RAILWAY_TOKEN` with the token value

### 3.6 Deploy

Railway deploys automatically after adding the variables (or via the GitHub Actions workflow above). Watch the build log in the Railway dashboard.

Once deployed, click the generated URL (e.g. `soki-website.up.railway.app`) to verify the site loads.

### 3.7 Add your domain (optional)

In Railway: your service → **Settings** → **Networking** → **Custom Domain** → enter your domain and follow the DNS instructions.

---

## Admin dashboard

Visit `/admin` on your deployed URL. Log in with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` you set.

From the admin panel you can:
- View and cancel bookings
- Create, edit and cancel time slots
- Export bookings to CSV
- View analytics

---

## Changing the admin password

Run this from the `soki-website` root (replace `NEW_PASSWORD`):

```bash
node -e "
const bcrypt  = require('./booking-system/node_modules/bcryptjs');
const { Pool } = require('./booking-system/node_modules/pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
bcrypt.hash('NEW_PASSWORD', 12).then(hash => {
  return pool.query('UPDATE admin_users SET password_hash = \$1 WHERE email = \$2',
    [hash, 'admin@sokisocialsauna.nl']);
}).then(() => { console.log('Done.'); pool.end(); });
"
```

Also update `ADMIN_PASSWORD` in your Railway environment variables.

---

## Updating content via Sanity

Once deployed:
1. Open the Sanity studio (`sanity deploy` or `sanity dev` locally)
2. Edit any text, image or gallery item
3. Changes appear on the website within seconds — no redeploy needed
