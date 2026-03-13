import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// --- Heartbeat ---
export async function writeHeartbeat() {
  const { error } = await supabase
    .from('agent_health')
    .upsert({
      agent_name: 'moltbank-teller',
      status: 'online',
      last_heartbeat: new Date().toISOString(),
    }, { onConflict: 'agent_name' });
  if (error) console.error('[DB] Heartbeat error:', error.message);
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

  // VIP goes to absolute front — only behind other VIPs
  let finalPosition = position;
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
