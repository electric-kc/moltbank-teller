import { startServer } from './server.js';
import { initPaymentWatcher, checkForPayments } from './watcher.js';
import { writeHeartbeat } from './db.js';
import { config } from './config.js';

console.log('=================================');
console.log('  MOLTBANK TELLER v3.0');
console.log('  Standard | Premium | VIP');
console.log('=================================');

// Start HTTP server
startServer();

// Initialize payment watcher
initPaymentWatcher();

// Poll for payments
setInterval(async () => {
  await checkForPayments();
}, config.queue.cooldown);

// Heartbeat every 5 minutes
setInterval(async () => {
  await writeHeartbeat();
}, 5 * 60 * 1000);

// Write immediately on boot
writeHeartbeat();

console.log(`[TELLER] Payment watcher polling every ${config.queue.cooldown / 1000}s`);
console.log(`[TELLER] Heartbeat every 5 minutes`);
