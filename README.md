# Romdix Dialer

A browser-based power dialer CRM for cold-calling local service businesses.
Dark industrial UI, CSV import, calling sessions with a queue, live in-browser
calls, recordings, dispositions and a dashboard.

**Full setup, domain, white-label and troubleshooting guide: [SETUP.md](SETUP.md).**

The original spec came from a public Lovable walkthrough. This is a real
build of that spec — no Lovable, no Supabase account with someone else in
the middle. Just Postgres, a small Node API, and a React frontend.

## What's inside

```
api/     Node + Express + TypeScript, Postgres, Twilio + Telnyx adapters
web/     React 18 + Vite + Tailwind, Twilio Voice SDK in the browser
Dockerfile
docker-compose.yml
```

Pages: Dashboard, Leads, Sessions, Session Dialer, Call Log, Settings.
Plus a floating dial-anything widget that is available on every screen.

## Why this does not use Lovable Cloud

Lovable Cloud is Supabase. Here the database is your own Postgres container,
the API is part of the same app, and auth is a plain email/password session
cookie. Same schema, same row scoping by `workspace_id`, nothing rented.

## Domains and white labelling

**The name, logo and accent colour** live in the database, not in code. Sign in
and open **Settings → White label**. Changes apply instantly, including the
login screen, browser tab and favicon.

You can also seed them at deploy time with environment variables —
`BRAND_NAME`, `BRAND_INITIALS`, `BRAND_ACCENT`, `BRAND_LOGO_URL`. They only
apply until someone saves branding in the UI, after which the UI wins.

**Domains** belong to the host, not the app. In Coolify open the application →
**Domains** and add as many as you want, comma separated:

```
https://dialer.romdix.com, https://calls.romdix.com, https://dial.acme.com
```

Each needs its own DNS record pointing at the server. The app answers on any of
them because every URL it uses is relative — nothing is hardcoded to one host.

One exception: Twilio has to know a single address to fetch call instructions
from. Two ways to handle it:

- **Leave `PUBLIC_URL` unset** (default). Twilio follows whichever domain you
  were browsing when you saved Settings. After changing domains, press
  **Re-sync Twilio address** on the Settings page.
- **Set `PUBLIC_URL=**https://dialer.romdix.com**`.** Twilio always uses that
  one, regardless of which domain you are on.

## Local development

Requirements: Node 20+, and a Postgres you can reach.

```bash
# 1. database
createdb romdix_dialer            # or use the docker-compose db service

# 2. api
cd api
cp .env.example .env             # fill DATABASE_URL, APP_SECRET, PUBLIC_URL
npm install
npm run dev                      # http://localhost:8080

# 3. web (second terminal)
cd web
npm install
npm run dev                      # http://localhost:5173, proxies /api to :8080
```

## Production (Coolify)

1. Create a Postgres resource in Coolify. Copy its internal connection string.
2. Create a new application from this repo, build pack **Dockerfile**.
3. Environment variables:
   - `DATABASE_URL` — from step 1
   - `APP_SECRET` — 64 random hex chars (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
   - `PUBLIC_URL` — the HTTPS address of the app, no trailing slash
4. Point your subdomain at the app and let Coolify issue the certificate.
5. Open the app, sign up, then go to **Settings** and paste your Twilio
   Account SID, Auth Token and the phone number you bought.

`PUBLIC_URL` matters: Twilio fetches call instructions from
`$PUBLIC_URL/api/voice/twiml`, so it must be the public HTTPS address, not
`localhost`.

## How a call works

1. The browser asks `POST /api/voice/start` for a short-lived token and a call id.
2. The Twilio Voice SDK connects over WebRTC to Twilio.
3. Twilio fetches `/api/voice/twiml`, which returns `<Dial>` pointing at the
   lead's number (with recording, a ring timeout, and callbacks).
4. Twilio posts call progress to `/api/voice/status` and the finished recording
   to `/api/voice/recording`. Both update the same call row.
5. Recordings are played back through `/api/calls/:id/recording`, which proxies
   the file with our own auth — the provider URL is never exposed.

## Providers

`api/src/providers/` has one file per provider behind a small interface.
Twilio is complete. Telnyx is scaffolded (settings + selection work, calling is
the next piece). Adding a third provider means one new file and one line in
`providers/index.ts`.

## Notes and limits

- Calls are human-initiated, one at a time. Deliberately no parallel dialing.
- The app does not check the National DNC Registry. It does honour a
  `do_not_call` outcome and leaves those leads out of new sessions.
- Ring time is not billed by Twilio when nobody answers, so unanswered dials
  cost nothing on that provider.
