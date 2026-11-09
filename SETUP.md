# Romdix Dialer — Setup & Operations Manual

Everything needed to run this app: first deploy, Twilio wiring, domains,
white labelling, daily use, and what to do when something breaks.

Last updated: November 2026.

---

## 1. What this is

A browser-based power dialer CRM for cold-calling local businesses. Import a
CSV of leads, build a calling session, and work through the queue. Calls run in
the browser over WebRTC through Twilio — no softphone, no phone bridge.

**Pages:** Dashboard · Leads · Sessions · Session Dialer · Call Log · Settings.
Plus a floating dial-anything widget available on every screen.

**Stack:**

| Layer | What |
|---|---|
| Frontend | React 18 + Vite + TypeScript + Tailwind |
| API | Node 22 + Express + TypeScript |
| Database | PostgreSQL 17 |
| Voice | Twilio Voice SDK (Telnyx adapter scaffolded, not live) |
| Host | Coolify (Dockerfile build) |

Everything ships as one Docker image: the API serves the built frontend and the
API on port 8080.

---

## 2. Where it currently lives

| Thing | Value |
|---|---|
| Repository | `github.com/romdix/romdix-dialer` (public) |
| Coolify | `https://coolify.romdix.com` |
| Coolify project | Romdix Dialer |
| Coolify application | `romdix-dialer` (`ws08w08sw44wg40g48ok8g4o`) |
| Server | the Coolify host itself — "localhost" — `15.204.210.185` |
| Database service | `romdix-dialer-db` (`wgcg0kgk44wwo8c84socoscw`), user `romdix`, database `romdix_dialer`, same host |
| Live URL | **https://dialer.romdix.com** |
| Fallback URL | `https://ws08w08sw44wg40g48ok8g4o.15.204.210.185.sslip.io` |

`dialer.romdix.com` is a CNAME to `coolify.romdix.com`, which resolves to
`15.204.210.185`. That works because the app and the Coolify control panel share
a host. The app previously ran on the separate "softicx" server
(`158.69.211.35`); it was moved here and that copy was removed.

---

## 3. Deploying from scratch

You need: a Coolify instance, a server added to it, and a Postgres database.

### 3.1 Create the project

Coolify → **Projects → + Add** → name it (e.g. `Romdix Dialer`).

### 3.2 Create the database

Inside the project → **+ New → Database → PostgreSQL**.

- Name: `romdix-dialer-db`
- User: `romdix`
- Database: `romdix_dialer`
- Password: generate a long one and keep it

**Important:** after creating it, open it and press **Start**. A fresh database
resource often sits in `exited:unhealthy` until started once. Wait for
`running:healthy` before deploying the app.

Copy the **internal connection string** — it looks like:

```
postgres://romdix:YOUR_PASSWORD@<db-uuid>:5432/romdix_dialer
```

The host is the database's UUID, not a hostname. That works because Coolify puts
both containers on the same Docker network.

### 3.3 Create the application

Project → **+ New → Application → Private/Public Repository** (the repo is
public, so either works) and select `romdix/romdix-dialer`, branch `main`.

Set **Build Pack: Dockerfile**. Coolify finds the `Dockerfile` at the repo root.

Port: **8080**.

### 3.4 Environment variables

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | yes | the internal connection string from 3.2 |
| `APP_SECRET` | yes | 64 random hex characters |
| `PORT` | no | `8080` (default) |
| `NODE_ENV` | no | `production` |
| `PUBLIC_URL` | no | leave empty — see section 6 |
| `PUBLIC_URLS` | no | extra hostnames, comma separated |
| `COOKIE_DOMAIN` | no | e.g. `.romdix.com` to share logins across subdomains |
| `BRAND_NAME` | no | e.g. `Romdix Dialer` |
| `BRAND_INITIALS` | no | e.g. `RD` |
| `BRAND_ACCENT` | no | hex, e.g. `#22C55E` |
| `BRAND_LOGO_URL` | no | image URL used instead of initials |

Generate `APP_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`APP_SECRET` encrypts the Twilio credentials stored in the database. If you
change it later, saved Twilio credentials become unreadable and must be
re-entered. Set it once and keep it.

### 3.5 Deploy

Press **Deploy**. First build takes 2–4 minutes. You are done when the app
status reads `running:healthy`.

---

## 4. Connecting Twilio

1. Create an account at twilio.com and verify your email and phone.
2. Buy a number with **Voice** capability (Phone Numbers → Buy a Number).
3. On the Twilio Console home page, copy the **Account SID** and **Auth Token**.
4. Open your dialer → **Settings** → paste both → **Test credentials**.
5. It lists the numbers on the account. Click one to set it as caller ID.
6. Press **Save changes**.

On save the app creates a TwiML application in your Twilio account named after
your brand, pointing at `https://YOUR_DOMAIN/api/voice/twiml`, and stores its
SID. You never touch the Twilio console again unless you change domains.

