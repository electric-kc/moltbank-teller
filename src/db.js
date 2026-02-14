import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

let supabase;

export function initSupabase() {
  supabase = createClient(config.supabase.url, config.supabase.serviceKey);
  console.log('[DB] Supabase connected');
  return supabase;
}

// ─── Queue Operations ───

export async function addToQueue(paymentTx, agentId, tier, amount) {
  // Get current max position
  const { data: last } = await supabase
    .from('queue')
    .select('position')
    .order('position', { ascending: false })
    .limit(1)
    .single();

  const position = (last?.position || 0) + 1;

  // Premium jumps to front: find lowest pending position and go before it
  let finalPosition = position;
  if (tier === 'premium') {
    const { data: firstPending } = await supabase
      .from('queue')
      .select('position')
      .eq('status', 'pending')
      .order('position', { ascending: true })
      .limit(1)
      .single();

    if (firstPending) {
      // Bump all pending entries up by 1
      await supabase.rpc('bump_queue_positions', { from_pos: firstPending.position });
      finalPosition = firstPending.position;
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

export async function createAccount(agentId, tier, nxtLayerAddress) {
  const isPremium = tier === 'premium';

  const { data, error } = await supabase
    .from('accounts')
    .insert({
      agent_id: agentId,
      tier,
      nxt_layer_address: nxtLayerAddress,
      nft_entitled: isPremium,
      gas_bundle_sent: isPremium,
      last_active: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error(`[DB] Failed to create account: ${error.message}`);
  console.log(`[ACCOUNT] Created ${tier} account for ${agentId} → ${nxtLayerAddress}`);
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
