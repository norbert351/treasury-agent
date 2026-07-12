import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { getCoinIdBySymbol, toHumanReadable } from '@unicitylabs/sphere-sdk';
import { env } from '../config.js';
import { createUserSession, loadSession, saveSession, listSessions, refreshSessionBalance, processSessionRules, setUserNametag, parseCron, toSmallestUnits, findSessionByMnemonic, importWallet, KNOWN_COINS, COIN_DECIMALS, openSessionWallet, openSessionWalletDirect, DEFAULT_NOTIFICATION_PREFS } from '../session-manager.js';
import type { NotificationPrefs } from '../session-manager.js';

// Hardcoded coin IDs for testnet2 (from the token registry — avoids SDK lazy-load issue)
const COIN_ID_MAP: Record<string, string> = {
  UCT: 'f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0',
  BTC: '3cc412d8a24510d44a9f1a4f93be68d769c4c78997c36e6938fa1a63040dff5e',
  ETH: '746a4e75aeb32214bfa80c003ef9add61900bacdbff1c2ee3be5e523a658acb1',
  SOL: '72f7771d5690afcf89cfc16e8ee8c1a836d0faa8ed1b34d527aabc18acb949ae',
  USDT: 'bd7ad59dc3d86cf98734e4d1b5a1fa6f22b2f9e9d98c2c87a98bc63144d92718',
  USDC: '6684ca2f90cd0b0a2af965a1480ef78d389cc575e18a40cd1fce9b2cefefd2f7',
};

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
    mnemonic: session.mnemonic,
    rulesCount: session.rules.length,
    txCount: session.transactions.length,
  });
});

/** Recover agent wallet using seed phrase (mnemonic) */
app.post('/api/agent/recover', async (req, res) => {
  const { mnemonic } = req.body;
  if (!mnemonic || typeof mnemonic !== 'string') {
    return res.status(400).json({ error: 'mnemonic (seed phrase) is required' });
  }
  const existingId = findSessionByMnemonic(mnemonic);
  if (existingId) {
    // Already imported — return the existing session
    const session = loadSession(existingId);
    if (session) {
      return res.json({
        token: session.id,
        address: session.address,
        directAddress: session.directAddress,
        balance: session.balance,
        balances: session.balances,
        createdAt: session.createdAt,
        mnemonic: session.mnemonic,
        nametag: session.nametag,
        restored: true,
      });
    }
  }
  // Import wallet
  const session = await importWallet(mnemonic);
  if (!session) {
    return res.status(500).json({ error: 'Failed to import wallet. Check your seed phrase.' });
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
    restored: false,
  });
});

// ─── Session-scoped endpoints ───

