import { Sphere, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { env } from './config.js';
import { db } from './db/index.js';
import { sessions } from './db/schema.js';
import { eq, desc } from 'drizzle-orm';

// All fungible tokens on testnet2 — the agent can check & send these
export const KNOWN_COINS = ['UCT', 'BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'USDU', 'EURU', 'ALPHT', 'DDSC'] as const;

// Decimals per coin (from testnet2 token registry)
export const COIN_DECIMALS: Record<string, number> = {
  UCT: 18, BTC: 8, ETH: 18, SOL: 9,
  USDT: 6, USDC: 6, USDU: 6, EURU: 6,
  ALPHT: 8, DDSC: 18,
};

export function parseCron(input: string): string {
  const s = input.trim().toLowerCase();
  const parts = s.split(/\s+/);
  if (parts.length === 5) return s;
  if (s === '24hr' || s === 'daily' || s === '24h') return '0 0 * * *';
  if (s === 'hourly' || s === '60min') return '0 * * * *';
  if (s === 'weekly') return '0 0 * * 0';
  if (s === '30min' || s === '30m') return '*/30 * * * *';
  return s;
}

/**
 * Convert a human-readable decimal amount to smallest units.
 * e.g. toSmallestUnits("3", "UCT") → "3000000000000000000"
 */
export function toSmallestUnits(amount: string, coinSymbol: string): string {
  const clean = amount.trim();
  if (!clean || clean === '0') return '0';
  const d = COIN_DECIMALS[coinSymbol] || 18;
  // Split on decimal point
  const parts = clean.split('.');
  const int = parts[0] || '0';
  const frac = (parts[1] || '').padEnd(d, '0').slice(0, d);
  // Remove leading zeros from int part, keep at least "0"
  const intClean = int.replace(/^0+/, '') || '0';
  return intClean + frac;
}

/** Reverse of toSmallestUnits: convert smallest unit string back to human decimal */
export function fmtHuman(amt: string, coinSymbol: string): string {
  if (!amt || amt === '0') return '0';
  const d = COIN_DECIMALS[coinSymbol] || 18;
  const s = amt.padStart(d + 1, '0');
  const i = s.slice(0, s.length - d) || '0';
  const f = s.slice(s.length - d).replace(/0+$/, '');
  return f ? i + '.' + f : i;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SESSIONS_DIR = resolve(ROOT, 'sphere-data/sessions');

export interface ExecutionLogEntry {
  id: string;
  timestamp: string;
  ruleName: string;
  ruleType: string;
  action: string;                // 'send' | 'alert' | 'info'
  amount: string;
  coinSymbol: string;
  recipient: string | null;
  status: string;                // 'success' | 'failed' | 'info'
  detail: string;
  txHash?: string;
}

export interface NotificationPrefs {
  onRuleExecution: boolean;
  onDeposit: boolean;
  onError: boolean;
  onThreshold: boolean;
  dmEnabled: boolean;
  dmRecipient: string;
  webhookUrl: string;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  onRuleExecution: true,
  onDeposit: true,
  onError: true,
  onThreshold: true,
  dmEnabled: false,
  dmRecipient: '',
  webhookUrl: '',
};

export interface ForwardedMessage {
  id: string;
  from: string;
  content: string;
  timestamp: number;
  read: boolean;
  isReply?: boolean;
}

export interface UserSession {
  id: string;
  address: string;
  directAddress: string;
  mnemonic: string;
  nametag: string | null;
  createdAt: string;
  balance: string;
  balances: Record<string, string>;   // symbol → amount
  lastChecked: string | null;
  rules: UserRule[];
  transactions: UserTx[];
  notificationPrefs: NotificationPrefs;
  executionLogs: ExecutionLogEntry[];
  lastReceivedAt: string | null;      // track deposits so we don't re-notify
  lastMsgCheckedAt: number | null;    // epoch ms — track forwarded DMs
  forwardedMessages: ForwardedMessage[];
}

export interface UserRule {
  id: string;
  type: string;
  name: string;
  active: string;
  coinSymbol: string;                 // e.g. 'UCT', 'BTC', 'ETH'
  cron: string | null;
  recipient: string | null;           // single recipient (for 'recurring' type)
  amount: string | null;              // single amount (for 'recurring' type)
  recipients: string | null;          // JSON array for multi-pay: [{"r":"@name","a":"1.5"},...]
  minBalance: string | null;
  createdAt: string;
  lastRunAt: string | null;
}

export interface UserTx {
  id: string;
  type: string;
  amount: string;
  status: string;
  timestamp: string;
  detail?: string;
  txHash?: string;    // on-chain request ID (requestIdHex)
  counterparty?: string | null;  // sender (receive) or recipient (send)
  coinSymbol?: string;  // e.g. 'UCT', 'BTC', 'SOL'
}

function sessionPath(id: string) { return resolve(SESSIONS_DIR, id); }
function sessionFile(id: string) { return resolve(SESSIONS_DIR, id, 'session.json'); }

export function listSessions(): string[] {
  try {
    // Try DB first
    const rows = db.select({ id: sessions.id }).from(sessions).orderBy(desc(sessions.updatedAt)).all();
    if (rows.length > 0) return rows.map(r => r.id);
  } catch { /* DB not available, fall back to files */ }
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR).filter(f => {
    try { return existsSync(resolve(SESSIONS_DIR, f, 'session.json')); }
    catch { return false; }
  });
}

export function loadSession(id: string): UserSession | null {
  try {
    // Try DB first
    const row = db.select({ data: sessions.data }).from(sessions).where(eq(sessions.id, id)).get();
    if (row) {
      const raw = row.data as any;
      if (!raw.notificationPrefs) raw.notificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
      else {
        const defs = DEFAULT_NOTIFICATION_PREFS;
        for (const key of Object.keys(defs) as (keyof NotificationPrefs)[]) {
          if (raw.notificationPrefs[key] === undefined) raw.notificationPrefs[key] = defs[key];
        }
      }
      if (!raw.executionLogs) raw.executionLogs = [];
      if (!raw.lastReceivedAt) raw.lastReceivedAt = null;
      if (!raw.lastMsgCheckedAt) raw.lastMsgCheckedAt = null;
      if (!raw.forwardedMessages) raw.forwardedMessages = [];
      return raw;
    }
  } catch { /* DB not available */ }
  // File fallback
  try {
    const raw = JSON.parse(readFileSync(sessionFile(id), 'utf-8'));
    if (!raw.notificationPrefs) raw.notificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
    else {
      const defs = DEFAULT_NOTIFICATION_PREFS;
      for (const key of Object.keys(defs) as (keyof NotificationPrefs)[]) {
        if (raw.notificationPrefs[key] === undefined) raw.notificationPrefs[key] = defs[key];
      }
    }
    if (!raw.executionLogs) raw.executionLogs = [];
    if (!raw.lastReceivedAt) raw.lastReceivedAt = null;
    if (!raw.lastMsgCheckedAt) raw.lastMsgCheckedAt = null;
    if (!raw.forwardedMessages) raw.forwardedMessages = [];
    return raw;
  } catch { return null; }
}

export function saveSession(session: UserSession): void {
  // Try DB first
  try {
    db.insert(sessions).values({ id: session.id, data: session as any }).onConflictDoUpdate({ target: sessions.id, set: { data: session as any, updatedAt: new Date() } }).run();
    return;
  } catch { /* DB not available */ }
  // File fallback
  const dir = sessionPath(session.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(sessionFile(session.id), JSON.stringify(session, null, 2));
}

/**
 * Create a new user session with a freshly generated Sphere wallet.
 * Returns session data OR null on failure.
 */
export async function createUserSession(): Promise<UserSession | null> {
  const id = crypto.randomUUID();
  const dataDir = sessionPath(id);

  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    const base = createNodeProviders({
      network: env.UNICITY_NETWORK as any,
      oracle: { apiKey: env.UNICITY_API_KEY },
      dataDir,
      tokensDir: dataDir + '/tokens',
    });

    const providers = createWalletApiProviders(base, {
      baseUrl: 'https://wallet-api.unicity.network',
      network: env.UNICITY_NETWORK,
      deviceId: `treasury-agent-${id.slice(0, 8)}`,
    });

    const { sphere, created, generatedMnemonic } = await Sphere.init({
      ...providers,
      network: env.UNICITY_NETWORK as any,
      autoGenerate: true,
      swap: true,
      accounting: true,
    });

    if (!created || !generatedMnemonic) {
      // Wallet already existed in this dir — load it
      console.log(`[Session] Loaded existing wallet for session ${id}`);
    }

    const session: UserSession = {
      id,
      address: sphere.identity?.directAddress || '@' + id.slice(0, 8),
      directAddress: sphere.identity?.directAddress || '',
      mnemonic: generatedMnemonic || '',
      nametag: null,
      createdAt: new Date().toISOString(),
      balance: '0',
      balances: {},
      lastChecked: null,
      rules: [],
      transactions: [],
      notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
      executionLogs: [],
      lastReceivedAt: null,
      lastMsgCheckedAt: null,
      forwardedMessages: [],
    };

    // Try to get initial balances for all known coins
    try {
      for (const sym of KNOWN_COINS) {
        const id = getCoinIdBySymbol(sym);
        if (!id) continue;
        const assets = sphere.payments.getBalance(id);
        const coin = assets?.find((a: any) => a.coinId === id);
        session.balances[sym] = coin?.totalAmount ?? '0';
      }
      session.balance = session.balances['UCT'] || '0';
    } catch { /* ok — wallet funded later */ }

    saveSession(session);
    await sphere.destroy();
    console.log(`[Session] Created session ${id} → ${session.address}`);
    return session;
  } catch (err) {
    console.error(`[Session] Failed to create session ${id}:`, err);
    return null;
  }
}

/**
 * Create a Sphere instance for a session (for balance checks, payments).
 * Caller must destroy() the instance when done.
 */
export async function openSessionWallet(session: UserSession): Promise<Sphere | null> {
  try {
    const base = createNodeProviders({
      network: env.UNICITY_NETWORK as any,
      oracle: { apiKey: env.UNICITY_API_KEY },
      dataDir: sessionPath(session.id),
      tokensDir: sessionPath(session.id) + '/tokens',
    });

    const providers = createWalletApiProviders(base, {
      baseUrl: 'https://wallet-api.unicity.network',
      network: env.UNICITY_NETWORK,
      deviceId: `treasury-agent-${session.id.slice(0, 8)}`,
    });

    const { sphere } = await Sphere.init({
      ...providers,
      network: env.UNICITY_NETWORK as any,
      mnemonic: session.mnemonic || undefined,
      autoGenerate: false,
      swap: true,
      accounting: true,
    });

    return sphere;
  } catch (err) {
    console.error(`[Session] Failed to open wallet for ${session.id}:`, err);
    return null;
  }
}

/**
 * Refresh all coin balances for a session.
 * Returns the UCT balance for backward compat.
 */
export async function refreshSessionBalance(session: UserSession): Promise<string> {
  const sphere = await openSessionWallet(session);
  if (!sphere) return session.balance;

  try {
    // Pull incoming transfers from wallet-api mailbox
    try { await sphere.payments.receive(); } catch { /* noop */ }

    for (const sym of KNOWN_COINS) {
      const id = getCoinIdBySymbol(sym);
      if (!id) continue;
      const assets = sphere.payments.getBalance(id);
      const coin = assets?.find((a: any) => a.coinId === id);
      session.balances[sym] = coin?.totalAmount ?? '0';
    }
    session.balance = session.balances['UCT'] || '0';
    return session.balance;
  } catch {
    return session.balance;
  } finally {
    await sphere.destroy();
  }
}

/**
 * Deliver a notification to the user based on their prefs.
 * - Sphere DM (if dmEnabled and sphere instance available)
 * - Webhook POST (if webhookUrl set)
 */
async function sendNotification(
  sphere: Sphere | null,
  session: UserSession,
  title: string,
  message: string,
): Promise<void> {
  const prefs = session.notificationPrefs || DEFAULT_NOTIFICATION_PREFS;
  const fullMsg = `[${title}] ${message}`;

  // Sphere DM
  if (prefs.dmEnabled && prefs.dmRecipient && sphere) {
    try {
      await sphere.communications.sendDM(prefs.dmRecipient, fullMsg);
      console.log(`[Notify] DM sent to ${prefs.dmRecipient}: ${title}`);
    } catch (err: any) {
      console.error(`[Notify] DM failed:`, err?.message);
    }
  }

  // Webhook POST
  if (prefs.webhookUrl && prefs.webhookUrl.startsWith('http')) {
    try {
      await fetch(prefs.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: title,
          message,
          session: session.id.slice(0, 8),
          timestamp: new Date().toISOString(),
        }),
      });
      console.log(`[Notify] Webhook POSTed to ${prefs.webhookUrl.slice(0, 40)}...`);
    } catch (err: any) {
      console.error(`[Notify] Webhook failed:`, err?.message);
    }
  }
}

