import { config } from './config.js';
import {
  getNextInQueue,
  markQueueProcessing,
  markQueueCompleted,
  markQueueFailed,
  createAccount,
  logTransaction,
} from './db.js';

let isProcessing = false;

// Placeholder for NXT Layer CLI integration
// Replace this once your CLI is finalized
async function createNxtLayerAccount(agentId) {
  // TODO: Replace with actual NXT Layer CLI call
  // Example: exec(`nxtlayer accounts create --agent ${agentId}`)
  console.log(`[NXT] Creating account on NXT Layer for ${agentId}...`);

  // Simulated address - replace with actual CLI output
  const address = `nxt1${agentId.slice(2, 42).toLowerCase()}`;

  // Simulate CLI execution time
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`[NXT] Account created: ${address}`);
  return address;
}

// Send NXT Layer gas ($5 worth) — included with EVERY account
async function sendNxtLayerGas(nxtLayerAddress) {
  console.log(`[GAS] Sending $${config.nxtLayerGas} NXT Layer gas to ${nxtLayerAddress}...`);
  // TODO: Replace with actual NXT Layer token transfer
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log(`[GAS] NXT Layer gas sent`);
}

// Send multi-chain gas bundle (amount per chain varies by tier)
async function sendGasBundle(nxtLayerAddress, perChainAmount) {
  for (const chain of config.gasBundle.chains) {
    console.log(`[GAS] Sending $${perChainAmount} ${chain} gas to ${nxtLayerAddress}...`);
    // TODO: Replace with actual gas delivery per chain
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log(`[GAS] ${chain} gas sent`);
  }
  console.log(`[GAS] Full gas bundle delivered (${config.gasBundle.chains.length} chains)`);
}

export async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const next = await getNextInQueue();
    if (!next) {
      isProcessing = false;
      return;
    }

    console.log(`[QUEUE] Processing: ${next.agent_id} (${next.tier}) - position ${next.position}`);

    await markQueueProcessing(next.id);

    try {
      // ─── Gas Bundle Only (existing account) ───
      if (next.tier === 'gas_bundle') {
        // TODO: Look up existing account address for this agent
        console.log(`[QUEUE] Delivering gas bundle for ${next.agent_id}`);
        await sendGasBundle(next.agent_id);
        await markQueueCompleted(next.id);
        console.log(`[QUEUE] ✓ Gas bundle delivered for ${next.agent_id}`);
      }

      // ─── New Account (Regular or Premium) ───
      else {
        // 1. Create account on NXT Layer
        const nxtAddress = await createNxtLayerAccount(next.agent_id);

        // 2. Save account to Supabase
        const account = await createAccount(next.agent_id, next.tier, nxtAddress);

        // 3. Log the payment transaction
        await logTransaction(account.id, next.payment_tx, 'payment', next.amount, config.chain.safeAddress);

        // 4. Send NXT Layer gas (amount depends on tier)
        const nxtGasAmount = config.nxtLayerGas[next.tier];
        await sendNxtLayerGas(nxtAddress);
        await logTransaction(account.id, null, 'gas_bundle', nxtGasAmount, nxtAddress);

        // 5. If premium or vip, send multi-chain gas bundle too
        if (next.tier === 'premium' || next.tier === 'vip') {
          const perChainAmount = config.gasBundle.perChain[next.tier];
          await sendGasBundle(nxtAddress, perChainAmount);
          await logTransaction(account.id, null, 'gas_bundle', perChainAmount * config.gasBundle.chains.length, nxtAddress);
          console.log(`[QUEUE] ${next.tier.toUpperCase()} perks delivered for ${next.agent_id}`);
        }

        // 6. Mark as completed
        await markQueueCompleted(next.id);
        console.log(`[QUEUE] ✓ Completed: ${next.agent_id} → ${nxtAddress}`);
      }
    } catch (error) {
      console.error(`[QUEUE] ✗ Failed for ${next.agent_id}: ${error.message}`);
      await markQueueFailed(next.id, error.message);
    }

    // Cooldown before next item
    console.log(`[QUEUE] Cooldown: ${config.teller.queueCooldown / 1000}s before next...`);
    await new Promise((resolve) => setTimeout(resolve, config.teller.queueCooldown));
  } finally {
    isProcessing = false;
  }
}
