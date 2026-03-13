import http from 'http';
import { config } from './config.js';
import { addToQueue, getVipCount } from './db.js';

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function send402(res, amount, description) {
  res.writeHead(402, {
    'Content-Type': 'application/json',
    'X-Payment-Required': 'true',
    'X-Payment-Amount': amount.toString(),
    'X-Payment-Currency': 'USDC',
    'X-Payment-Network': 'BASE',
    'X-Payment-Address': config.chain.safeAddress,
  });
  res.end(JSON.stringify({
    status: 402,
    message: 'Payment Required',
    payment: {
      amount,
      currency: 'USDC',
      network: 'BASE',
      address: config.chain.safeAddress,
      description,
    },
  }));
}

const tierDescriptions = {
  regular: `Standard Account: NXT Layer wallet, 5 chain addresses (BTC, ETH, XRP, SOL, BASE), $${config.nxtLayerGas.regular} NXT Layer gas, social recovery with guardians`,
  premium: `Premium Account: NXT Layer wallet, 5 chain addresses (BTC, ETH, XRP, SOL, BASE), $${config.nxtLayerGas.premium} NXT Layer gas, $12.50 gas bundle (5 chains), priority queue, Joint Account (multi-sig), Master Account (2-level governance)`,
  vip: `VIP Account: NXT Layer wallet, 5 chain addresses (BTC, ETH, XRP, SOL, BASE), $${config.nxtLayerGas.vip} NXT Layer gas, $25 gas bundle (5 chains), instant queue (front of line), Joint Account (multi-sig), Governance Account (multi-level governance), Governance Control Center`,
};

async function handleAccountOpen(req, res, tier) {
  const body = await parseBody(req);
  const paymentTx = body.payment_tx;
  const agentId = body.agent_id;
  const referralCode = body.referral_code || null;

  // No payment proof? Return 402
  if (!paymentTx) {
    // VIP cap check BEFORE sending payment request
    if (tier === 'vip') {
      const vipCount = await getVipCount();
      if (vipCount >= config.tierCaps.vip.displayCap) {
        return sendJson(res, 503, {
          error: 'VIP accounts sold out',
          message: `All ${config.tierCaps.vip.displayCap} VIP accounts have been claimed.`,
          tier: 'vip',
          remaining: 0,
        });
      }
    }

    const amount = config.tiers[tier].amount;
    return send402(res, amount, tierDescriptions[tier]);
  }

  // Has payment proof — process it
  if (!agentId) {
    return sendJson(res, 400, { error: 'agent_id is required' });
  }

  const amount = config.tiers[tier].amount;
  const queueEntry = await addToQueue(paymentTx, agentId, tier, amount, referralCode);

  if (!queueEntry) {
    return sendJson(res, 500, { error: 'Failed to add to queue' });
  }

  sendJson(res, 200, {
    status: 'queued',
    tier,
    position: queueEntry.position,
    points: config.points[tier],
    nxtGas: config.nxtLayerGas[tier],
    gasBundle: config.gasBundle.perChain[tier] > 0
      ? `$${config.gasBundle.perChain[tier]} x ${config.gasBundle.chains.length} chains`
      : 'none',
    referralCode: referralCode || 'none',
  });
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    status: 'ok',
    service: 'moltbank-teller',
    timestamp: new Date().toISOString(),
    tiers: Object.keys(config.tiers),
  });
}

async function handleVipStatus(req, res) {
  const vipCount = await getVipCount();
  const cap = config.tierCaps.vip.displayCap;
  sendJson(res, 200, {
    tier: 'vip',
    total: cap,
    claimed: vipCount,
    remaining: Math.max(0, cap - vipCount),
    soldOut: vipCount >= cap,
  });
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://localhost:${config.port}`);

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return handleHealth(req, res);
      }
      if (req.method === 'GET' && url.pathname === '/vip/status') {
        return handleVipStatus(req, res);
      }
      if (req.method === 'POST' && url.pathname === '/account/open') {
        return handleAccountOpen(req, res, 'regular');
      }
      if (req.method === 'POST' && url.pathname === '/account/open/premium') {
        return handleAccountOpen(req, res, 'premium');
      }
      if (req.method === 'POST' && url.pathname === '/account/open/vip') {
        return handleAccountOpen(req, res, 'vip');
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[SERVER] Error:', err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  server.listen(config.port, () => {
    console.log(`[TELLER] Listening on port ${config.port}`);
    console.log(`[TELLER] Tiers: Standard ($10) | Premium ($50) | VIP ($100)`);
    console.log(`[TELLER] VIP cap: ${config.tierCaps.vip.displayCap} (buffer: ${config.tierCaps.vip.hardCap})`);
  });
}