/**
 * Execute a single payment: send, log, capture txHash, notify.
 */
async function executePayment(
  sphere: Sphere,
  session: UserSession,
  rule: UserRule,
  coinId: string,
  recipient: string,
  amount: string,
  coinSymbol: string,
): Promise<void> {
  // SDK expects bare nametag — @ prefix hangs transfers for unknown identities
  const cleanRecipient = String(recipient || '').replace(/^@/, '').trim();
  const logId = crypto.randomUUID();
  const ts = new Date().toISOString();
  try {
    const result = await sphere.payments.send({
      coinId,
      amount,
      recipient: cleanRecipient,
      memo: `Recurring: ${rule.name}`,
    });
    rule.lastRunAt = ts;
    const txHash = result.tokenTransfers?.find((t: any) => t.requestIdHex)?.requestIdHex;
    session.transactions.push({
      id: result.id,
      type: 'send',
      amount,
      status: String(result.status),
      txHash,
      counterparty: cleanRecipient ? '@' + cleanRecipient : null,
      coinSymbol,
      timestamp: ts,
      detail: `To @${cleanRecipient}: ${rule.name} (${coinSymbol})`,
    });
    session.executionLogs.push({
      id: logId,
      timestamp: ts,
      ruleName: rule.name,
      ruleType: rule.type,
      action: 'send',
      amount,
      coinSymbol,
      recipient: cleanRecipient ? '@' + cleanRecipient : null,
      status: 'success',
      detail: `Sent ${fmtHuman(amount, coinSymbol)} ${coinSymbol} → @${cleanRecipient}`,
      txHash,
    });
    console.log(`[Agent] Session ${session.id}: sent ${amount} ${coinSymbol} to @${cleanRecipient}`);
    if (session.notificationPrefs?.onRuleExecution !== false) {
      await sendNotification(sphere, session, 'Rule Executed', `${rule.name}: sent ${fmtHuman(amount, coinSymbol)} ${coinSymbol} → @${cleanRecipient}`);
    }
  } catch (err: any) {
    console.error(`[Agent] Session ${session.id}: payment to @${cleanRecipient} failed:`, err?.message);
    session.executionLogs.push({
      id: logId,
      timestamp: ts,
      ruleName: rule.name,
      ruleType: rule.type,
      action: 'send',
      amount,
      coinSymbol,
      recipient: cleanRecipient ? '@' + cleanRecipient : null,
      status: 'failed',
      detail: `Failed: ${err?.message || 'Unknown error'}`,
    });
    if (session.notificationPrefs?.onError !== false) {
      await sendNotification(sphere, session, 'Rule Failed', `${rule.name}: payment of ${fmtHuman(amount, coinSymbol)} ${coinSymbol} to @${cleanRecipient} failed — ${err?.message || 'Unknown error'}`);
    }
  }
}

