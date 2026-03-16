import { ethers } from 'ethers';
import { config } from './config.js';
import { isPaymentProcessed, addToQueue, logTransaction, getVipCount, handleReferral } from './db.js';

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

      // Determine tier based on amount (check highest first)
      let tier = null;
      if (amount >= config.tiers.vip.amount) {
        tier = 'vip';
      } else if (amount >= config.tiers.premium.amount) {
        tier = 'premium';
      } else if (amount >= config.tiers.regular.amount) {
        tier = 'regular';
      } else {
        console.log(`[WATCHER] Ignoring small payment: ${amount} USDC from ${sender}`);
        continue;
      }

      // VIP hard cap check — reject if above buffer ceiling
      if (tier === 'vip') {
        const vipCount = await getVipCount();
        if (vipCount >= config.tierCaps.vip.hardCap) {
          console.log(`[WATCHER] VIP HARD CAP REACHED (${vipCount}/${config.tierCaps.vip.hardCap}). Rejecting VIP payment from ${sender}. REFUND NEEDED.`);
          await logTransaction(txHash, sender, amount, 'vip_rejected', 'VIP hard cap exceeded — refund required');
          continue;
        }
        if (vipCount >= config.tierCaps.vip.displayCap) {
          console.log(`[WATCHER] VIP in BUFFER ZONE (${vipCount}/${config.tierCaps.vip.hardCap}). Accepting from ${sender}.`);
        }
      }

      console.log(`[WATCHER] New payment detected: ${amount} USDC from ${sender} (${tier})`);

      // Check if this tx was pre-registered via the server endpoint
      // (agent called /account/open first, got 402, then paid — referral code was stored)
      // The queue entry from server.js will have the referral_code already set
      // We look it up here so watcher-detected payments also get referral credit
      let referralCode = null;
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(config.supabase.url, config.supabase.serviceKey);
        const { data: preQueued } = await supabase
          .from('queue')
          .select('referral_code')
          .eq('payment_tx', txHash)
          .maybeSingle();
        referralCode = preQueued?.referral_code || null;
        if (referralCode) {
          console.log(`[WATCHER] Found pre-registered referral code: ${referralCode}`);
        }
      } catch (e) {
        console.error('[WATCHER] Error looking up pre-queued referral code:', e.message);
      }

      // Add to queue
      const queueEntry = await addToQueue(txHash, sender, tier, amount, referralCode);

      // Log the transaction
      await logTransaction(txHash, sender, amount, tier, 'confirmed');

      // Handle referral payout — non-blocking, won't fail the payment
      if (referralCode) {
        try {
          await handleReferral(referralCode, sender, tier, amount);
        } catch (e) {
          console.error('[WATCHER] Referral handling error (non-fatal):', e.message);
        }
      }

      newPayments.push({
        txHash,
        sender,
        amount,
        tier,
        referralCode,
        queueEntry,
      });
    }

    if (newPayments.length > 0) {
      console.log(`[WATCHER] Found ${newPayments.length} new payment(s)`);
    }

    return newPayments;
  } catch (err) {
    console.error('[WATCHER] Error checking payments:', err.message);
    return [];
  }
}