app.get('/api/balance', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({
    balance: session.balance,
    balances: session.balances || {},
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

app.post('/api/rules', async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  const { type, name, cron, recipient, amount, minBalance, targetCoin, coinSymbol, recipients } = req.body;
  if (!type || !name) {
    return res.status(400).json({ error: 'type and name are required' });
  }

  const rule = {
    id: crypto.randomUUID(),
    type,
    name,
    active: 'true',
    coinSymbol: coinSymbol || 'UCT',
    cron: cron ? parseCron(cron) : (['recurring', 'dca', 'multi-pay', 'sweep'].includes(type) ? '0 0 * * *' : null),
    recipient: recipient || null,
    amount: amount ? toSmallestUnits(amount, coinSymbol || 'UCT') : null,
    recipients: recipients || null,
    minBalance: minBalance ? toSmallestUnits(minBalance, coinSymbol || 'UCT') : null,
    createdAt: new Date().toISOString(),
    lastRunAt: null as string | null,
  };

  session.rules.push(rule);
  session.transactions.push({
    id: crypto.randomUUID(),
    type: 'rule_created',
    amount: '',
    status: 'created',
    coinSymbol: rule.coinSymbol || 'UCT',
    timestamp: new Date().toISOString(),
    detail: `${type}: ${name}`,
  });

  saveSession(session);
  res.status(201).json(rule);

  // ─── Fire immediately for payment-type rules ───
  if (['recurring', 'dca', 'sweep', 'multi-pay'].includes(type)) {
    try {
      const sphere = await openSessionWalletDirect(session);
      if (sphere) {
        let execTxHash = '';
        if (type === 'multi-pay' && rule.recipients) {
          let rcps: Array<{r: string; a: string}> = [];
          try { rcps = JSON.parse(rule.recipients); } catch {}
          for (const rcp of rcps.slice(0, 10)) {
            const coinId = getCoinIdBySymbol(rule.coinSymbol || 'UCT');
            if (!coinId) continue;
            const amtSm = toSmallestUnits(rcp.a, rule.coinSymbol || 'UCT');
            const result = await sphere.payments.send({ coinId, amount: amtSm, recipient: rcp.r, memo: `First run: ${rule.name}` });
            if (!execTxHash) execTxHash = result.tokenTransfers?.find((t: any) => t.requestIdHex)?.requestIdHex || '';
          }
        } else if (rule.recipient && rule.amount) {
          const coinId = getCoinIdBySymbol(rule.coinSymbol || 'UCT');
          if (coinId) {
            const result = await sphere.payments.send({ coinId, amount: rule.amount, recipient: rule.recipient, memo: `First run: ${rule.name}` });
            execTxHash = result.tokenTransfers?.find((t: any) => t.requestIdHex)?.requestIdHex || '';
          }
        }
        rule.lastRunAt = new Date().toISOString();
        session.transactions.push({
          id: crypto.randomUUID(),
          type: 'send',
          amount: rule.amount || '',
          status: 'confirmed',
          txHash: execTxHash || undefined,
          counterparty: rule.recipient || null,
          coinSymbol: rule.coinSymbol || 'UCT',
          timestamp: new Date().toISOString(),
          detail: `⚡ First execution: ${rule.name}${execTxHash ? ' tx:' + execTxHash.slice(0, 12) : ''}`,
        });
        saveSession(session);
        await sphere.destroy();
        console.log(`[API] Rule "${rule.name}" fired immediately on creation`);
      }
    } catch (err: any) {
      console.error(`[API] Immediate rule execution failed:`, err?.message);
    }
  }
});

// ─── PATCH / DELETE rule by id ───
app.patch('/api/rules/:id', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const rule = session.rules.find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  if (req.body.active !== undefined) rule.active = req.body.active;
  if (req.body.name !== undefined) rule.name = req.body.name;
  if (req.body.cron !== undefined) rule.cron = req.body.cron;
  saveSession(session);
  res.json(rule);
});

app.delete('/api/rules/:id', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const idx = session.rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
  const removed = session.rules.splice(idx, 1)[0];
  saveSession(session);
  res.json({ deleted: removed.id });
});

app.post('/api/refresh', async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  const balance = await refreshSessionBalance(session);
  session.balance = balance;
  session.balances = session.balances || {};
  session.lastChecked = new Date().toISOString();
  saveSession(session);

  res.json({ balance, balances: session.balances, lastChecked: session.lastChecked });
});

