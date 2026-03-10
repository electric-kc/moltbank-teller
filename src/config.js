export const config = {
  port: process.env.PORT || 3402,
  chain: {
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    safeAddress: process.env.SAFE_ADDRESS,
    usdcContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on BASE
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  tiers: {
    limited: { amount: 5, label: 'limited' },
    regular: { amount: 10, label: 'regular' },
    premium: { amount: 50, label: 'premium' },
    vip: { amount: 100, label: 'vip' },
  },
  tierCaps: {
    vip: {
      displayCap: 1000,  // Lovable shows SOLD OUT at this number
      hardCap: 1100,     // Teller hard-rejects above this (10% buffer)
    },
    // No caps on other tiers
  },
  gasBundle: {
    price: 15,
    perChain: {
      limited: 0,
      regular: 0,
      premium: 2.5,
      vip: 5,
      standalone: 2.5,
    },
    chains: ['BTC', 'ETH', 'XRP', 'SOL', 'BASE'],
  },
  nxtLayerGas: {
    limited: 1,
    regular: 5,
    premium: 5,
    vip: 10,
  },
  points: {
    limited: 250,
    gas_bundle: 250,
    regular: 1000,
    premium: 5000,
    vip: 15000,
  },
  referral: {
    usdcPercent: 0.10,
    points: {
      limited: 50,
      regular: 250,
      premium: 1000,
      vip: 2500,
    },
    maxPerAccount: 50,
  },
  queue: {
    cooldown: parseInt(process.env.QUEUE_COOLDOWN) || 30000,
  },
};
