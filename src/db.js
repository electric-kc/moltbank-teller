import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// --- VIP Cap ---

export async function getVipCount() {
  const { count, error } = await supabase
    .from('accounts')
    .select('*', { count: 'exact', head: true })
    .eq('tier', 'vip');

  if (error) {
    console.error('[DB] Error getting VIP count:', error.message);
    return 0;
  }
  return count || 0;
}

// --- Queue ---

export async function isPaymentProcessed(txHash) {
  const { data } = await supabase
    .from('queue')
    .select('id')
    .eq('payment_tx', txHash)
    .single();
  return !!data;
}

export async function addToQueue(paymentTx, agentId, tier, amount, referralCode = null) {
  // Get current max position
  const { data: maxPos } = await supabase
    .from('queue')
    .select('position')
    .order('position', { ascending: false })
    .limit(1)
    .single();

  let position = (maxPos?.position || 0) + 1;

  // Premium jumps ahead of regular and limited, VIP jumps ahead of everything
  let finalPosition = position;
  if (tier === 'vip') {
    // VIP goes to absolute front — only behind other VIPs
    const { data: firstNonVip } = await supabase
      .from('queue')
      .select('position')
      .eq('status', 'pending')
      .neq('tier', 'vip')
      .order('position', { ascending: true })
      .limit(1)
      .single();

    if (firstNonVip) {
      await supabase.rpc('bump_queue_positions', { from_pos: firstNonVip.position });
      finalPosition = firstNonVip.position;
    }
  } else if (tier === 'premium') {
    // Premium goes ahead of regular and limited, but behind VIPs
    const { data: firstRegularOrLimited } = await supabase
      .from('queue')
      .select('position')
      .eq('status', 'pending')
      .in('tier', ['regular', 'limited'])
      .order('position', { ascending: true })
      .limit(1)
      .single();

    if (firstRegularOrLimited) {
      await supabase.rpc('bump_queue_positions', { from_pos: firstRegularOrLimited.position });
      finalPosition = firstRegularOrLimited.position;
    }
  }

  const { data, error } = await supabase
    .from('queue')
    .insert({
      payment_tx: paymentTx,
      agent_id: agentId,
      tier,
      amount,
      position: finalPosition,
      status: 'pending',
      referral_code: referralCode,
    })
    .select()
    .single();

  if (error) {
    console.error('[DB] Queue insert error:', error.message);
    return null;
  }

  console.log(`[QUEUE] Added ${agentId} as ${tier} at position ${finalPosition}`);
  return data;
}

// --- Accounts ---

export async function createAccount(agentId, tier, nxtLayerAddress, referralCode = null) {
  const isPremiumOrVip = tier === 'premium' || tier === 'vip';

  // Generate unique referral code
  const myReferralCode = `${agentId.slice(2, 10).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  // Validate referral code if provided
  let referredBy = null;
  if (referralCode) {
    const referrer = await validateReferral(agentId, referralCode);
    if (referrer) {
      referredBy = referrer.agent_id;
    }
  }

  const { data, error } = await supabase
    .from('accounts')
    .insert({
      agent_id: agentId,
      tier,
      nxt_layer_address: nxtLayerAddress,
      nft_entitled: isPremiumOrVip,
      gas_bundle_sent: isPremiumOrVip,
      referral_code: myReferralCode,
      referred_by: referredBy,
      last_active: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error('[DB] Account create error:', error.message);
    return null;
  }

  // Award points
  await awardPoints(agentId, config.points[tier], `${tier}_account_opened`);

  // Process referral if applicable
  if (referredBy) {
    await processReferral(referredBy, agentId, tier);
  }

  console.log(`[ACCOUNT] Created ${tier} account for ${agentId} (referral: ${myReferralCode})`);
  return data;
}

// --- Transactions ---

export async function logTransaction(txHash, sender, amount, tier, status) {
  const { error } = await supabase
    .from('transactions')
    .insert({
      tx_hash: txHash,
      sender,
      amount,
      tier,
      status,
      created_at: new Date().toISOString(),
    });

  if (error) {
    console.error('[DB] Transaction log error:', error.message);
  }
}

// --- Points ---

export async function awardPoints(agentId, amount, reason) {
  // Add to points history
  await supabase.from('points_history').insert({
    agent_id: agentId,
    amount,
    reason,
    created_at: new Date().toISOString(),
  });

  // Update leaderboard
  const { data: existing } = await supabase
    .from('leaderboard')
    .select('total_points')
    .eq('agent_id', agentId)
    .single();

  if (existing) {
    await supabase
      .from('leaderboard')
      .update({ total_points: existing.total_points + amount })
      .eq('agent_id', agentId);
  } else {
    await supabase.from('leaderboard').insert({
      agent_id: agentId,
      total_points: amount,
    });
  }

  console.log(`[POINTS] +${amount} MBPs → ${agentId} (${reason})`);
}

// --- Referrals ---

export async function validateReferral(newAgentId, referralCode) {
  const { data: referrer } = await supabase
    .from('accounts')
    .select('agent_id, referral_count')
    .eq('referral_code', referralCode)
    .single();

  if (!referrer) {
    console.log(`[REFERRAL] Invalid code: ${referralCode}`);
    return null;
  }

  if (referrer.agent_id === newAgentId) {
    console.log(`[REFERRAL] Self-referral blocked: ${newAgentId}`);
    return null;
  }

  if (referrer.referral_count >= config.referral.maxPerAccount) {
    console.log(`[REFERRAL] Max referrals reached for ${referrer.agent_id}`);
    return null;
  }

  return referrer;
}

export async function processReferral(referrerId, referredId, referredTier) {
  const usdcAmount = config.tiers[referredTier].amount * config.referral.usdcPercent;
  const pointsAmount = config.referral.points[referredTier];

  // Award points to referrer
  await awardPoints(referrerId, pointsAmount, `referral_${referredTier}`);

  // Queue USDC payout (Cashier will process)
  await supabase.from('referral_payouts').insert({
    referrer_id: referrerId,
    referred_id: referredId,
    referred_tier: referredTier,
    usdc_amount: usdcAmount,
    points_amount: pointsAmount,
    status: 'pending',
    created_at: new Date().toISOString(),
  });

  // Increment referral count
  await supabase.rpc('increment_referral_count', { agent: referrerId });

  console.log(`[REFERRAL] ${referrerId} earned ${pointsAmount} MBPs + $${usdcAmount} USDC (pending) for referring ${referredId} (${referredTier})`);
}

export async function isAccountExists(agentId) {
  const { data } = await supabase
    .from('accounts')
    .select('id')
    .eq('agent_id', agentId)
    .single();
  return !!data;
}