/**
 * Cron due check — fires when scheduled local time is past and not yet run this slot.
 * Handles star-slash-N minute steps and standard 5-field cron. Uses !isNaN (never truthy hour/min checks).
 */
function isCronDue(cron: string, lastRunAt: string | null, now = new Date()): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minStr, hourStr, dom, mon, dow] = parts;

  // Minute step: */15, */30
  if (minStr.startsWith('*/')) {
    const step = parseInt(minStr.slice(2), 10);
    if (!step || step <= 0) return false;
    if (!lastRunAt) return true;
    return now.getTime() - new Date(lastRunAt).getTime() >= step * 60 * 1000;
  }

  const minute = parseInt(minStr, 10);
  const hour = parseInt(hourStr, 10);
  const sched = new Date(now);
  sched.setSeconds(0, 0);
  if (!isNaN(hour)) sched.setHours(hour);
  if (!isNaN(minute)) sched.setMinutes(minute);
  if (dom !== '*') {
    sched.setDate(parseInt(dom, 10));
    if (sched > now) sched.setMonth(sched.getMonth() - 1);
  }
  if (dow !== '*') {
    const diff = (parseInt(dow, 10) - sched.getDay() + 7) % 7;
    if (diff > 0) sched.setDate(sched.getDate() - 7 + diff);
  }
  return sched <= now && (!lastRunAt || new Date(lastRunAt) < sched);
}

