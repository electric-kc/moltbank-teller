import { startServer } from './server.js';
import { initPaymentWatcher, checkForPayments } from './watcher.js';
import { config } from './config.js';

console.log('=================================');
console.log('  MOLTBANK TELLER v2.0');
console.log('  Limited | Standard | Premium | VIP');
console.log('=================================');

// Start HTTP server
startServer();

// Initialize payment watcher
initPaymentWatcher();

// Poll for payments
setInterval(async () => {
  await checkForPayments();
}, config.queue.cooldown);

console.log(`[TELLER] Payment watcher polling every ${config.queue.cooldown / 1000}s`);