**Trial accounts** can only call numbers you have verified in
*Phone Numbers → Verified Caller IDs*, and they play a trial announcement.
Add a card and upgrade before calling real leads.

### How a call flows

1. Browser asks `POST /api/voice/start` → gets a short-lived token + call id.
2. The Twilio Voice SDK connects over WebRTC.
3. Twilio fetches `/api/voice/twiml`, which returns `<Dial>` to the lead's number
   with recording, a ring timeout and callbacks.
4. Twilio posts progress to `/api/voice/status` and the finished recording to
   `/api/voice/recording`. Both update the same call row.
5. Recordings play back through `/api/calls/:id/recording`, which proxies the
   file behind your login — the provider URL is never exposed.

---

## 5. Setting a domain

### 5.1 DNS first

At your DNS provider (Cloudflare for `romdix.com`):

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `dialer` | `coolify.romdix.com` | **DNS only** (grey cloud) |
| *or* A | `dialer` | `15.204.210.185` | **DNS only** (grey cloud) |

Both work. A CNAME is only valid if it resolves to the server actually running
this app — pointing it at the Coolify panel host is fine only because the app
lives there too.

**Proxy must be off (grey cloud) for the first certificate.** Cloudflare in
*Full (strict)* mode refuses to talk to an origin that has no valid certificate,
and Traefik cannot obtain one while the proxy intercepts the validation. With
the proxy off, Cloudflare answers `526 Invalid SSL certificate`.

Once the certificate exists you can switch the proxy back on.

### 5.2 Then Coolify

Application → **Domains** → add:

```
https://dialer.romdix.com
```

Save. Traefik requests a Let's Encrypt certificate automatically; give it a
minute. The old sslip.io address can stay or be removed — removing it does not
affect the app.

### 5.3 Multiple domains, one server

Domains accepts a comma-separated list:

```
https://dialer.romdix.com, https://calls.romdix.com, https://dial.acme.com
```

Each entry needs its own A record pointing at the same IP. Nothing else to
configure — the app answers on whatever host reaches it because every URL it
uses is relative.

**The one exception is Twilio**, which must be told a single address to fetch
call instructions from. Two options:

- **`PUBLIC_URL` empty (default).** Twilio uses whichever domain you were
  browsing when you saved Settings. After adding or changing domains, press
  **Re-sync Twilio address** in Settings.
- **`PUBLIC_URL` set.** Twilio always uses that one address, regardless of
  which domain you visit.

### 5.4 Logins across domains

Session cookies are per-host by default. Signed in on `dialer.romdix.com` does
not sign you in on `calls.romdix.com`. To share one login, set:

```
COOKIE_DOMAIN=.romdix.com
```

Use a leading dot and the parent domain. Do not set this for unrelated domains
(`dial.acme.com`) — it will not work across different registrable domains.

---

## 6. White labelling

Name, logo and accent colour live in the database, not in code.

**Settings → White label:**

| Field | Effect |
|---|---|
| Product name | Sidebar, login screen, browser tab title |
| Initials | The coloured square when no logo is set |
| Accent colour | Every button, link, highlight and chart series |
| Logo URL | Replaces the initials square |

Changes apply immediately to anyone who reloads. The favicon is generated from
your initials and colour, so the browser tab matches.

**Precedence:** `BRAND_*` environment variables seed the values on a fresh
install. The moment someone presses **Save branding** in Settings, the database
takes over permanently — a redeploy will not overwrite it.

To rebrand a running install, use Settings. To ship a new install already
branded, set the environment variables before the first boot.

---

## 7. Daily use

### Import leads

Leads → **Import CSV** → drop a file or paste text.

The first row must be column names. The app guesses the mapping
(`business_name`, `phone`, `city`, `state`, `zip`, `address`, `website`,
`email`, `notes`) and shows the first five rows before you commit. Duplicate
phone numbers within the workspace are skipped automatically, so re-uploading an
overlapping list is safe.

### Build a session

Sessions → **New session** → pick a filter (status, outcome, city, state,
keyword, never-called, exclude do-not-call) → **Build session**.

This freezes a queue of up to 2,000 leads. The same list every time you open it,
with progress tracked.

### Work the queue

Open the session. The lead card shows the business, number, address and notes.
Press **Call now**.

- The keypad stays visible from connecting through the whole call.
- Disposition chips appear when the call ends. One click records the outcome and
  moves to the next lead.
- Tick **auto-dial next** to chain calls automatically after a disposition.
- Ring timeout is 45 seconds; unanswered dials are not billed by Twilio.

### Dial any number

The green phone button bottom-right is a global dial pad. It works from any
page and logs calls the same way.

### Fix an outcome later

Call Log → click a row → change the outcome. The lead record and the session
queue update with it.

---

## 8. Updating the app

