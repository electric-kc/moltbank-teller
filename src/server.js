import http from 'node:http';
import { config } from './config.js';
import { isPaymentProcessed, addToQueue, getQueueStats } from './db.js';

const PORT = process.env.PORT || 3402;

// Parse JSON body from request
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// Send JSON response
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ─── x402 Payment Required Response ───

function send402(res, amount, description) {
  res.writeHead(402, {
    'Content-Type': 'application/json',
    'X-Payment-Required': 'true',
    'X-Payment-Chain': 'BASE',
    'X-Payment-Token': 'USDC',
    'X-Payment-Amount': amount.toString(),
    'X-Payment-Address': config.chain.safeAddress,
    'X-Payment-Description': description,
  });
  res.end(JSON.stringify({
    error: 'payment_required',
    payment: {
      chain: 'BASE',
      token: 'USDC',
      contract: config.chain.usdcContract,
      amount,
      recipient: config.chain.safeAddress,
      description,
    },
    instructions: `Send ${amount} USDC to ${config.chain.safeAddress} on BASE. Include your agent ID in the request after payment.`,
  }));
}

// ─── Route Handlers ───

async function handleAccountOpen(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const tier = url.searchParams.get('tier') || 'regular';

  if (tier !== 'regular' && tier !== 'premium' && tier !== 'vip') {
    return json(res, 400, { error: 'Invalid tier. Use "regular", "premium", or "vip".' });
  }

  const body = await parseBody(req);
  const paymentTx = body.payment_tx;
  const agentId = body.agent_id;

  // No payment proof? Return 402
  if (!paymentTx) {
    const amount = config.tiers[tier].amount;
    const descriptions = {
      regular: `Regular Account: NXT Layer wallet, 5 chain addresses (BTC, ETH, XRP, SOL, BASE), $${config.nxtLayerGas.regular} NXT Layer gas`,
      premium: `Premium Account: NXT Layer wallet, 5 chain addresses (BTC, ETH, XRP, SOL, BASE), $${config.nxtLayerGas.premium} NXT Layer gas, $12.50 gas bundle (5 chains), priority queue, NFT entitlement`,
      vip: `VIP Account: NXT Layer wallet, 5 chain addresses (BTC, ETH, XRP, SOL, BASE), $${config.nxtLayerGas.vip} NXT Layer gas, $25 gas bundle (5 chains), instant queue (front of line), VIP NFT`,
    };
    return send402(res, amount, descriptions[tier]);
  }

  // Has payment proof — verify and queue
  if (!agentId) {
    return json(res, 400, { error: 'Missing agent_id' });
  }

  // Check if already processed
  const alreadyProcessed = await isPaymentProcessed(paymentTx);
  if (alreadyProcessed) {
    return json(res, 409, { error: 'Payment already processed', payment_tx: paymentTx });
  }

  // Add to queue (on-chain verification happens in the watcher loop)
  const amount = config.tiers[tier].amount;
  const queueEntry = await addToQueue(paymentTx, agentId, tier, amount);

  const stats = await getQueueStats();

  const includesMap = {
    regular: {
      nxt_layer_gas: `$${config.nxtLayerGas.regular}`,
    },
    premium: {
      nxt_layer_gas: `$${config.nxtLayerGas.premium}`,
      gas_bundle: config.gasBundle.chains.map((c) => `$${config.gasBundle.perChain.premium} ${c}`),
      priority_queue: true,
      nft_entitlement: true,
    },
    vip: {
      nxt_layer_gas: `$${config.nxtLayerGas.vip}`,
      gas_bundle: config.gasBundle.chains.map((c) => `$${config.gasBundle.perChain.vip} ${c}`),
      instant_queue: true,
      vip_nft: true,
    },
  };

  return json(res, 202, {
    status: 'queued',
    tier,
    position: queueEntry.position,
    agents_ahead: stats.pending - 1,
    estimated_wait_minutes: (stats.pending - 1) * (config.teller.queueCooldown / 60000),
    includes: includesMap[tier],
    message: `Account queued at position ${queueEntry.position}. You will receive your wallet details once processed.`,
  });
}

async function handleGasBundle(req, res) {
  const body = await parseBody(req);
  const paymentTx = body.payment_tx;
  const agentId = body.agent_id;

  // No payment proof? Return 402
  if (!paymentTx) {
    return send402(
      res,
      config.gasBundle.price,
      `Gas Bundle: $${config.gasBundle.perChain} of gas on each of ${config.gasBundle.chains.join(', ')}`
    );
  }

  if (!agentId) {
    return json(res, 400, { error: 'Missing agent_id' });
  }

  const alreadyProcessed = await isPaymentProcessed(paymentTx);
  if (alreadyProcessed) {
    return json(res, 409, { error: 'Payment already processed', payment_tx: paymentTx });
  }

  // Queue gas bundle delivery
  const queueEntry = await addToQueue(paymentTx, agentId, 'gas_bundle', config.gasBundle.price);

  return json(res, 202, {
    status: 'queued',
    type: 'gas_bundle',
    position: queueEntry.position,
    chains: config.gasBundle.chains,
    per_chain: `$${config.gasBundle.perChain}`,
    message: 'Gas bundle queued for delivery.',
  });
}

async function handleQueueStatus(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const agentId = url.searchParams.get('agent_id');

  const stats = await getQueueStats();

  return json(res, 200, {
    queue_length: stats.pending,
    total_processed: stats.completed,
    cooldown_seconds: config.teller.queueCooldown / 1000,
    estimated_wait_minutes: stats.pending * (config.teller.queueCooldown / 60000),
    pricing: {
      regular_account: `${config.tiers.regular.amount} USDC`,
      premium_account: `${config.tiers.premium.amount} USDC`,
      vip_account: `${config.tiers.vip.amount} USDC`,
      gas_bundle: `${config.gasBundle.price} USDC`,
    },
    supported_chains: config.gasBundle.chains,
  });
}

async function handleHealth(req, res) {
  return json(res, 200, { status: 'online', agent: config.teller.agentName, timestamp: new Date().toISOString() });
}

// ─── Router ───

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path === '/account/open' && req.method === 'POST') {
      return await handleAccountOpen(req, res);
    }
    if (path === '/gas-bundle' && req.method === 'POST') {
      return await handleGasBundle(req, res);
    }
    if (path === '/queue/status' && req.method === 'GET') {
      return await handleQueueStatus(req, res);
    }
    if (path === '/health' && req.method === 'GET') {
      return await handleHealth(req, res);
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(`[HTTP] Error: ${error.message}`);
    return json(res, 500, { error: 'Internal server error' });
  }
});

export function startServer() {
  server.listen(PORT, () => {
    console.log(`[HTTP] Teller API running on port ${PORT}`);
    console.log(`[HTTP] POST /account/open?tier=regular  → 10 USDC`);
    console.log(`[HTTP] POST /account/open?tier=premium  → 50 USDC`);
    console.log(`[HTTP] POST /account/open?tier=vip      → 100 USDC`);
    console.log(`[HTTP] POST /gas-bundle                 → 15 USDC`);
    console.log(`[HTTP] GET  /queue/status`);
    console.log(`[HTTP] GET  /health`);
  });
}
