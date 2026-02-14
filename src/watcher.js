import { ethers } from 'ethers';
import { config } from './config.js';
import { isPaymentProcessed, addToQueue, logTransaction } from './db.js';

// Minimal ERC20 ABI - just the Transfer event
const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

let provider;
let usdcContract;
let lastCheckedBlock;

export function initPaymentWatcher() {
  provider = new ethers.JsonRpcProvider(config.chain.rpcUrl);
  usdcContract = new ethers.Contract(config.chain.usdcContract, ERC20_ABI, provider);
  console.log('[WATCHER] Initialized');
  console.log(`[WATCHER] Monitoring Safe: ${config.chain.safeAddress}`);
  console.log(`[WATCHER] USDC Contract: ${config.chain.usdcContract}`);
}

export async function checkForPayments() {
  try {
    const currentBlock = await provider.getBlockNumber();

    // On first run, only look back ~50 blocks (~2 minutes on BASE)
    if (!lastCheckedBlock) {
      lastCheckedBlock = currentBlock - 50;
    }

    // Don't re-check same blocks
    if (currentBlock <= lastCheckedBlock) return [];

    // Query Transfer events TO our Safe address
    const filter = usdcContract.filters.Transfer(null, config.chain.safeAddress);
    const events = await usdcContract.queryFilter(filter, lastCheckedBlock + 1, currentBlock);

    lastCheckedBlock = currentBlock;

    const newPayments = [];

    for (const event of events) {
      const txHash = event.transactionHash;

      // Skip if already processed
      const alreadyProcessed = await isPaymentProcessed(txHash);
      if (alreadyProcessed) continue;

      // USDC has 6 decimals on BASE
      const amount = parseFloat(ethers.formatUnits(event.args.value, 6));
      const sender = event.args.from;

      // Determine tier based on amount
      let tier = null;
      if (amount >= config.tiers.premium.amount) {
        tier = 'premium';
      } else if (amount >= config.tiers.regular.amount) {
        tier = 'regular';
      } else {
        console.log(`[WATCHER] Ignoring small payment: ${amount} USDC from ${sender}`);
        continue;
      }

      console.log(`[WATCHER] New payment detected: ${amount} USDC from ${sender} (${tier})`);

      // Add to queue - using sender address as agent_id for now
      // In production, the agent would provide its ID in the x402 flow
      const queueEntry = await addToQueue(txHash, sender, tier, amount);

      newPayments.push({
        txHash,
        sender,
        amount,
        tier,
        queueEntry,
      });
    }

    if (newPayments.length > 0) {
      console.log(`[WATCHER] Found ${newPayments.length} new payment(s)`);
    }

    return newPayments;
  } catch (error) {
    console.error(`[WATCHER] Error checking payments: ${error.message}`);
    return [];
  }
}