async function fireWithTimeout(
  fn: () => Promise<void>,
  rule: UserRule,
  label: string,
): Promise<void> {
  try {
    const timeoutPromise = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('Payment timeout')), 30000),
    );
    await Promise.race([fn(), timeoutPromise]);
  } catch (fireErr: any) {
    console.error(`[Agent] Rule "${label}" error:`, fireErr?.message || fireErr);
  }
  // Always stamp lastRunAt so failures don't re-fire every 10 min
  rule.lastRunAt = new Date().toISOString();
}

/**
 * Process rules for a session: open wallet, check rules, execute.
 */
export async function processSessionRules(session: UserSession): Promise<void> {
  const sphere = await openSessionWallet(session);
  if (!sphere) return;

  try {
    // Snapshot old balances to detect incoming funds
    const oldBals = { ...(session.balances || {}) };

    // Pull incoming transfers from wallet-api mailbox — capture sender + token info
    let incomingTxHashes: Array<{ sym: string; txHash: string; sender: string; amount: string }> = [];
    try {
      const result = await sphere.payments.receive() as any;
      const transfers: any[] = result?.transfers ?? (Array.isArray(result) ? result : []);
      for (const tx of transfers) {
        if (!tx || !tx.tokens) continue;
        const sender = tx.senderNametag || (tx.senderPubkey ? '@' + tx.senderPubkey.slice(0, 16) : '') || '';
        for (const token of (tx.tokens || [])) {
          const sym = token.symbol || '';
          if (sym && KNOWN_COINS.includes(sym as any)) {
            incomingTxHashes.push({ sym, txHash: tx.id || '', sender, amount: token.amount || '0' });
          }
        }
      }
    } catch (e: any) {
      if (!String(e?.message || '').includes('No transfers')) console.warn('[Agent] receive() note:', e?.message);
    }

    // Init balances map for old sessions
    if (!session.balances) session.balances = {};

    // Refresh all coin balances
    for (const sym of KNOWN_COINS) {
      const id = getCoinIdBySymbol(sym);
      if (!id) continue;
      const assets = sphere.payments.getBalance(id);
      const coin = assets?.find((a: any) => a.coinId === id);
      session.balances[sym] = coin?.totalAmount ?? '0';
    }
    session.balance = session.balances['UCT'] || '0';
    session.lastChecked = new Date().toISOString();

    // Detect new deposits by comparing old vs new balances
    const now = new Date().toISOString();
    for (const sym of KNOWN_COINS) {
      const oldAmt = BigInt(oldBals[sym] || '0');
      const newAmt = BigInt(session.balances[sym] || '0');
      if (newAmt > oldAmt) {
        const diff = (newAmt - oldAmt).toString();
        // Look up txHash/sender from receive() result
        const match = incomingTxHashes.find(i => i.sym === sym);
        session.transactions.push({
          id: crypto.randomUUID(),
          type: 'receive',
          amount: diff,
          status: 'confirmed',
          txHash: match?.txHash,
          counterparty: match?.sender || null,
          coinSymbol: sym,
          timestamp: now,
          detail: `📥 Received ${fmtHuman(diff, sym)} ${sym}${match?.sender ? ' from ' + match.sender : ''}`,
        });
        session.executionLogs.push({
          id: crypto.randomUUID(),
          timestamp: now,
          ruleName: 'Incoming',
          ruleType: 'deposit',
          action: 'info',
          amount: diff,
          coinSymbol: sym,
          recipient: null,
          status: 'info',
          detail: `📥 Received ${fmtHuman(diff, sym)} ${sym}`,
        });
        // Notify if onDeposit pref is enabled (default true)
        if (session.notificationPrefs?.onDeposit !== false) {
          // Skip notification if we already notified for a deposit at this balance level
          const alreadyNotified = session.lastReceivedAt &&
            oldBals[sym] === '0' && session.lastReceivedAt === now;
          if (!alreadyNotified) {
            await sendNotification(sphere, session, 'Deposit Received', `📥 ${fmtHuman(diff, sym)} ${sym} arrived in your wallet`);
          }
        }
      }
    }
    session.lastReceivedAt = now;

    for (const rule of session.rules) {
      if (rule.active !== 'true') continue;

      const coinId = getCoinIdBySymbol(rule.coinSymbol || 'UCT');
      if (!coinId) continue;

      if (rule.type === 'recurring' && rule.cron && rule.recipient && rule.amount) {
        const parts = rule.cron.split(' ');
        if (parts.length >= 5) {
          const minute = parseInt(parts[0]);
          const hour = parseInt(parts[1]);
          const dom = parts[2]; const mon = parts[3]; const dow = parts[4];
          const now = new Date();
          const sched = new Date(now);
          sched.setSeconds(0, 0);
          if (!isNaN(hour)) sched.setHours(hour);
          if (!isNaN(minute)) sched.setMinutes(minute);
          if (dom !== '*') { sched.setDate(parseInt(dom)); if (sched > now) sched.setMonth(sched.getMonth() - 1); }
          if (dow !== '*') { const diff = (parseInt(dow) - sched.getDay() + 7) % 7; if (diff > 0) sched.setDate(sched.getDate() - 7 + diff); }

          const shouldFire = sched <= now && (!rule.lastRunAt || new Date(rule.lastRunAt) < sched);
          if (shouldFire) {
            console.log(`[Agent] Firing rule "${rule.name}": sched=${sched.toISOString()} lastRun=${rule.lastRunAt}`);
            try {
              const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('Payment timeout')), 60000));
              await Promise.race([executePayment(sphere, session, rule, coinId, rule.recipient!.replace(/^@/, ''), rule.amount!, rule.coinSymbol || 'UCT'), timeoutPromise]);
            } catch (fireErr: any) {
              console.error(`[Agent] Rule "${rule.name}" error:`, fireErr?.message || fireErr);
            }
          }
        }
      }

      // Multi-pay: pay multiple recipients in one rule
      if (rule.type === 'multi-pay' && rule.cron && rule.recipients) {
        const parts = rule.cron.split(' ');
        if (parts.length >= 5) {
          const minute = parseInt(parts[0]);
          const hour = parseInt(parts[1]);
          const dom = parts[2]; const mon = parts[3]; const dow = parts[4];
          const now = new Date();
          const sched = new Date(now); sched.setSeconds(0, 0);
          if (!isNaN(hour)) sched.setHours(hour);
          if (!isNaN(minute)) sched.setMinutes(minute);
          if (dom !== '*') { sched.setDate(parseInt(dom)); if (sched > now) sched.setMonth(sched.getMonth() - 1); }
          if (dow !== '*') { const diff = (parseInt(dow) - sched.getDay() + 7) % 7; if (diff > 0) sched.setDate(sched.getDate() - 7 + diff); }
          if (sched <= now && (!rule.lastRunAt || new Date(rule.lastRunAt) < sched)) {
            let recipients: Array<{r: string; a: string}> = [];
            try { recipients = JSON.parse(rule.recipients); } catch {}
            for (const rcp of recipients.slice(0, 10)) {
              const amtSmallest = toSmallestUnits(rcp.a, rule.coinSymbol || 'UCT');
              await executePayment(sphere, session, rule, coinId, rcp.r, amtSmallest, rule.coinSymbol || 'UCT');
            }
          }
        }
      }

      // DCA / Auto-invest: same as recurring but labeled as investment
      if (rule.type === 'dca' && rule.cron && rule.recipient && rule.amount) {
        const parts = rule.cron.split(' ');
        if (parts.length >= 5) {
          const minute = parseInt(parts[0]);
          const hour = parseInt(parts[1]);
          const dom = parts[2]; const mon = parts[3]; const dow = parts[4];
          const now = new Date();
          const sched = new Date(now); sched.setSeconds(0, 0);
          if (!isNaN(hour)) sched.setHours(hour);
          if (!isNaN(minute)) sched.setMinutes(minute);
          if (dom !== '*') { sched.setDate(parseInt(dom)); if (sched > now) sched.setMonth(sched.getMonth() - 1); }
          if (dow !== '*') { const diff = (parseInt(dow) - sched.getDay() + 7) % 7; if (diff > 0) sched.setDate(sched.getDate() - 7 + diff); }
          if (sched <= now && (!rule.lastRunAt || new Date(rule.lastRunAt) < sched)) {
            await executePayment(sphere, session, rule, coinId, rule.recipient!, rule.amount!, rule.coinSymbol || 'UCT');
          }
        }
      }

      // Sweep: on cron, if balance > threshold, sweep excess to recipient
      if (rule.type === 'sweep' && rule.cron && rule.recipient && rule.minBalance) {
        const parts = rule.cron.split(' ');
        if (parts.length >= 5) {
          const minute = parseInt(parts[0]);
          const hour = parseInt(parts[1]);
          const dom = parts[2]; const mon = parts[3]; const dow = parts[4];
          const now = new Date();
          const sched = new Date(now); sched.setSeconds(0, 0);
          if (!isNaN(hour)) sched.setHours(hour);
          if (!isNaN(minute)) sched.setMinutes(minute);
          if (dom !== '*') { sched.setDate(parseInt(dom)); if (sched > now) sched.setMonth(sched.getMonth() - 1); }
          if (dow !== '*') { const diff = (parseInt(dow) - sched.getDay() + 7) % 7; if (diff > 0) sched.setDate(sched.getDate() - 7 + diff); }
          if (sched <= now && (!rule.lastRunAt || new Date(rule.lastRunAt) < sched)) {
            const coinBal = session.balances[rule.coinSymbol || 'UCT'] || '0';
            const min = BigInt(rule.minBalance);
            const current = BigInt(coinBal || '0');
            if (current > min) {
              const excess = (current - min).toString();
              await executePayment(sphere, session, rule, coinId, rule.recipient!, excess, rule.coinSymbol || 'UCT');
            }
          }
        }
      }

      if (rule.type === 'threshold' && rule.minBalance) {
        const coinBal = session.balances[rule.coinSymbol || 'UCT'] || '0';
        const min = BigInt(rule.minBalance);
        const current = BigInt(coinBal || '0');
        if (current < min) {
          const ts = new Date().toISOString();
          session.transactions.push({
            id: crypto.randomUUID(),
            type: 'alert',
            amount: coinBal,
            status: 'alert',
            coinSymbol: rule.coinSymbol || 'UCT',
            timestamp: ts,
            detail: `${rule.coinSymbol || 'UCT'} balance ${coinBal} below threshold ${rule.minBalance}`,
          });
          session.executionLogs.push({
            id: crypto.randomUUID(),
            timestamp: ts,
            ruleName: rule.name,
            ruleType: rule.type,
            action: 'alert',
            amount: coinBal,
            coinSymbol: rule.coinSymbol || 'UCT',
            recipient: null,
            status: 'info',
            detail: `⚠️ ${fmtHuman(coinBal, rule.coinSymbol || 'UCT')} ${rule.coinSymbol || 'UCT'} below threshold`,
          });
          if (session.notificationPrefs?.onThreshold !== false) {
            await sendNotification(sphere, session, 'Threshold Alert', `${rule.name}: ${fmtHuman(coinBal, rule.coinSymbol || 'UCT')} ${rule.coinSymbol || 'UCT'} below min ${fmtHuman(rule.minBalance, rule.coinSymbol || 'UCT')}`);
          }
        }
      }
    }

    // ─── Atomic save: reload session to preserve any API-side changes ───
    // The agent loaded `session` at cycle start. The user may have created
    // rules via the dashboard in the meantime. Re-read the latest from disk,
    // forward-port the balance + cycle data, then write back.
    const fresh = loadSession(session.id);
    if (fresh) {
      fresh.balance = session.balance;
      fresh.balances = session.balances;
      fresh.lastChecked = session.lastChecked;
      fresh.lastReceivedAt = session.lastReceivedAt;
      fresh.executionLogs = session.executionLogs;
      // Merge agent-processed rule state (lastRunAt) into the fresh session
      // to preserve any new rules the user created via the API mid-cycle
      for (const ar of session.rules) {
        const fr = fresh.rules.find((r: any) => r.id === ar.id);
        if (fr) { fr.active = ar.active; fr.lastRunAt = ar.lastRunAt; }
        else fresh.rules.push(ar);
      }
      fresh.forwardedMessages = session.forwardedMessages;
      fresh.lastMsgCheckedAt = session.lastMsgCheckedAt;
      // Forward-port new incoming-tx entries (agent detected deposits)
      if (session.transactions.length > fresh.transactions.length) {
        const newTxs = session.transactions.slice(fresh.transactions.length);
        fresh.transactions.push(...newTxs);
      }
      saveSession(fresh);
    } else {
      saveSession(session);
    }

    // ─── Forward incoming DMs to the owner ───
    const prefs = session.notificationPrefs || DEFAULT_NOTIFICATION_PREFS;
    if (prefs.dmEnabled && prefs.dmRecipient && sphere && sphere.communications) {
      try {
        console.log(`[Agent] Checking DMs for ${session.id.slice(0, 8)}...`);
        const convs = sphere.communications.getConversations();
        if (!convs) {
          console.log('[Agent] No conversations (null)');
        } else if (typeof convs.forEach !== 'function') {
          console.log('[Agent] Conversations not a Map:', typeof convs);
        } else {
          let total = 0, forwarded = 0;
          const nowMs = Date.now();
          const lastChecked = (session.forwardedMessages?.length ? session.lastMsgCheckedAt : null) || (nowMs - 86400000);
          const alreadyForwarded = new Set((session.forwardedMessages || []).map(m => m.id));
          convs.forEach((msgs: any[], peer: string) => {
            total += msgs.length;
            for (const msg of msgs) {
              const ts = typeof msg.timestamp === 'number' ? msg.timestamp : 0;
              if (msg.senderNametag === session.nametag) continue;
              if (msg.id && alreadyForwarded.has(msg.id)) continue;
              // Forward any message newer than last check (read or unread)
              if (ts > lastChecked) {
                const sender = msg.senderNametag || msg.senderPubkey?.slice(0, 16) || peer.slice(0, 16);
                sphere!.communications.sendDM(prefs.dmRecipient, `📨 DM from ${sender}: ${msg.content}`).catch(() => {});
                if (!session.forwardedMessages) session.forwardedMessages = [];
                session.forwardedMessages.push({ id: msg.id || crypto.randomUUID(), from: sender, content: msg.content, timestamp: ts, read: false });
                if (msg.id) sphere!.communications.markAsRead([msg.id]).catch(() => {});
                forwarded++;
                console.log(`[Agent] Forwarded DM from ${sender} → ${prefs.dmRecipient}: "${msg.content.slice(0, 60)}"`);
              }
            }
          });
          session.lastMsgCheckedAt = nowMs;
          console.log(`[Agent] DM check: ${total} msgs, ${forwarded} forwarded`);
          const f2 = loadSession(session.id);
          if (f2) { f2.lastMsgCheckedAt = nowMs; f2.forwardedMessages = session.forwardedMessages; saveSession(f2); }
        }
      } catch (err: any) {
        console.warn(`[Agent] DM forwarding:`, err?.message || err);
      }
    }
  } finally {
    await sphere.destroy();
  }
}

