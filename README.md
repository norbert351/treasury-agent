# Treasury Manager — Unicity Autonomous Agent

An autonomous treasury agent on **Unicity Sphere** that:
- Manages a wallet balance autonomously
- Executes recurring payments on schedule
- Sends alerts when balance runs low
- Logs every transaction
- Provides a dashboard for monitoring

## Quick Start

```bash
# Install dependencies
npm install

# Set up env
cp .env.example .env
# Edit .env with your Unicity testnet API key and wallet config

# Run the agent
npm run agent

# Run the API server (separate terminal)
npm run api

# Both together
npm run dev
```

## Architecture

See `architecture.html` for the full diagram.

**Agent** (Node.js, runs 24/7):
- Checks treasury every hour via scheduler
- Executes rules (recurring payments, threshold alerts)
- DMs user via Nostr when events happen

**API** (Express.js):
- `GET /api/balance` — agent wallet balance
- `GET /api/rules` — list configured rules
- `POST /api/rules` — create a new rule
- `GET /api/history` — transaction log
- `POST /api/topup` — deposit UCT into agent wallet

**Dashboard** (Next.js - see `dashboard/`):
- Live wallet balance
- Rules management
- Activity timeline

## Sphere SDK Primitives Used

| Primitive | Usage |
|-----------|-------|
| **Identity** | Agent's own wallet with @treasury_bot nametag |
| **Payments** | `send()`, `getBalance()`, `getTokens()` |
| **Payment Requests** | Request and receive funds from user |
| **Communications** | DM alerts to user |
| **Storage** | Persist wallet + tokens |

## XP Target

- **Silver Build**: 2500 XP
- **Agentic Bonus**: 1000 XP (agent acts autonomously)
- **Total**: 3500 XP

## Submission Info

- **Agentic**: Yes — agent initiates and completes all economic actions
- **AstridOS**: No
- **Network**: Unicity testnet2
