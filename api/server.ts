import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { env } from '../config.js';
import { createUserSession, loadSession, saveSession, listSessions, refreshSessionBalance, processSessionRules, setUserNametag } from '../session-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files (index.html, dashboard.html, etc.)
app.use(express.static(ROOT));

// ─── Helpers ───

function getSession(req: express.Request, res: express.Response): UserSession | null {
  const token = (req.headers['x-session-token'] || req.query.token) as string;
  if (!token) {
    res.status(401).json({ error: 'Missing X-Session-Token header' });
    return null;
  }
  const session = loadSession(token);
  if (!session) {
    res.status(404).json({ error: 'Session not found. Create an agent first.' });
    return null;
  }
  return session;
}

// Needs the UserSession type from session-manager
import type { UserSession } from '../session-manager.js';

// ─── Public endpoints (no session required) ───

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'treasury-manager', sessions: listSessions().length });
});

/** Create a new agent wallet for a user */
app.post('/api/agent/create', async (_req, res) => {
  const session = await createUserSession();
  if (!session) {
    return res.status(500).json({ error: 'Failed to create agent wallet' });
  }
  res.status(201).json({
    token: session.id,
    address: session.address,
    directAddress: session.directAddress,
    balance: session.balance,
    balances: session.balances,
    createdAt: session.createdAt,
    mnemonic: session.mnemonic,
    nametag: session.nametag,
  });
});

/** Load an existing session (returns just public data, token already known) */
app.post('/api/agent/load', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({
    address: session.address,
    directAddress: session.directAddress,
    nametag: session.nametag,
    balance: session.balance,
    balances: session.balances,
    lastChecked: session.lastChecked,
    createdAt: session.createdAt,
    rulesCount: session.rules.length,
    txCount: session.transactions.length,
  });
});

// ─── Session-scoped endpoints ───

app.get('/api/balance', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({
    balance: session.balance,
    balances: session.balances,
    coinId: 'UCT',
    lastChecked: session.lastChecked,
    status: 'active',
    address: session.address,
  });
});

app.get('/api/history', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({ transactions: session.transactions.slice(-50) });
});

app.get('/api/rules', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({ rules: session.rules });
});

app.post('/api/rules', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  const { type, name, cron, recipient, amount, minBalance, targetCoin, coinSymbol } = req.body;
  if (!type || !name) {
    return res.status(400).json({ error: 'type and name are required' });
  }

  const rule = {
    id: crypto.randomUUID(),
    type,
    name,
    active: 'true',
    coinSymbol: coinSymbol || 'UCT',
    cron: cron || null,
    recipient: recipient || null,
    amount: amount || null,
    minBalance: minBalance || null,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
  };

  session.rules.push(rule);
  session.transactions.push({
    id: crypto.randomUUID(),
    type: 'rule_created',
    amount: '',
    status: 'created',
    timestamp: new Date().toISOString(),
    detail: `${type}: ${name}`,
  });

  saveSession(session);
  res.status(201).json(rule);
});

app.post('/api/refresh', async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  const balance = await refreshSessionBalance(session);
  session.balance = balance;
  session.lastChecked = new Date().toISOString();
  saveSession(session);

  res.json({ balance, lastChecked: session.lastChecked });
});

/** Register a human-readable @nametag for the user's wallet */
app.post('/api/agent/nametag', async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  const { nametag } = req.body;
  if (!nametag || typeof nametag !== 'string') {
    return res.status(400).json({ error: 'nametag is required' });
  }

  const result = await setUserNametag(session, nametag);
  if (!result) {
    return res.status(409).json({ error: 'Nametag taken or unavailable. Try another.' });
  }

  res.json(result);
});

// ─── Start ───

app.listen(env.PORT, () => {
  console.log(`[API] Treasury Manager running on http://localhost:${env.PORT}`);
  const count = listSessions().length;
  console.log(`[API] ${count} existing user session(s)`);
});

export { app };
