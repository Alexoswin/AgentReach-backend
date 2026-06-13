# ReachConvert Backend

NestJS API for ReachConvert, a bulk email and AI calling app for exploring job opportunities.

## Responsibilities

- Authentication with access and refresh tokens
- User profile and password updates
- MongoDB persistence with Mongoose schemas
- Recruiter, company, hiring team, and lead contacts
- Manual and AI email templates
- Bulk email campaign launch and relaunch
- AI calling campaign records
- History, analytics, and settings
- AWS SES and OpenRouter integration

## Setup

```bash
cd AgentReach-backend
npm install
cp .env.example .env
npm run start:dev
```

Environment:

```env
PORT=3001
DATABASE_URL=mongodb://localhost:27017/reachconvert
JWT_SECRET=replace-with-a-long-random-secret
```

## URLs

- API: `http://localhost:3001/api`
- Swagger docs: `http://localhost:3001/docs`

## Scripts

```bash
npm run start:dev
npm run build
npm run start:prod
npm run lint
npm run test
```

## Default User

```text
Email: oswinalex1@gmail.com
Password: DBIT@2026
```

## Email Sender

```text
oswin.alex@oswinalex.site
```

Verify the domain and sender in AWS SES before sending real email campaigns.
