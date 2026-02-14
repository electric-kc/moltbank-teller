// Config loaded from environment variables
// In SecretVM these come from encrypted secrets

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  chain: {
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    safeAddress: process.env.SAFE_ADDRESS,
    usdcContract: process.env.USDC_CONTRACT || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  teller: {
    pollInterval: parseInt(process.env.POLL_INTERVAL || '15000'),
    queueCooldown: parseInt(process.env.QUEUE_COOLDOWN || '120000'),
    agentName: process.env.TELLER_AGENT_NAME || 'moltbank-teller',
  },
  tiers: {
    regular: { amount: 10, label: 'regular' },
    premium: { amount: 50, label: 'premium' },
  },
  gasBundle: {
    price: 15,
    perChain: 2.5,
    chains: ['BTC', 'ETH', 'XRP', 'SOL', 'BASE'],
  },
  nxtLayerGas: 5, // $5 USDC of NXT Layer gas included with every account
};

// Validate required config on startup
export function validateConfig() {
  const required = [
    ['SUPABASE_URL', config.supabase.url],
    ['SUPABASE_SERVICE_KEY', config.supabase.serviceKey],
    ['SAFE_ADDRESS', config.chain.safeAddress],
  ];

  const missing = required.filter(([name, val]) => !val);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.map(([n]) => n).join(', ')}`);
  }
}