/**
 * Find a session by its mnemonic/seed phrase.
 * Normalizes both sides (trim, collapse whitespace) before comparing.
 * Returns the session ID or null if not found.
 */
export function findSessionByMnemonic(mnemonic: string): string | null {
  const needle = mnemonic.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const id of listSessions()) {
    const s = loadSession(id);
    if (s && s.mnemonic) {
      const stored = s.mnemonic.trim().replace(/\s+/g, ' ').toLowerCase();
      if (stored === needle) return id;
    }
  }
  return null;
}

/**
 * Import a wallet from a seed phrase — creates a new session with the given mnemonic.
 * If a session with this mnemonic already exists, returns the existing session instead.
 */
export async function importWallet(mnemonic: string): Promise<UserSession | null> {
  const clean = mnemonic.trim().replace(/\s+/g, ' ');
  // Check if already imported
  const existing = findSessionByMnemonic(clean);
  if (existing) return loadSession(existing);

  // Create new session with this mnemonic
  const id = crypto.randomUUID();
  const dataDir = sessionPath(id);
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const base = createNodeProviders({
      network: env.UNICITY_NETWORK as any,
      oracle: { apiKey: env.UNICITY_API_KEY },
      dataDir,
      tokensDir: dataDir + '/tokens',
    });
    const providers = createWalletApiProviders(base, {
      baseUrl: 'https://wallet-api.unicity.network',
      network: env.UNICITY_NETWORK,
      deviceId: `treasury-agent-${id.slice(0, 8)}`,
    });
    const { sphere, created } = await Sphere.init({
      ...providers,
      network: env.UNICITY_NETWORK as any,
      mnemonic: clean,
      autoGenerate: false,
      swap: true,
      accounting: true,
    });
    const session: UserSession = {
      id,
      address: sphere.identity?.directAddress || '@' + id.slice(0, 8),
      directAddress: sphere.identity?.directAddress || '',
      mnemonic: clean,
      nametag: null,
      createdAt: new Date().toISOString(),
      balance: '0',
      balances: {},
      lastChecked: null,
      rules: [],
      transactions: [],
      notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
      executionLogs: [],
      lastReceivedAt: null,
      lastMsgCheckedAt: null,
      forwardedMessages: [],
    };
    // Read initial balances
    try {
      for (const sym of KNOWN_COINS) {
        const cid = getCoinIdBySymbol(sym);
        if (!cid) continue;
        const assets = sphere.payments.getBalance(cid);
        const coin = assets?.find((a: any) => a.coinId === cid);
        session.balances[sym] = coin?.totalAmount ?? '0';
      }
      session.balance = session.balances['UCT'] || '0';
    } catch { /* ok */ }
    saveSession(session);
    await sphere.destroy();
    console.log(`[Session] Imported wallet for session ${id} → ${session.address}`);
    return session;
  } catch (err) {
    console.error(`[Session] Failed to import wallet:`, err);
    return null;
  }
}

