import { Sphere, type SphereEventType } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { env } from './config.js';
import { getBalance, sendDM, processRule, shouldExecuteRule } from './treasury.js';

let sphere: Sphere;
let lastCheck = Date.now();
const CHECK_INTERVAL = 60 * 60 * 1000; // Every hour

async function initAgent() {
  console.log('[Agent] Initializing treasury agent...');

  const base = createNodeProviders({
    network: env.UNICITY_NETWORK,
    oracle: { apiKey: env.UNICITY_API_KEY },
  });

  const providers = createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network',
    network: env.UNICITY_NETWORK,
    deviceId: 'treasury-agent',
  });

  const { sphere: s, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    network: env.UNICITY_NETWORK,
    mnemonic: env.AGENT_MNEMONIC || undefined,
    nametag: env.AGENT_NAMETAG,
    autoGenerate: true,
    swap: true,
    accounting: true,
  });

  sphere = s;

  if (created) {
    console.log('\n=== NEW TREASURY AGENT CREATED ===');
    console.log(`Nametag: @${env.AGENT_NAMETAG}`);
    console.log(`Address: ${sphere.identity?.directAddress}`);
    console.log('Mnemonic (SAVE THIS!):', generatedMnemonic);
    console.log('=====================================\n');
  } else {
    console.log(`[Agent] Loaded existing wallet @${sphere.identity?.nametag}`);
  }

  // Listen for incoming payments
  sphere.on('transfer:incoming' as SphereEventType, (transfer: any) => {
    console.log('[Agent] Incoming transfer!', JSON.stringify(transfer, null, 2));
    if (env.USER_NAMETAG) {
      sendDM(sphere, env.USER_NAMETAG, `📥 Received ${transfer.amount} UCT`);
    }
  });

  // Log the agent identity
  console.log('[Agent] Identity:', {
    directAddress: sphere.identity?.directAddress,
    nametag: sphere.identity?.nametag,
  });

  console.log('[Agent] Ready. Checking treasury every hour...\n');
  await checkTreasury();
}

async function checkTreasury() {
  try {
    const balance = await getBalance(sphere);
    console.log(`[Agent] Treasury balance: ${balance} UCT`);

    // For now, just log the balance and send a daily health check via DM
    if (env.USER_NAMETAG) {
      const now = new Date();
      if (now.getHours() === 8 && now.getMinutes() === 0) {
        // Daily 8am report
        await sendDM(sphere, env.USER_NAMETAG,
          `📊 **Treasury Report**\n` +
          `Balance: ${balance} UCT\n` +
          `Status: Active ✅\n` +
          `Next check: ${new Date(now.getTime() + CHECK_INTERVAL).toLocaleString()}`
        );
      }
    }

  } catch (err) {
    console.error('[Agent] Treasury check failed:', err);
  }

  lastCheck = Date.now();
}

async function run() {
  await initAgent();

  // Main loop
  setInterval(async () => {
    await checkTreasury();
  }, CHECK_INTERVAL);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Agent] Shutting down...');
    await sphere.destroy();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Agent] Shutting down...');
    await sphere.destroy();
    process.exit(0);
  });

  // Keep alive
  console.log('[Agent] Press Ctrl+C to stop');
}

run().catch((err) => {
  console.error('[Agent] Fatal error:', err);
  process.exit(1);
});