/** Send a tip from the agent wallet to another user (async — returns immediately, processes in background) */
app.post('/api/tip', async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  const { recipient, amount, coinSymbol, message } = req.body;
  if (!recipient || !amount) {
    return res.status(400).json({ error: 'recipient and amount are required' });
  }

  const coin = (coinSymbol || 'UCT').toUpperCase();
  const coinId = COIN_ID_MAP[coin];
  if (!coinId) return res.status(400).json({ error: `Unsupported coin: ${coin}` });

  const amtSmallest = toSmallestUnits(String(amount), coin);

  // Acknowledge immediately — payment processes in background
  res.json({ status: 'processing', amount, coin, recipient, message: 'Tip is being sent. Check Activity for confirmation.' });

  // Background send
  try {
    const sphere = await openSessionWalletDirect(session);
    if (!sphere) { console.error('[Tip] Failed to open wallet'); return; }

    const result = await sphere.payments.send({
      coinId,
      amount: amtSmallest,
      recipient,
      memo: message ? `Tip: ${message}` : 'Tip from treasury agent',
    });

    const txHash = result.tokenTransfers?.find((t: any) => t.requestIdHex)?.requestIdHex;

    try {
      await sphere.communications.sendDM(recipient, `💡 You received a tip of ${amount} ${coin} from @${session.nametag || session.id.slice(0, 8)}${message ? ': ' + message : ''}`);
    } catch { /* non-critical */ }

    session.transactions.push({
      id: result.id,
      type: 'tip',
      amount: amtSmallest,
      status: String(result.status),
      txHash,
      counterparty: recipient,
      coinSymbol: coin,
      timestamp: new Date().toISOString(),
      detail: `💡 Tip ${amount} ${coin} to ${recipient}${message ? ': ' + message : ''}`,
    });
    saveSession(session);
    console.log(`[Tip] Sent ${amount} ${coin} to ${recipient} — tx:${txHash?.slice(0, 12) || 'pending'}`);
    await sphere.destroy();
  } catch (err: any) {
    console.error('[Tip] Background send failed:', err?.message);
    // Log failed attempt
    session.transactions.push({
      id: crypto.randomUUID(),
      type: 'tip_failed',
      amount: amtSmallest,
      status: 'failed',
      timestamp: new Date().toISOString(),
      detail: `💔 Tip ${amount} ${coin} to ${recipient} failed: ${err?.message || 'Unknown'}`,
    });
    saveSession(session);
  }
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

// ─── Execution Log ───

app.get('/api/logs', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({ logs: (session.executionLogs || []).slice(-100) });
});

// ─── Notification Preferences ───

app.get('/api/notifications/prefs', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({ prefs: session.notificationPrefs || { ...DEFAULT_NOTIFICATION_PREFS } });
});

app.post('/api/notifications/prefs', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  const { onRuleExecution, onDeposit, onError, onThreshold, dmEnabled, dmRecipient, webhookUrl } = req.body;
  session.notificationPrefs = {
    onRuleExecution: typeof onRuleExecution === 'boolean' ? onRuleExecution : (session.notificationPrefs?.onRuleExecution ?? true),
    onDeposit: typeof onDeposit === 'boolean' ? onDeposit : (session.notificationPrefs?.onDeposit ?? true),
    onError: typeof onError === 'boolean' ? onError : (session.notificationPrefs?.onError ?? true),
    onThreshold: typeof onThreshold === 'boolean' ? onThreshold : (session.notificationPrefs?.onThreshold ?? true),
    dmEnabled: typeof dmEnabled === 'boolean' ? dmEnabled : (session.notificationPrefs?.dmEnabled ?? false),
    dmRecipient: typeof dmRecipient === 'string' ? dmRecipient : (session.notificationPrefs?.dmRecipient ?? ''),
    webhookUrl: typeof webhookUrl === 'string' ? webhookUrl : (session.notificationPrefs?.webhookUrl ?? ''),
  };
  saveSession(session);
  res.json({ prefs: session.notificationPrefs });
});

// ─── Forwarded Messages Inbox ───

app.get('/api/messages', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({ messages: (session.forwardedMessages || []).slice(-50) });
});

app.post('/api/messages/read', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const { ids } = req.body;
  if (Array.isArray(ids)) {
    for (const m of (session.forwardedMessages || [])) {
      if (ids.includes(m.id)) m.read = true;
    }
    saveSession(session);
  }
  res.json({ ok: true });
});

