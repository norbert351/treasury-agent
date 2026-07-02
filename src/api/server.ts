import express from 'express';
import cors from 'cors';
import { env } from '../config.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Serve sphere-sdk connect module for browser
app.get('/sdk/connect-browser.js', (_req, res) => {
  res.type('application/javascript').sendFile('/home/zubby/unicity-treasury-agent/node_modules/@unicitylabs/sphere-sdk/dist/impl/browser/connect/index.js');
});

// In-memory store (will be replaced with PostgreSQL in v2)
let agentStatus: any = { balance: '0', status: 'offline', lastChecked: null };
let transactionLog: any[] = [];

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'treasury-manager' });
});

app.get('/api/balance', (_req, res) => {
  res.json({
    balance: agentStatus.balance,
    coinId: 'UCT',
    lastChecked: agentStatus.lastChecked,
    status: agentStatus.status,
  });
});

app.get('/api/history', (_req, res) => {
  res.json({ transactions: transactionLog.slice(-50) });
});

app.post('/api/rules', (req, res) => {
  const { type, name, cron, recipient, amount, minBalance, targetCoin } = req.body;
  if (!type || !name) {
    return res.status(400).json({ error: 'type and name are required' });
  }
  const rule = {
    id: crypto.randomUUID(),
    type,
    name,
    active: 'true',
    cron: cron || null,
    recipient: recipient || null,
    amount: amount || null,
    minBalance: minBalance || null,
    targetCoin: targetCoin || null,
    createdAt: new Date().toISOString(),
  };
  transactionLog.push({ type: 'rule_created', rule, timestamp: new Date().toISOString() });
  res.status(201).json(rule);
});

app.get('/api/rules', (_req, res) => {
  // Returns from memory — will be from DB in v2
  const rules = transactionLog
    .filter((t: any) => t.type === 'rule_created')
    .map((t: any) => t.rule);
  res.json({ rules });
});

app.post('/api/topup', (req, res) => {
  const { amount } = req.body;
  if (!amount) return res.status(400).json({ error: 'amount is required' });

  transactionLog.push({
    type: 'topup_requested',
    amount,
    status: 'pending',
    timestamp: new Date().toISOString(),
  });

  res.json({
    message: `Top-up of ${amount} UCT requested. Send to agent's Sphere address.`,
    address: '@' + env.AGENT_NAMETAG,
  });
});

app.listen(env.PORT, () => {
  console.log(`[API] Treasury API running on http://localhost:${env.PORT}`);
});

export { app, agentStatus, transactionLog };
