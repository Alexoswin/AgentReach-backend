# ReachConvert Backend

NestJS API for **ReachConvert** — an outreach platform that unifies personalized bulk
email, autonomous AI voice calling, and signal-based automation for exploring job
opportunities and driving conversions.

The service exposes a REST API under `/api`, an interactive Swagger UI under `/docs`,
and a raw WebSocket endpoint (`/twilio/stream`) that bridges live phone calls to
Google Gemini Live for real-time, low-latency voice conversations.

---

## System documentation

Contributor-facing docs for the full workspace live one level up in [`../docs`](../docs):

- [Full architecture](../docs/ARCHITECTURE.md)
- [Feature documentation index](../docs/FEATURES.md)
- [Authentication, profile, and appearance](../docs/features/auth-and-profile.md)
- [Settings and provider integrations](../docs/features/settings-and-integrations.md)
- [Contacts and directories](../docs/features/contacts.md)
- [Email campaigns and templates](../docs/features/email-campaigns-and-templates.md)
- [AI calling and realtime voice](../docs/features/ai-calling-and-realtime-voice.md)
- [Signals and playbooks](../docs/features/signals-and-playbooks.md)

Use this README for backend setup and route orientation. Use `../docs` for
cross-app architecture and deeper feature implementation notes.
For operator-facing product guides, use the in-app `/documentation` portal in
the frontend; for engineering details, use `../docs`.

---

## Tech stack