/** Reply to a DM — detects natural language commands or sends as DM */
app.post('/api/messages/reply', async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const { to, content } = req.body;
  if (!to || !content) return res.status(400).json({ error: 'to and content required' });

  try {
    const sphere = await openSessionWalletDirect(session);
    if (!sphere) return res.status(500).json({ error: 'Failed to open wallet' });

    let resultContent = '';
    let isCommand = false;

    // ─── Natural Language Command Parsing ───
    const cmd = content.trim();

    // "send X [COIN] to @recipient" or "send @recipient X [COIN]"
    const sendMatch = cmd.match(/^(?:send|pay|transfer)\s+(\d+(?:\.\d+)?)\s+(UCT|BTC|ETH|SOL|USDT|USDC|USDU|EURU|ALPHT|DDSC)\s+(?:to\s+)?(@?\w[\w.-]*)$/i) ||
                      cmd.match(/^(?:send|pay|transfer)\s+(\d+(?:\.\d+)?)\s+(?:to\s+)?(@?\w[\w.-]*)\s+(UCT|BTC|ETH|SOL|USDT|USDC|USDU|EURU|ALPHT|DDSC)$/i) ||
                      cmd.match(/^(?:send|pay|transfer)\s+(\d+(?:\.\d+)?)\s+(?:to\s+)?(@?\w[\w.-]*)$/i) ||
                      cmd.match(/^(?:send|pay|transfer)\s+(@?\w[\w.-]*)\s+(\d+(?:\.\d+)?)\s+(UCT|BTC|ETH|SOL|USDT|USDC|USDU|EURU|ALPHT|DDSC)$/i);
    const tipMatch = cmd.match(/^tip\s+(@?\w[\w.-]*)\s+(\d+(?:\.\d+)?)\s+(UCT|BTC|ETH|SOL|USDT|USDC|USDU|EURU|ALPHT|DDSC)\s*(.+)?$/i) ||
                     cmd.match(/^tip\s+(@?\w[\w.-]*)\s+(\d+(?:\.\d+)?)\s*(.+)?$/i);

    if (sendMatch) {
      isCommand = true;
      const groups = sendMatch;
      let amt: string, coin: string, recipient: string;
      if (groups[2] && groups[3] && /^(UCT|BTC|ETH|SOL|USDT|USDC|USDU|EURU|ALPHT|DDSC)$/i.test(groups[2])) {
        // Pattern 1: send 1 UCT to @user
        amt = groups[1]; coin = groups[2].toUpperCase(); recipient = groups[3].replace(/^@/, '');
      } else if (groups[3] && /^(UCT|BTC|ETH|SOL|USDT|USDC|USDU|EURU|ALPHT|DDSC)$/i.test(groups[3])) {
        // Pattern 2: send 1 to @user UCT  ||  Pattern 4: send @user 1 UCT
        if (/^\d/.test(groups[1])) {
          // Pattern 2: send 1 to @user UCT
          amt = groups[1]; recipient = groups[2].replace(/^@/, ''); coin = groups[3].toUpperCase();
        } else {
          // Pattern 4: send @user 1 UCT
          recipient = groups[1].replace(/^@/, ''); amt = groups[2]; coin = groups[3].toUpperCase();
        }
      } else {
        // Pattern: send 1 to @user (no coin)
        amt = groups[1]; recipient = groups[2].replace(/^@/, ''); coin = 'UCT';
      }

      const coinId = getCoinIdBySymbol(coin);
      if (!coinId) { resultContent = `❌ Unknown coin: ${coin}`; }
      else {
        const amountSmallest = toSmallestUnits(amt, coin);
        try {
          const payResult = await sphere.payments.send({ coinId, amount: amountSmallest, recipient, memo: 'Chat command' });
          const txHash = Array.isArray(payResult?.tokenTransfers)
            ? payResult.tokenTransfers.find((t: any) => t.requestIdHex)?.requestIdHex || ''
            : '';
          resultContent = `✅ Sent ${amt} ${coin} → @${recipient}${txHash ? ' (tx: ' + txHash.slice(0, 10) + ')' : ''}`;
          // Log in activity
          session.transactions.push({
            id: crypto.randomUUID(), type: 'send', amount: amountSmallest, status: 'confirmed',
            txHash, counterparty: '@' + recipient, coinSymbol: coin,
            timestamp: new Date().toISOString(),
            detail: `💬 Chat: sent ${amt} ${coin} to @${recipient}`,
          });
        } catch (payErr: any) {
          resultContent = `❌ Payment failed: ${payErr?.message || 'Unknown error'}`;
        }
      }
    } else if (tipMatch) {
      isCommand = true;
      const g = tipMatch;
      let tipRecipient = g[1].replace(/^@/, '');
      let tipAmt = g[2];
      let tipCoin = g[3] && /^(UCT|BTC|ETH|SOL|USDT|USDC|USDU|EURU|ALPHT|DDSC)$/i.test(g[3]) ? g[3].toUpperCase() : 'UCT';
      let tipMsg = g[3] && !/^(UCT|BTC|ETH|SOL|USDT|USDC|USDU|EURU|ALPHT|DDSC)$/i.test(g[3]) ? g[3] : (g[4] || '');
      const coinSym = tipCoin;
      const coinId = getCoinIdBySymbol(coinSym);
      if (!coinId) { resultContent = `❌ Unknown coin: ${coinSym}`; }
      else {
        const amountSmallest = toSmallestUnits(tipAmt, coinSym);
        try {
          const payResult = await sphere.payments.send({ coinId, amount: amountSmallest, recipient: tipRecipient, memo: tipMsg?.trim() || 'Tip from chat' });
          const txHash = Array.isArray(payResult?.tokenTransfers)
            ? payResult.tokenTransfers.find((t: any) => t.requestIdHex)?.requestIdHex || ''
            : '';
          resultContent = `✅ Tipped ${tipAmt} ${coinSym} → @${tipRecipient}${txHash ? ' (tx: ' + txHash.slice(0, 10) + ')' : ''}`;
          session.transactions.push({
            id: crypto.randomUUID(), type: 'tip', amount: amountSmallest, status: 'confirmed',
            txHash, counterparty: '@' + tipRecipient, coinSymbol: coinSym,
            timestamp: new Date().toISOString(),
            detail: `💬 Chat: tipped ${tipAmt} ${coinSym} to @${tipRecipient}`,
          });
        } catch (tipErr: any) {
          resultContent = `❌ Tip failed: ${tipErr?.message || 'Unknown error'}`;
        }
      }
    } else if (/^(?:balance|bal|my balance|check balance|how much|what do i have)/i.test(cmd)) {
      isCommand = true;
      try {
        const lines: string[] = [];
        for (const sym of KNOWN_COINS) {
          const id = getCoinIdBySymbol(sym);
          if (id) {
            try {
              const assets = await sphere.payments.getBalance(id);
              const asset = Array.isArray(assets) ? assets[0] : null;
              if (asset && asset.confirmedAmount !== '0') {
                const human = toHumanReadable(asset.confirmedAmount, asset.decimals);
                lines.push(`${human} ${asset.symbol}`);
              }
            } catch {}
          }
        }
        resultContent = lines.length ? '📊 Balance:\n' + lines.join('\n') : '📊 All balances are 0';
      } catch (balErr: any) {
        resultContent = '❌ Balance check failed: ' + (balErr?.message || 'Unknown');
      }
    } else if (/^(?:status|stats|info|agent status)/i.test(cmd)) {
      isCommand = true;
      const ruleCount = session.rules.length;
      const txCount = session.transactions.length;
      resultContent = `🤖 Agent Status:\n• ${ruleCount} rule(s) active\n• ${txCount} transactions logged\n• Nametag: ${session.nametag || 'none'}\n• Last check: ${session.lastChecked || 'never'}`;
    } else {
      // Regular DM reply
      await sphere.communications.sendDM(to, content);
      resultContent = content;
    }

    const reply = {
      id: crypto.randomUUID(),
      from: session.nametag || 'agent',
      content: resultContent,
      timestamp: Date.now(),
      read: true,
      isReply: true,
    };
    if (!session.forwardedMessages) session.forwardedMessages = [];
    session.forwardedMessages.push(reply);
    saveSession(session);
    await sphere.destroy();

    if (isCommand) {
      // Also send the command's result back via DM so the user sees it on Sphere
      try {
        const sphere2 = await openSessionWalletDirect(session);
        if (sphere2) { await sphere2.communications.sendDM(to, resultContent); await sphere2.destroy(); }
      } catch {}
    }

    res.json({ ok: true, message: reply, isCommand });
  } catch (err: any) {
    console.error('[API] Reply DM failed:', err?.message);
    res.status(500).json({ error: 'Failed: ' + (err?.message || 'Unknown') });
  }
});

// ─── Start ───

// Export for Vercel serverless
export { app };

// Standalone server (only runs when executed directly, not when imported by Vercel)
const isMainModule = process.argv[1]?.includes('server');
if (!process.env.VERCEL && isMainModule) {
  app.listen(env.PORT, () => {
    console.log(`[API] Treasury Manager running on http://localhost:${env.PORT}`);
    const count = listSessions().length;
    console.log(`[API] ${count} existing user session(s)`);
  });
}