Push to `main`. Then in Coolify press **Deploy** (or connect the repo webhook so
it deploys on push).

Database migrations run automatically on boot — the schema files are idempotent
and safe to re-run.

To roll back, use Coolify's deployment history and redeploy an earlier commit.

---

## 9. Troubleshooting

These are real failures hit during the first build, with the fix.

| Symptom | Cause | Fix |
|---|---|---|
| Deploy fails with `sh: vite: not found` | Coolify injects `NODE_ENV=production` into the build, so dev dependencies are skipped | Already fixed in the Dockerfile (`ENV NODE_ENV=development` + `npm install --production=false`). Keep those lines. |
| App starts then crashes with `getaddrinfo EAI_AGAIN <db-uuid>` | The database container was never started | Start the database resource in Coolify, wait for `running:healthy`, redeploy |
| `Repository not found` during deploy | The GitHub App does not have access to the repo | Add the repo to the app's installation, or use a public repo |
| `fqdn` field rejected by the API | This Coolify version wants `domains` on PATCH, and no `fqdn` at create time | Use `domains` |
| Repo URL becomes `https://github.com/https://github.com/...` | Coolify stores `owner/repo`, not a full URL | Set `git_repository` to `romdix/romdix-dialer` |
| `New container is not healthy, rolling back` | Healthcheck failed because the app crashed on boot | Read the app logs — usually a bad `DATABASE_URL` or missing `APP_SECRET` |
| Dialing says "Twilio is not configured yet" | No credentials saved for this workspace | Settings → paste Account SID and Auth Token → Save |
| Call connects but no audio | Wrong microphone selected | Settings → Microphone, or the picker in the dial widget. Browsers also need explicit mic permission per site. |
| Browser never asks for the microphone | Permission previously denied for this origin | Site settings → reset microphone permission |
| Twilio says the TwiML URL is unreachable | Domain changed but Twilio still points at the old one | Settings → **Re-sync Twilio address** |
| Nothing rings on a trial account | Trial accounts can only call verified numbers | Verify the number in Twilio, or upgrade the account |

### Useful checks

```bash
curl https://YOUR_DOMAIN/api/health
# {"ok":true,"db":"up","version":"0.1.0"}
```

If `db` is `down`, the database is unreachable — check it is running and that
`DATABASE_URL` is correct.

---

## 10. Security notes

- Twilio's Auth Token and the Telnyx key are encrypted at rest with AES-256-GCM,
  using `APP_SECRET` as the key. They are never returned to the browser — the
  Settings page only shows a masked form.
- Login is email + password with bcrypt hashing, and an httpOnly session cookie.
- Every query is scoped by `workspace_id`; one workspace cannot read another's
  leads or calls.
- Recordings are served through an authenticated endpoint, never as public URLs.
- The Coolify API token used during setup should be revoked when not needed.
  Coolify → Settings → Keys & Tokens.

---

## 11. Costs

Twilio, US local numbers, list prices:

| Item | Price |
|---|---|
| Phone number | $1.15 / month |
| Outbound call to US | $0.014 / min |
| Browser (WebRTC) leg | $0.004 / min |
| Recording | $0.0025 / min |
| Transcription (unused) | $0.05 / min |

Unanswered calls are **not** billed, so a dial that rings out costs nothing.
A typical solo operation at ~1,000 connected minutes per month lands near
**$28/month** including the number and recordings.

Telnyx prices the same units at roughly half ($0.007 outbound + $0.002 browser
leg). The adapter exists but calling is not wired up yet.

---

## 12. Not built yet

Deliberately out of scope for v1:

- **Telnyx calling.** Settings and the provider selector work; the dial path
  returns a clear error until implemented.
- **Conference / "join me" mode.** The TwiML for it exists, no UI yet.
- **Transcripts.** The column and player exist; nothing fills them.
- **National DNC registry checks.** The app honours a `do_not_call` outcome and
  keeps those leads out of new sessions, but does not query any registry.
- **Calling-hours guard by lead timezone.**
- **Parallel / multi-line dialing.**

---

## 13. File map

```
api/
  src/
    index.ts            express app, static serving, boot
    config.ts           env parsing, outcomes, statuses
    db.ts               pool, query helpers, migrations
    baseurl.ts          request-derived public URL
    crypto.ts           AES encryption for stored secrets
    filters.ts          lead filters, phone normalisation
    middleware.ts       session auth
    providers/          twilio.ts, telnyx.ts, shared interface
    routes/             auth, leads, sessions, calls, dashboard,
                        settings, brand, voice
    sql/                schema.sql, brand.sql
web/
  src/
    lib/                api client, auth, dialer (Voice SDK), brand
    components/         Shell, PhoneWidget, DialPad, ui
    pages/              Login, Dashboard, Leads, Sessions,
                        SessionDialer, CallLog, Settings
Dockerfile              multi-stage build, one image, port 8080
```
