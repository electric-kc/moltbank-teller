import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

let supabase;

export function initSupabase() {
  supabase = createClient(config.supabase.url, config.supabase.serviceKey);
  console.log('[DB] Supabase connected');
  return supabase;
}

// ─── Queue Operations ───

export async function addToQueue(paymentTx, agentId, tier, amount, referralCode = null) {
  // Get current max position
  const { data: last } = await supabase
    .from('queue')
    .select('position')
    .order('position', { ascending: false })
    .limit(1)
    .single();

  const position = (last?.position || 0) + 1;

  // Premium jumps ahead of regular, VIP jumps ahead of everything
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
    // Premium goes ahead of regular, but behind VIPs
    const { data: firstRegular } = await supabase
      .from('queue')
      .select('position')
      .eq('status', 'pending')
      .eq('tier', 'regular')
      .order('position', { ascending: true })
      .limit(1)
      .single();

    if (firstRegular) {
      await supabase.rpc('bump_queue_positions', { from_pos: firstRegular.position });
      finalPosition = firstRegular.position;
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

  if (error) throw new Error(`[DB] Failed to add to queue: ${error.message}`);
  console.log(`[QUEUE] Added ${agentId} at position ${finalPosition} (${tier})`);
  return data;
}

export async function getNextInQueue() {
  const { data, error } = await supabase
    .from('queue')
    .select('*')
    .eq('status', 'pending')
    .order('position', { ascending: true })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`[DB] Queue read error: ${error.message}`);
  }
  return data || null;
}

export async function markQueueProcessing(id) {
  const { error } = await supabase
    .from('queue')
    .update({ status: 'processing' })
    .eq('id', id);

  if (error) throw new Error(`[DB] Failed to update queue: ${error.message}`);
}

export async function markQueueCompleted(id) {
  const { error } = await supabase
    .from('queue')
    .update({ status: 'completed', processed_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`[DB] Failed to complete queue: ${error.message}`);
}

export async function markQueueFailed(id, reason) {
  const { error } = await supabase
    .from('queue')
    .update({ status: 'failed' })
    .eq('id', id);

  if (error) console.error(`[DB] Failed to mark queue failed: ${error.message}`);
}

export async function getQueueStats() {
  const { data: pending } = await supabase
    .from('queue')
    .select('id', { count: 'exact' })
    .eq('status', 'pending');

  const { data: completed } = await supabase
    .from('queue')
    .select('id', { count: 'exact' })
    .eq('status', 'completed');

  return {
    pending: pending?.length || 0,
    completed: completed?.length || 0,
  };
}

// ─── Account Operations ───

export async function createAccount(agentId, tier, nxtLayerAddress, referralCode = null) {
  const isPremiumOrVip = tier === 'premium' || tier === 'vip';

  // Generate unique referral code: first 8 chars of agent + random 4
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
      last_active: new Date().toISOString(),
      referral_code: myReferralCode,
      referred_by: referredBy,
    })
    .select()
    .single();

  if (error) throw new Error(`[DB] Failed to create account: ${error.message}`);
  console.log(`[ACCOUNT] Created ${tier} account for ${agentId} → ${nxtLayerAddress} (ref: ${myReferralCode})`);

  // Process referral reward if referred
  if (referredBy) {
    await processReferralReward(referredBy, agentId, tier);
  }

  return data;
}

// ─── Transaction Logging ───

export async function logTransaction(accountId, paymentTx, type, amount, destination) {
  const { error } = await supabase
    .from('transactions')
    .insert({
      account_id: accountId,
      payment_tx: paymentTx,
      type,
      amount,
      destination,
      status: 'completed',
    });

  if (error) console.error(`[DB] Failed to log transaction: ${error.message}`);
}

// ─── Health Heartbeat ───

export async function updateHeartbeat(status, errorMessage = null) {
  const { data: existing } = await supabase
    .from('agent_health')
    .select('id')
    .eq('agent_name', config.teller.agentName)
    .single();

  const payload = {
    agent_name: config.teller.agentName,
    agent_role: 'teller',
    status,
    last_heartbeat: new Date().toISOString(),
    error_message: errorMessage,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    await supabase.from('agent_health').update(payload).eq('id', existing.id);
  } else {
    await supabase.from('agent_health').insert(payload);
  }
}

// ─── Payment Tracking (to avoid processing same tx twice) ───

export async function isPaymentProcessed(txHash) {
  const { data } = await supabase
    .from('queue')
    .select('id')
    .eq('payment_tx', txHash)
    .limit(1)
    .single();

  return !!data;
}

// ─── Points / Leaderboard ───

export async function awardPoints(agentId, amount, reason) {
  // Log the points event
  const { error: pointsError } = await supabase
    .from('points')
    .insert({ agent_id: agentId, amount, reason });

  if (pointsError) {
    console.error(`[POINTS] Failed to log points: ${pointsError.message}`);
    return;
  }

  // Upsert leaderboard
  const { data: existing } = await supabase
    .from('leaderboard')
    .select('total_points, tier')
    .eq('agent_id', agentId)
    .single();

  if (existing) {
    await supabase
      .from('leaderboard')
      .update({
        total_points: existing.total_points + amount,
        updated_at: new Date().toISOString(),
      })
      .eq('agent_id', agentId);
  } else {
    await supabase
      .from('leaderboard')
      .insert({
        agent_id: agentId,
        total_points: amount,
        updated_at: new Date().toISOString(),
      });
  }

  console.log(`[POINTS] +${amount} MBPs → ${agentId} (${reason})`);
}

// ─── Referral System ───

export async function validateReferral(newAgentId, referralCode) {
  // Look up referrer by code
  const { data: referrer } = await supabase
    .from('accounts')
    .select('agent_id, referral_count, referral_cap, tier')
    .eq('referral_code', referralCode)
    .single();

  if (!referrer) {
    console.log(`[REFERRAL] Invalid code: ${referralCode}`);
    return null;
  }

  // Block self-referral
  if (referrer.agent_id.toLowerCase() === newAgentId.toLowerCase()) {
    console.log(`[REFERRAL] Blocked self-referral for ${newAgentId}`);
    return null;
  }

  // Check cap
  if (referrer.referral_count >= referrer.referral_cap) {
    console.log(`[REFERRAL] ${referrer.agent_id} hit referral cap (${referrer.referral_cap})`);
    return null;
  }

  return referrer;
}

export async function processReferralReward(referrerId, referredId, referredTier) {
  const usdcAmount = config.tiers[referredTier].amount * config.referral.usdcPercent;
  const pointsAmount = config.referral.points[referredTier];

  // Log the referral payout (USDC pending, points immediate)
  const { error: payoutError } = await supabase
    .from('referral_payouts')
    .insert({
      referrer_id: referrerId,
      referred_id: referredId,
      referred_tier: referredTier,
      usdc_amount: usdcAmount,
      points_amount: pointsAmount,
      points_paid: true,
      usdc_paid: false,
    });

  if (payoutError) {
    console.error(`[REFERRAL] Failed to log payout: ${payoutError.message}`);
    return;
  }

  // Award points immediately
  await awardPoints(referrerId, pointsAmount, `referral_${referredTier}`);

  // Increment referral count
  await supabase
    .from('accounts')
    .update({ referral_count: supabase.rpc ? undefined : undefined })
    .eq('agent_id', referrerId);

  // Use raw SQL increment instead
  await supabase.rpc('increment_referral_count', { agent: referrerId });

  console.log(`[REFERRAL] ${referrerId} earned ${pointsAmount} MBPs + $${usdcAmount} USDC (pending) for referring ${referredId} (${referredTier})`);
}
