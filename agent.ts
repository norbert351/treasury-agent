import { listSessions, loadSession, processSessionRules } from './session-manager.js';

const CHECK_INTERVAL = 10 * 60 * 1000; // Every 10 minutes

async function tick() {
  const ids = listSessions();
  if (ids.length === 0) {
    console.log('[Agent] No user sessions yet. Waiting...');
    return;
  }

  console.log(`[Agent] Checking ${ids.length} user session(s)...`);
  for (const id of ids) {
    try {
      const session = loadSession(id);
      if (!session) {
        console.warn(`[Agent] Session ${id} missing data, skipping`);
        continue;
      }
      await processSessionRules(session);
      console.log(`[Agent] Session ${id}: balance=${session.balance}, rules=${session.rules.length}`);
    } catch (err) {
      console.error(`[Agent] Error processing session ${id}:`, err);
    }
  }
  console.log(`[Agent] Cycle complete. Next check in 10 minutes.`);
}

async function run() {
  console.log('[Agent] Multi-user treasury agent starting...');
  console.log(`[Agent] Checking every ${CHECK_INTERVAL / 1000 / 60} minutes`);
  await tick();
  setInterval(tick, CHECK_INTERVAL);
}

run().catch((err) => {
  console.error('[Agent] Fatal:', err);
  process.exit(1);
});
