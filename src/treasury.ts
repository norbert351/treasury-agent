import { Sphere } from '@unicitylabs/sphere-sdk';
import type { Rule } from '../db/schema.js';

export interface TreasuryState {
  balance: string;
  totalSent: string;
  totalReceived: string;
  lastChecked: Date;
}

export async function getBalance(sphere: Sphere): Promise<string> {
  try {
    const balances = sphere.payments.getBalance('UCT_COIN_ID_HEX');
    const uct = balances?.find((b: any) => b.coinId === 'UCT_COIN_ID_HEX');
    return uct?.available ?? '0';
  } catch (err) {
    console.error('[Treasury] getBalance error:', err);
    return '0';
  }
}

export async function sendPayment(
  sphere: Sphere,
  recipient: string,
  amount: string,
  description: string,
): Promise<{ id: string; status: string } | null> {
  try {
    const result = await sphere.payments.send({
      coinId: 'UCT',
      amount,
      recipient,
      description,
    });
    console.log(`[Treasury] Sent ${amount} UCT to ${recipient}: ${result.id} (${result.status})`);
    return { id: result.id, status: result.status };
  } catch (err: any) {
    console.error(`[Treasury] Send payment failed to ${recipient}:`, err?.message || err);
    return null;
  }
}

export async function sendDM(
  sphere: Sphere,
  recipient: string,
  message: string,
): Promise<void> {
  try {
    await sphere.communications.dm(recipient, message);
    console.log(`[Treasury] DM sent to ${recipient}`);
  } catch (err: any) {
    console.error(`[Treasury] DM failed to ${recipient}:`, err?.message || err);
  }
}

export function shouldExecuteRule(rule: Rule): boolean {
  if (rule.active !== 'true') return false;

  if (rule.type === 'recurring' && rule.cron) {
    const parts = rule.cron.split(' ');
    if (parts.length < 5) return false;

    const minute = parseInt(parts[0]);
    const hour = parseInt(parts[1]);
    const now = new Date();

    // Simple cron check: match hour and minute
    if (now.getMinutes() === minute && now.getHours() === hour) {
      // Only execute once per hour (check lastRunAt)
      if (rule.lastRunAt) {
        const lastRun = new Date(rule.lastRunAt);
        if (now.getHours() === lastRun.getHours() && now.getMinutes() === lastRun.getMinutes()) {
          return false; // Already ran this minute
        }
      }
      return true;
    }
  }

  return false;
}

export async function processRule(
  sphere: Sphere,
  rule: Rule,
  balance: string,
): Promise<string | null> {
  switch (rule.type) {
    case 'recurring': {
      if (!rule.recipient || !rule.amount) return 'Recurring rule missing recipient or amount';
      const result = await sendPayment(sphere, rule.recipient, rule.amount, `Recurring: ${rule.name}`);
      return result ? `Sent ${rule.amount} UCT to ${rule.recipient}` : 'Payment failed';
    }

    case 'threshold': {
      if (!rule.minBalance) return 'Threshold rule missing minBalance';
      const min = BigInt(rule.minBalance);
      const current = BigInt(balance || '0');
      if (current < min) {
        return `Balance ${balance} below threshold ${rule.minBalance} — alert sent`;
      }
      return null; // No alert needed
    }

    default:
      return `Unknown rule type: ${rule.type}`;
  }
}
