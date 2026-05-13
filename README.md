# MyHome Parser

Auto-import & publish listings from myhome.ge — a Next.js full-stack app with user management, admin panel, and Playwright-powered browser automation.

---

## Features

- **User accounts** with single active session per user (logging in elsewhere kicks the old session)
- **Admin panel** to create, manage, and assign roles to users (USER / MODERATOR / ADMIN)
- **Link myhome.ge account** — users enter their myhome.ge email & password (AES-256 encrypted at rest)
- **Parse any listing** — paste a myhome.ge URL and extract: title, price, images, description, area, rooms, floor, address, and all property details
- **Auto-publish** — fills the myhome.ge post creation form using Playwright on the user's behalf

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| Database | MySQL via Prisma ORM |
| Auth | Custom JWT (jose) + HTTP-only cookies |
| Scraping | Playwright (Chromium, headless) |
| Styling | Tailwind CSS |
| Encryption | AES-256-CBC (Node.js crypto) |

---

## Setup

### 1. Prerequisites

- Node.js 18+
- MySQL database (local or remote)
- Playwright Chromium browser

### 2. Install dependencies

```bash
npm install
```

### 3. Install Playwright browser

```bash
npx playwright install chromium
```

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```env
# MySQL connection string
DATABASE_URL="mysql://root:password@localhost:3306/myhome_parser"

# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
JWT_SECRET="your-jwt-secret-here"

# Exactly 32 characters for AES-256
ENCRYPTION_KEY="your-32-character-encryption-key"

NEXT_PUBLIC_APP_URL="http://localhost:3000"
SESSION_DURATION=86400
```

### 5. Set up database

```bash
# Push schema to database
npm run db:push

# Seed default admin user (admin@example.com / admin123)
npm run db:seed
```

### 6. Run the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Default credentials

After seeding, log in with:
- **Email:** `admin@example.com`
- **Password:** `admin123`

> ⚠️ Change the admin password immediately in production!

---

## Project Structure

```
src/
├── app/
│   ├── login/              # Login page
│   ├── dashboard/
│   │   ├── page.tsx        # Overview + recent listings
│   │   ├── parse/          # Parse a listing URL
│   │   └── link-account/   # Link myhome.ge credentials
│   ├── admin/
│   │   └── page.tsx        # User management table
│   └── api/
│       ├── auth/           # login, logout, register, me
│       ├── myhome/         # link, parse, create-post
│       └── admin/          # users CRUD
├── components/
│   └── Sidebar.tsx         # Navigation sidebar
├── lib/
│   ├── auth.ts             # JWT session management
│   ├── db.ts               # Prisma client singleton
│   ├── encryption.ts       # AES-256 encrypt/decrypt
│   ├── myhome-parser.ts    # Playwright scraper & poster
│   └── utils.ts            # Helpers
└── middleware.ts            # Route protection + session guard
```

---

## How the parser works

1. User pastes a myhome.ge listing URL (e.g. `https://www.myhome.ge/pr/24724106/...`)
2. Playwright opens a headless Chromium browser, navigates to the page, and extracts:
   - Title, price, currency
   - Images (up to 30)
   - Description, address
   - Area, rooms, floor/total floors
   - All property detail key-value pairs
3. The data is saved to the database and shown in the UI
4. User can click **Publish** — the app logs into myhome.ge using stored credentials and navigates to the post creation form at `https://statements.myhome.ge/ka/statement/create`

---

## Security notes

- Passwords are hashed with bcrypt (cost 12)
- myhome.ge passwords are AES-256-CBC encrypted before storage
- Sessions are HTTP-only cookies (not accessible via JS)
- Only one active session per user — logging in elsewhere invalidates the previous session
- Deactivating a user via admin panel immediately invalidates their session

---

## Production deployment

1. Set `NODE_ENV=production` in your environment
2. Use a proper `JWT_SECRET` (32+ random bytes)
3. Use a proper `ENCRYPTION_KEY` (exactly 32 characters)
4. Run `npm run build && npm start`
5. Point a reverse proxy (nginx/Caddy) at port 3000
6. Ensure Playwright's Chromium is installed on the server: `npx playwright install --with-deps chromium`
