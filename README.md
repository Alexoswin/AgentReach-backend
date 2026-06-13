# ReachConvert Backend

This is the NestJS API for ReachConvert, a bulk email and AI calling app for exploring job opportunities. The backend handles authentication, MongoDB persistence, recruiter/company contacts, email templates, bulk email campaigns, AI calling campaign records, settings, history, analytics, AWS SES email sending, and OpenRouter-powered AI generation.

## Tech Stack

- NestJS 11
- TypeScript
- MongoDB
- Mongoose
- JWT-style access and refresh tokens
- AWS SES SDK
- Swagger API documentation

## API Base URL

The backend uses a global `/api` prefix.

Local API:

```text
http://localhost:3001/api
```

Swagger docs:

```text
http://localhost:3001/docs
```

## Setup

```bash
cd AgentReach-backend
npm install
cp .env.example .env
```

Example `.env`:

```env
PORT=3001
DATABASE_URL=mongodb://localhost:27017/reachconvert
JWT_SECRET=replace-with-a-long-random-secret
```

Use a strong random value for `JWT_SECRET` in production.

## Run Locally

```bash
npm run start:dev
```

The API will start at `http://localhost:3001/api` unless `PORT` is changed.

## Available Scripts

```bash
npm run start
```

Starts the application once.

```bash
npm run start:dev
```

Starts the application in watch mode.

```bash
npm run build
```

Builds the app into `dist`.

```bash
npm run start:prod
```

Runs the compiled production build.

```bash
npm run lint
```

Runs ESLint with fixes.

```bash
npm run test
```

Runs unit tests.

## Default Data

On startup, `MongoService` seeds required system settings and the default user if missing.

Default user:

```text
Email: oswinalex1@gmail.com
Password: DBIT@2026
```

Default sender email:

```text
oswin.alex@oswinalex.site
```

For production, verify the sender domain/address in AWS SES and change the default password after first login.

## Main Modules

```text
src/auth/                 # Login, refresh token, logout, profile, password reset
src/contacts/             # Recruiter, company, hiring team, and lead contacts
src/templates/            # Manual and AI email templates for job outreach
src/email-campaigns/      # Bulk campaign creation, launch, relaunch, sending
src/calling-campaigns/    # AI calling follow-up campaign records
src/history/              # Job outreach history
src/analytics/            # Dashboard metrics
src/settings/             # AWS SES and OpenRouter settings
src/schemas/              # MongoDB schema/entity definitions
src/mongo.service.ts      # Prisma-like Mongo delegate helpers and seed data
```

## Job Outreach Workflow

The API supports this main workflow:

1. Store job opportunity contacts.
2. Create manual or AI-generated email templates.
3. Save templates as HTML or plain text.
4. Create a bulk email campaign.
5. Send the campaign through AWS SES.
6. Relaunch the campaign later for follow-up.
7. Track AI calling campaigns and outreach history.
8. Show analytics in the dashboard.

## Authentication

The backend issues:

- Access token
- Refresh token

Refresh tokens are hashed before being stored in MongoDB. Passwords are also hashed before storage.

Protected routes use `AuthGuard`. Public routes are marked with the public decorator.

## Email Sending

Email settings are stored in MongoDB system settings. To send real email:

- Verify `oswinalex.site` in AWS SES
- Verify `oswin.alex@oswinalex.site` as a sender, or use a verified domain identity
- Move AWS SES out of sandbox mode for sending to unverified recipients
- Configure AWS credentials and region in Settings or environment-backed seed values

Use the sender domain responsibly. For job outreach, messages should be professional, accurate, and sent only to relevant contacts.

## MongoDB

The app uses Mongoose schemas in `src/schemas`. There is no Prisma schema. `MongoService` exposes simple delegate-style helpers so the rest of the app can perform common database operations consistently.

Local MongoDB example:

```env
DATABASE_URL=mongodb://localhost:27017/reachconvert
```

MongoDB Atlas example:

```env
DATABASE_URL=mongodb+srv://USER:PASSWORD@HOST/reachconvert?retryWrites=true&w=majority
```

## Production Checklist

- Set a strong `JWT_SECRET`
- Use a production MongoDB database
- Verify AWS SES sender/domain
- Configure OpenRouter key if AI generation is enabled
- Run `npm run build`
- Start with `npm run start:prod`
