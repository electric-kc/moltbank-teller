import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// --- Heartbeat ---
export async function writeHeartbeat() {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('agent_health')
    .upsert({
      agent_name: 'moltbank-teller',
      agent_role: 'teller',
      status: 'online',
      last_heartbeat: now,
      updated_at: now,
    }, { onConflict: 'agent_name' });
  if (error) console.error('[DB] Heartbeat error:', error.message);
  else console.log('[TELLER] Heartbeat written');
}

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
  let finalPosition = position;

  // VIP goes to absolute front — only behind other VIPs
  if (tier === 'vip') {
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
  }

  // Premium jumps ahead of regular
  if (tier === 'premium') {
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

  if (error) {
    console.error('[DB] Error adding to queue:', error.message);
    return null;
  }

  console.log(`[QUEUE] Added ${agentId} at position ${finalPosition} (${tier})`);
  return data;
}

export async function logTransaction(txHash, agentId, amount, type, status) {
  const { error } = await supabase
    .from('transactions')
    .insert({
      payment_tx: txHash,
      agent_id: agentId,
      amount,
      type,
      status,
    });
  if (error) console.error('[DB] Error logging transaction:', error.message);
}

// --- Referral Handling ---
export async function handleReferral(referralCode, agentId, tier, amount) {
  if (!referralCode) return;

  // Step 1 — check if it's an ambassador code
  const { data: inviteRequest } = await supabase
    .from('invite_requests')
    .select('id, x_username, invite_code')
    .eq('invite_code', referralCode)
    .single();

  if (inviteRequest) {
    // It's an ambassador referral — look up their ambassador record
    const { data: ambassador } = await supabase
      .from('ambassadors')
      .select('id, x_handle')
      .eq('invited_with_code', referralCode)
      .single();

    if (ambassador) {
      const usdcAmount = parseFloat((amount * 0.15).toFixed(6)); // 15% ambassador rate

      const { error } = await supabase
        .from('ambassador_payouts')
        .insert({
          ambassador_id: ambassador.id,
          referred_agent_id: agentId,
          tier,
          usdc_amount: usdcAmount,
          usdc_paid: false,
        });

      if (error) {
        console.error('[DB] Error writing ambassador payout:', error.message);
      } else {
        console.log(`[REFERRAL] Ambassador payout queued for @${ambassador.x_handle}: ${usdcAmount} USDC (15%)`);
      }
    } else {
      console.log(`[REFERRAL] Ambassador invite code found but no ambassador record for: ${referralCode}`);
    }
    return;
  }

  // Step 2 — check if it's an agent referral code
  const { data: referrerAccount } = await supabase
    .from('accounts')
    .select('id, agent_id, referral_count, referral_cap')
    .eq('referral_code', referralCode)
    .single();

  if (referrerAccount) {
    // Check referral cap (null = unlimited for ambassadors, numeric for agents)
    const cap = referrerAccount.referral_cap;
    const count = referrerAccount.referral_count || 0;

    if (cap !== null && count >= cap) {
      console.log(`[REFERRAL] Agent ${referrerAccount.agent_id} has hit referral cap (${count}/${cap}). Skipping.`);
      return;
    }

    const usdcAmount = parseFloat((amount * 0.10).toFixed(6)); // 10% agent rate

    const { error: payoutError } = await supabase
      .from('referral_payouts')
      .insert({
        referrer_id: referrerAccount.id,
        referred_agent_id: agentId,
        tier,
        usdc_amount: usdcAmount,
        usdc_paid: false,
        processed_by_cashier: false,
      });

    if (payoutError) {
      console.error('[DB] Error writing agent referral payout:', payoutError.message);
      return;
    }

    // Increment referral count on referrer account
    const { error: countError } = await supabase
      .from('accounts')
      .update({ referral_count: count + 1 })
      .eq('id', referrerAccount.id);

    if (countError) {
      console.error('[DB] Error incrementing referral count:', countError.message);
    } else {
      console.log(`[REFERRAL] Agent payout queued for ${referrerAccount.agent_id}: ${usdcAmount} USDC (10%)`);
    }
    return;
  }

  // Code not found in either table
  console.log(`[REFERRAL] Code not found in ambassadors or accounts: ${referralCode}`);
}
