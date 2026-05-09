// api/score.js – Fast BNB scorer with optional real ZPI for ZLT
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// ZLT contract address (lowercase for comparison)
// ---------------------------------------------------------------------------
const ZLT_ADDRESS = '0x05d8762946fa7620b263e1e77003927addf5f7e6';

// ---------------------------------------------------------------------------
// Supabase client (lazy init)
// ---------------------------------------------------------------------------
let supabase = null;
function getSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) supabase = createClient(url, key);
  return supabase;
}

// ---------------------------------------------------------------------------
// Fast RPC client
// ---------------------------------------------------------------------------
const PUBLIC_RPC = 'https://bsc-dataseed1.binance.org/';
const client = createPublicClient({
  chain: bsc,
  transport: http(PUBLIC_RPC, { timeout: 5000, retryCount: 1 }),
});

// Minimal ABI
const abi = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals',  type: 'function', inputs: [], outputs: [{ type: 'uint8' }] },
];

// ---------------------------------------------------------------------------
// Helper: fetch real ZPI score from Supabase (with 1-second timeout)
// ---------------------------------------------------------------------------
async function fetchRealZPI(wallet) {
  const supabaseClient = getSupabase();
  if (!supabaseClient) return null;

  try {
    const result = await Promise.race([
      supabaseClient
        .from('wallets')
        .select('zpi_score')
        .ilike('address', wallet)
        .maybeSingle(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase timeout')), 1000)),
    ]);
    if (result.error) throw result.error;
    if (result.data && result.data.zpi_score !== null) {
      return Number(result.data.zpi_score);
    }
  } catch (err) {
    console.warn('[score] Supabase lookup failed, fallback to simple score:', err.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { token, wallet } = req.query;
  if (!token || !wallet) {
    return res.status(400).json({ error: 'Missing token or wallet address' });
  }

  try {
    // 1. Get decimals and balance in parallel with a 3-second race
    let decimals = 18;
    let balance = 0;
    try {
      const [dec, bal] = await Promise.race([
        Promise.all([
          client.readContract({ address: token, abi, functionName: 'decimals' }).catch(() => 18),
          client.readContract({ address: token, abi, functionName: 'balanceOf', args: [wallet] }),
        ]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), 3000)),
      ]);
      decimals = Number(dec);
      balance = Number(bal) / 10 ** decimals;
    } catch (err) {
      console.warn('[score] RPC error, using zero balance:', err.message);
      balance = 0;
    }

    // 2. Determine score
    let score = Math.floor(balance * 0.01);
    let zpi_type = 'simple';

    // 3. If token is ZLT, try to get real ZPI score (non‑blocking fallback)
    const isZLT = token.toLowerCase() === ZLT_ADDRESS;
    if (isZLT) {
      const realScore = await fetchRealZPI(wallet);
      if (realScore !== null) {
        score = realScore;
        zpi_type = 'real';
      }
    }

    res.status(200).json({
      success: true,
      token,
      wallet,
      balance,
      score,
      decimals,
      zpi_type,
    });
  } catch (err) {
    console.error('[score]', err);
    res.status(500).json({ error: err.message });
  }
}
