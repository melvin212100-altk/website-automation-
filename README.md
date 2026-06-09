# WhatsApp AI Gateway

Independent WhatsApp gateway + AI support microservice. Designed for Railway.

## What changed in this update

**Fixes**
- Added missing `@hapi/boom` dependency.
- Fixed reconnect logic (previously always reconnected, even after logout).
- Fixed `railway.json` build command order (was running `prisma generate` before `npm install`).
- Added `prisma migrate deploy` to the start command so tables exist on first boot.
- Replaced the `useMultiFileAuthState('temp')` filesystem bootstrap with the in-memory `initAuthCreds()` (Railway disk is ephemeral).
- Used Baileys' `BufferJSON` reviver/replacer for correct binary serialization (the old custom replacer corrupted some key material).

**Hardening / upgrades**
- Required env vars validated at boot; process exits with a clear message if any are missing.
- Exponential-backoff reconnect with attempt counter.
- Auto-clears stored credentials when WhatsApp reports `loggedOut` so the next boot can re-pair.
- `/health` now reports WhatsApp connection state and uptime (still returns 200 for Railway).
- New `POST /api/chats/:phone/status` endpoint to flip a conversation to `HUMAN_REQUIRED` / `RESOLVED` / `BOT_HANDLED`.
- 503 response from `/api/send-message` when the socket isn't ready yet (instead of crashing).
- Graceful SIGTERM/SIGINT shutdown (Prisma disconnect, socket close).
- Bumped dependencies to current versions.
- Added composite Prisma index `(phone_number, timestamp)` — the "fetch last message per phone" query was the hot path.

## Environment variables

See `.env.example`. Required: `DATABASE_URL`, `GEMINI_API_KEY`, `GATEWAY_AUTH_TOKEN`, `PERSONAL_NUMBER`.

## Railway deploy

1. Create a Railway project, add the **Postgres** plugin (auto-injects `DATABASE_URL`).
2. Add the other env vars from `.env.example`.
3. Deploy. On first boot, watch the logs for the **8-character pairing code** and enter it in WhatsApp → Linked Devices → Link with phone number.

`railway.json` already wires the build (Nixpacks) and start command
(`npx prisma migrate deploy && node index.js`) and points the healthcheck
at `/health`.

## API

### `POST /api/send-message`
Headers: `X-Gateway-Auth: <GATEWAY_AUTH_TOKEN>`
Body: `{ "phoneNumber": "2547XXXXXXXX", "message": "Hello" }`

### `POST /api/chats/:phone/status`
Headers: `X-Gateway-Auth: <GATEWAY_AUTH_TOKEN>`
Body: `{ "status": "HUMAN_REQUIRED" | "BOT_HANDLED" | "RESOLVED" }`

### `GET /health`
Returns `{ status, whatsapp, uptime }`.

## Prisma migrations

Locally, after editing `schema.prisma`:

```
npx prisma migrate dev --name <change>
```

Commit the generated `prisma/migrations/` folder. Railway will run
`prisma migrate deploy` automatically on each deploy.