| Concern            | Choice                                                        |
| ------------------ | ------------------------------------------------------------- |
| Framework          | [NestJS 11](https://nestjs.com) (Express platform)            |
| Language           | TypeScript 5                                                  |
| Database           | MongoDB via [Mongoose 9](https://mongoosejs.com) (`@nestjs/mongoose`) |
| Auth               | JWT access + refresh tokens, custom salted-hash passwords     |
| Email              | AWS SES (`@aws-sdk/client-ses`)                               |
| LLM (text)         | Google Gemini text models (template/campaign generation, signal classification) |
| LLM (voice)        | Google Gemini Live (`@google/genai`) — native audio streaming |
| Telephony          | Twilio (outbound calls, media streams, recordings)           |
| RAG / embeddings   | Gemini embeddings stored in MongoDB for bot knowledge bases   |
| File parsing       | `csv-parse`, `pdf-parse` (contact import, resume/reference PDFs) |
| Scheduling         | `@nestjs/schedule` (signal polling cron)                      |
| Signal sources     | RSS/news, SEC EDGAR, job boards, SES bounces                 |
| API docs           | `@nestjs/swagger` + `swagger-ui-express`                     |
| Validation         | `class-validator` + `class-transformer` DTOs                 |

---

## Architecture overview

The application is a set of feature modules registered in
[`src/app.module.ts`](src/app.module.ts). Each module owns a controller (HTTP
routes), a service (business logic), DTOs (request validation), and shares the
Mongoose schemas in [`src/schemas/`](src/schemas/).

```
Client (Next.js frontend)
        │  REST /api + Bearer JWT
        ▼
┌───────────────────────────────────────────────────────────┐
│                       NestJS App                           │
│                                                            │
│  Auth ── guards every route (global AuthGuard + @Public)   │
│                                                            │
│  Contacts   Templates   EmailCampaigns   CallingCampaigns  │
│  Bot(RAG)   Signals      History          Analytics        │
│  Settings (encrypted per-tenant credentials)               │
│                                                            │
│  RealtimeCalling ── WS /twilio/stream ⇄ Gemini Live        │
│  SignalsScheduler ── cron ⇒ collectors ⇒ classify ⇒ match  │
└───────────────────────────────────────────────────────────┘
        │                         │                    │
        ▼                         ▼                    ▼
    MongoDB                  AWS SES / Gemini       Twilio / Gemini
```

### Modules

| Module               | Path                             | Responsibility |
| -------------------- | -------------------------------- | -------------- |
| **Auth**             | `src/auth`                       | Register, login, refresh, logout, profile/password updates, `me`. Issues JWT access + refresh tokens. A global `AuthGuard` protects every route unless marked `@Public()`. |
| **Settings**         | `src/settings`                   | Stores per-install credentials (AWS SES, Twilio, Gemini) **encrypted at rest**. Connection-test endpoints for each provider and a Gemini voice preview. |
| **Contacts**         | `src/contacts`                   | Contact + contact-directory CRUD, CSV/XLSX/PDF file parsing, and bulk import. |
| **Templates**        | `src/templates`                  | Email template CRUD, predefined templates, AI generation (sync + async job), and reference-PDF ingestion for style matching. |
| **EmailCampaigns**   | `src/email-campaigns`            | Campaign CRUD, add/remove contacts, and launch (sends via SES, tracks per-contact status). |
| **Bot**              | `src/bot`                        | "AI calling bot" personas with a RAG knowledge base. PDF is chunked + embedded (Gemini) and stored for semantic search. Serves the Google voice list. |
| **CallingCampaigns** | `src/calling-campaigns`          | Calling campaign CRUD, AI generation, launch/relaunch/stop, and Twilio webhook callbacks (answer/respond/status/recording) + recording audio proxy. |
| **RealtimeCalling**  | `src/realtime-calling`           | The live-call engine. Upgrades `/twilio/stream` WebSockets, transcodes audio (`audio-codec.ts`), and pipes it to a Gemini Live session with tools, prompts, language profiles, and resumable sessions. |
| **Signals**          | `src/signals`                    | Signal-based outreach. Collectors ingest events → classifier (LLM) categorizes → matching engine scores against watches/playbooks → trigger service can auto-launch outreach. Includes a review queue, playbooks, and company watches. Cron-scheduled polling. |
| **History**          | `src/history`                    | Queryable email + call history (with filters) and email replies. |
| **Analytics**        | `src/analytics`                  | Aggregated dashboard metrics across channels. |

### Data model

Mongoose schemas live in [`src/schemas/`](src/schemas/): `user`, `system-settings`,
`contact`, `contact-directory`, `template`, `email-campaign`,
`email-campaign-contact`, `calling-campaign`, `call-history`, `ai-calling-bot`,
`ai-calling-bot-embedding`, `signal`, `signal-match`, `company-watch`, `playbook`,
and `triggered-outreach`.

---

## Getting started

### Prerequisites

- Node.js 20+ and npm
- A MongoDB database (local or MongoDB Atlas)

### Install & run

```bash
cd AgentReach-backend
npm install
cp .env.example .env      # then fill in the values below
npm run start:dev         # watch mode on http://localhost:3001
```

- **API base:** `http://localhost:3001/api`
- **Swagger UI:** `http://localhost:3001/docs`

### Environment variables

| Variable                   | Required | Description |
| -------------------------- | :------: | ----------- |
| `PORT`                     |    no    | HTTP port. Defaults to `3001`. |
| `DATABASE_URL`             |   yes    | MongoDB connection string. Falls back to `mongodb://localhost:27017/reachconvert`. |
| `JWT_SECRET`               |   yes    | Secret used to sign access/refresh tokens and call webhook URLs. Use a long random value. The server refuses to start in production without it. |
| `CREDENTIAL_ENCRYPTION_KEY`|   yes    | Key used to encrypt provider credentials stored in Settings. Required for real SES/Twilio/Gemini use. |
| `PUBLIC_API_URL`           |  calls   | Publicly reachable API base URL — used by Twilio webhooks. |
| `PUBLIC_WS_URL`            |  calls   | Public `wss://` URL for the `/twilio/stream` media socket. |
| `PUBLIC_APP_URL`           | prod     | Frontend origin used in password-reset email links. |
| `CORS_ORIGINS`             | optional | Comma-separated allowed origins. Empty allows all. |
| `ALLOW_REGISTRATION`       | optional | `true` opens sign-up in production (closed by default — data is shared across accounts). |
| `ALLOWED_SIGNUP_EMAILS`    | optional | Comma-separated emails that may sign up even when registration is closed. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | optional | Creates a first account on startup if that email does not exist. |
| `ENABLE_SWAGGER`           | optional | `true` serves `/docs` in production (off by default). |
| `GEMINI_API_KEY`           | optional | Bootstrap fallback. The encrypted key saved in Settings takes precedence. |
| `GEMINI_LIVE_MODEL`        | optional | Gemini Live model id (e.g. `gemini-2.5-flash-native-audio-preview-12-2025`). |

> Most provider credentials (AWS SES, Twilio, Gemini) are configured at
> runtime through **Settings** in the UI and stored **encrypted** in MongoDB, not in
> `.env`. If a required credential is missing, the connection-test and provider
> services return a descriptive error.

### Scripts

```bash
npm run start:dev     # watch mode
npm run start         # start once
npm run start:prod    # run compiled build (node dist/src/main)
npm run build         # nest build → dist/
npm run lint          # eslint --fix
npm run format        # prettier
npm run test          # unit tests (jest)
npm run test:e2e      # end-to-end tests
npm run test:cov      # coverage
```

---

## API reference

All routes are prefixed with `/api` and require a `Bearer <accessToken>` header
unless noted. Explore the live, always-accurate contract in **Swagger** at `/docs`.

### Auth — `/api/auth`
| Method | Path | Notes |
| ------ | ---- | ----- |
| POST | `/register` | Public. Create an account (closed in production unless allowed — see `ALLOW_REGISTRATION`). |
| POST | `/login` | Public. Returns access + refresh tokens. |
| POST | `/refresh` | Public. Exchange a refresh token for new tokens. |
| POST | `/forgot-password` | Public. Emails a one-time reset link (30 min) via SES. Same response for unknown emails. |
| POST | `/reset-password` | Public. Set a new password with the token from the reset link. |
| GET  | `/me` | Current user profile. |
| PATCH| `/profile` | Update name/email/theme/accent color. |
| POST | `/logout` | Invalidate the session. |

### Settings — `/api/settings`
`GET /` (masked), `PATCH /` (encrypted update), and connection tests:
`POST /test-ses`, `/test-twilio`, `/test-gemini`,
`/preview-gemini-voice`.

### Contacts — `/api/contacts`
CRUD on `/`, `/:id`; directories under `/directories` (+ `/:id`); `POST /parse-file`
(upload CSV/XLSX/PDF to preview) and `POST /import` (bulk create).

### Templates — `/api/templates`
CRUD on `/`, `/:id`; `GET /predefined`; `POST /generate` (sync AI) and the async job
pair `POST /generate-jobs` + `GET /generate-jobs/:id`; `POST /reference-pdf`.

### Email Campaigns — `/api/email-campaigns`
CRUD on `/`, `/:id`; `POST /:id/contacts`, `DELETE /:id/contacts/:contactId`;
`POST /:id/launch`; `POST /:id/schedule`; `POST /:id/unschedule`.

### AI Calling Bots — `/api/ai-calling-bots`
CRUD on `/`, `/:id`; `GET /voices/google`; RAG endpoint `POST /:id/search`. Bot creation accepts a `knowledgeBasePdf` upload that is chunked
and embedded.

### Calling Campaigns — `/api/calling-campaigns`
`GET /dashboard`, CRUD on `/`, `/:id`; AI generation (`/generate`, async
`/generate-jobs` + `/generate-jobs/:id`); lifecycle `POST /:id/launch`, `/relaunch`,
`/schedule`, `/unschedule`, `/stop`; recording audio proxy
`GET /recordings/:callId/audio`; and Twilio webhook callbacks under `/twilio/*`
(answer, respond, status, recording).

### Signals — `/api/signals`
`GET /` (feed, `?type=`), `GET /types`, `GET /stats`, `GET /review-queue`,
`POST /review/:matchId` (approve/reject), `POST /manual`, `POST /bounce`,
`POST /poll` (force a collection run). Playbooks under `/playbooks` (CRUD + `/:id/toggle`)
and company watches under `/watches` (list/create + `/:id/toggle` + delete).

### History — `/api/history`
`GET /emails`, `GET /calls` (both accept date/campaign/status filters),
`GET /replies/:emailId`.

### Analytics — `/api/analytics`
`GET /` — aggregated cross-channel dashboard metrics.

---

## Real-time calling flow

1. A calling campaign launches → Twilio places an outbound call, pointed at the
   backend's `/api/calling-campaigns/twilio/*` webhooks.
2. Twilio opens a media stream to the WebSocket at `/twilio/stream` (registered in
   [`src/main.ts`](src/main.ts) via an HTTP `upgrade` handler).
3. [`RealtimeCallingGateway`](src/realtime-calling/realtime-calling.gateway.ts)
   transcodes the μ-law audio, opens a **Gemini Live** session
   ([`gemini-live-session.wrapper.ts`](src/realtime-calling/gemini-live-session.wrapper.ts)),
   and streams audio both ways with barge-in handling, tool calls
   ([`call-tools.ts`](src/realtime-calling/call-tools.ts)), per-language prompts, and
   resumable session handles for reconnects.
4. Transcripts, outcomes, and recordings are persisted to call history.

---

## Signal-based automation

Collectors in [`src/signals/collectors/`](src/signals/collectors/) (news RSS, SEC
EDGAR, job boards, SES bounces) run on a schedule
([`scheduler.service.ts`](src/signals/scheduler.service.ts)) or on demand via
`POST /signals/poll`. Ingested signals are classified by an LLM
([`signal-classifier.service.ts`](src/signals/signal-classifier.service.ts)), matched
against company watches and playbooks
([`matching.service.ts`](src/signals/matching.service.ts)), and — when a playbook
allows — trigger outreach automatically
([`trigger.service.ts`](src/signals/trigger.service.ts)). Matches that need a human
land in the review queue.

---

## Default seed credentials

For local development a default user is available:

```text
Email:    oswinalex1@gmail.com
Password: DBIT@2026
```

Outbound test email sender:

```text
oswin.alex@oswinalex.site
```

> Verify the domain and sender in AWS SES before sending real email campaigns.
