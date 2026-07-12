# Treasury Manager — Autonomous Agent on Unicity Sphere

An autonomous treasury agent on **Unicity Sphere testnet2** that:

- **Manages a wallet balance autonomously** — the agent has its own Sphere wallet with its own @nametag
- **Executes recurring payments on schedule** — schedule weekly/monthly payments to any @nametag
- **Sends alerts when balance runs low** — configurable threshold alerts via DM
- **Logs every transaction** — full transaction history via REST API
- **Provides a dashboard** — live balance, rules management, activity timeline
- **Agentic** — the agent initiates and completes all economic actions without human intervention

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up env
cp .env.example .env
# Edit .env with your Unicity testnet2 API key from https://developers.unicity.network

# 3. Run the agent (autonomous treasury loop)
npm run agent

# 4. Run the API server + dashboard (separate terminal)
npm run api

# 5. Both together
npm run dev
```

## Architecture

**Agent** (Node.js, runs 24/7):
- Initializes a Sphere wallet with its own identity
- Checks treasury every hour via scheduler
- Executes rules (recurring payments, threshold alerts)
- DMs user when events happen
- Listens for incoming transfers

**API** (Express.js):
- `GET /api/balance` — agent wallet balance
- `GET /api/rules` — list configured rules
- `POST /api/rules` — create a new rule
- `GET /api/history` — transaction log
- `POST /api/topup` — deposit UCT into agent wallet
- `GET /api/health` — health check

**Dashboard** (standalone HTML):
- Live wallet balance
- Rules management
- Activity timeline

## Sphere SDK Primitives Used

| Primitive | Usage |
|-----------|-------|
| **Identity** | Agent's own wallet with @treasury_bot nametag |
| **Payments** | `send()`, `getBalance()` |
| **Communications** | DM alerts to user via `dm()` |
| **Storage** | Persist wallet + tokens via file storage |
| **Wallet API** | Mailbox delivery for incoming/outgoing transfers |

## Quick Start Script

Run these commands after `npm install` and `.env` setup:

```bash
# Start the agent (creates wallet, starts treasury loop)
npm run agent

# In another terminal, start the API + dashboard
npm run api

# Open http://localhost:3001 in your browser
```

## Funding Your Agent

Once the agent is running, send UCT tokens to its @nametag address:

```bash
curl http://localhost:3001/api/balance
# → {"balance":"0","coinId":"UCT","status":"active"}

# Top up through the dashboard or send UCT to @treasury_bot
```

## XP Submission Info

| Field | Value |
|-------|-------|
| **Agentic** | Yes — agent initiates and completes all economic actions autonomously |
| **AstridOS** | No |
| **Network** | Unicity testnet2 |
| **Build Path** | B. Treasury Manager |
| **Category** | Silver Build (2500 XP) + Agentic Bonus (1000 XP) = 3500 XP |

### Submission Requirements
- [x] Code is public in a repository a reviewer can read and run
- [x] Agent runs autonomously on testnet2
- [x] Uses Sphere SDK primitives (Identity, Payments, Communications)
- [x] Moves value on the network (send UCT payments)
- [x] Provides dashboard for monitoring
- [x] Original build with real economic actions