/**
 * Create a Sphere instance for sending payments directly (no wallet-api intents).
 * Bypasses wallet-api for environments where the intent system is unavailable.
 */
export async function openSessionWalletDirect(session: UserSession): Promise<Sphere | null> {
  try {
    const base = createNodeProviders({
      network: env.UNICITY_NETWORK as any,
      oracle: { apiKey: env.UNICITY_API_KEY },
      dataDir: sessionPath(session.id),
      tokensDir: sessionPath(session.id) + '/tokens',
    });
    const { sphere } = await Sphere.init({
      ...base,
      network: env.UNICITY_NETWORK as any,
      mnemonic: session.mnemonic || undefined,
      autoGenerate: false,
    });
    return sphere;
  } catch (err) {
    console.error(`[Session] Failed to open direct wallet for ${session.id}:`, err);
    return null;
  }
}

/**
 * Register a nametag for a user's wallet.
 * Checks availability, registers it, updates the session.
 * Returns the nametag or null on failure.
 */
export async function setUserNametag(session: UserSession, nametag: string): Promise<{ nametag: string; address: string } | null> {
  const clean = nametag.replace(/^@/, '').toLowerCase().trim();
  if (!clean) return null;

  const sphere = await openSessionWallet(session);
  if (!sphere) return null;

  try {
    // Check availability
    const available = await sphere.isNametagAvailable(clean);
    if (!available) {
      console.warn(`[Session] Nametag @${clean} is taken`);
      return null;
    }

    await sphere.registerNametag(clean);
    session.nametag = clean;
    session.address = `@${clean}`;
    saveSession(session);

    console.log(`[Session] Registered @${clean} for session ${session.id}`);
    return { nametag: clean, address: `@${clean}` };
  } catch (err: any) {
    console.error(`[Session] Failed to register @${clean}:`, err?.message);
    return null;
  } finally {
    await sphere.destroy();
  }
}
