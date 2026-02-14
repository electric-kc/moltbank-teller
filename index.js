import { config, validateConfig } from './config.js';
import { initSupabase, updateHeartbeat, getQueueStats } from './db.js';
import { initPaymentWatcher, checkForPayments } from './watcher.js';
import { processQueue } from './queue.js';
import { startServer } from './server.js';

console.log('╔══════════════════════════════════════╗');
console.log('║       MOLTBANK TELLER AGENT          ║');
console.log('║       Powered by NXT Layer           ║');
console.log('╚══════════════════════════════════════╝');
console.log('');

// ─── Startup ───

try {
  validateConfig();
  console.log('[BOOT] Config validated');
} catch (error) {
  console.error(`[BOOT] ${error.message}`);
  process.exit(1);
}

initSupabase();
initPaymentWatcher();

// Register as online
await updateHeartbeat('online');
console.log('[BOOT] Teller online and reporting health');
console.log(`[BOOT] Poll interval: ${config.teller.pollInterval / 1000}s`);
console.log(`[BOOT] Queue cooldown: ${config.teller.queueCooldown / 1000}s`);
console.log('');

// ─── Main Loop ───

async function tellerLoop() {
  while (true) {
    try {
      // 1. Check for new payments
      await checkForPayments();

      // 2. Process queue
      await processQueue();

      // 3. Heartbeat
      await updateHeartbeat('online');
    } catch (error) {
      console.error(`[TELLER] Loop error: ${error.message}`);
      await updateHeartbeat('error', error.message);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, config.teller.pollInterval));
  }
}

// ─── Stats Logger (every 5 minutes) ───

async function statsLoop() {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 300000));
    try {
      const stats = await getQueueStats();
      console.log(`[STATS] Queue: ${stats.pending} pending | ${stats.completed} completed`);
    } catch (error) {
      console.error(`[STATS] Error: ${error.message}`);
    }
  }
}

// ─── Graceful Shutdown ───

process.on('SIGINT', async () => {
  console.log('\n[TELLER] Shutting down...');
  await updateHeartbeat('offline');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[TELLER] Terminated');
  await updateHeartbeat('offline');
  process.exit(0);
});

// ─── Start ───

console.log('[TELLER] Starting main loop...');
console.log('');

startServer();
tellerLoop();
statsLoop();
