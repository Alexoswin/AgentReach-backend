# ReachConvert Backend

A production-ready NestJS application built with TypeScript, ESLint, and strict code quality standards.

## 🚀 Features

- **NestJS (v11+)**: Robust, testable, and scalable architecture.
- **TypeScript**: Strict type checking and advanced TypeScript compiler options enabled.
- **MongoDB + Mongoose**: Schema/entity models live in `src/schemas`.
- **Environment Variables**: Robust environment variable configuration using `@nestjs/config`.
- **Preconfigured Linting**: Integrated ESLint rules for code consistency.

---

## 🛠️ Getting Started

### Prerequisites

Ensure you have **Node.js 18+** and **npm** (or your preferred package manager) installed.

### Setup

1. Clone the repository and navigate to the folder:
   ```bash
   cd AgentReach-backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create the environment file:
   ```bash
   cp .env.example .env
   ```
   Define your environment variables inside the `.env` file:
   ```env
   PORT=3001
   DATABASE_URL=mongodb+srv://USER:PASSWORD@HOST/DATABASE?retryWrites=true&w=majority
   JWT_SECRET=supersecretjwtkey
   ```

4. Start the server. Mongoose connects to `DATABASE_URL` and applies schema/entity definitions at runtime.

---

## 💻 Available Scripts

In the project directory, you can run:

### `npm run start`
Starts the application.

### `npm run start:dev`
Starts the application in watch (development) mode. The server will auto-reload when any files change.

### `npm run build`
Builds the application for production to the `dist` folder.

### `npm run lint`
Runs ESLint to check for syntax and style issues.
Strict linting is enforced with zero errors.

---

## 📁 Project Structure

```text
src/
├── app.controller.ts    # Single route controller
├── app.module.ts        # Root module of the application
├── app.service.ts       # Service with a single method
└── main.ts              # Entry file of the application
```
