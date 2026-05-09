// =============================================================================
// api/score.js
// Vercel serverless function — token balance scorer
// Currently supports: BNB Chain only (TON commented out for now)
// =============================================================================

import { createPublicClient, http, parseAbi } from 'viem';
import { bsc } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// ZLT contract address
// ---------------------------------------------------------------------------

const ZLT_ADDRESS = '0x05D8762946fA7620b263E1e77003927addf5f7E6';

// ---------------------------------------------------------------------------
// Supabase client (lazy-initialised)
// ---------------------------------------------------------------------------

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars are not configured');
  _supabase = createClient(url, key);
  return _supabase;
}

async function zpiScoreFromSupabase(wallet) {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('wallets')
      .select('zpi_score')
      .ilike('address', wallet)
      .maybeSingle();

    if (error) {
      console.error('[score.js] Supabase query error:', error.message);
      return null;
    }
    if (!data) return null;
    const score = Number(data.zpi_score);
    return Number.isFinite(score) ? score : null;
  } catch (err) {
    console.error('[score.js] Supabase unexpected error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ---------------------------------------------------------------------------
// Chain detection (only BNB for now – TON disabled)
// ---------------------------------------------------------------------------

const BNB_RE = /^0x[0-9a-fA-F]{40}$/;

function detectChain(wallet) {
  if (BNB_RE.test(wallet)) return 'bnb';
  // TON support temporarily disabled
  // if (/^(EQ|UQ|kQ)[a-zA-Z0-9_-]{44}$/.test(wallet)) return 'ton';
  return null;
}

// ---------------------------------------------------------------------------
// ABI fragments
// ---------------------------------------------------------------------------

const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
]);

// ---------------------------------------------------------------------------
// BNB Chain handler
// ---------------------------------------------------------------------------

async function scoreBNB(token, wallet) {
  const client = createPublicClient({
    chain: bsc,
    transport: http('https://bsc-dataseed1.binance.org/', {
      timeout: 15_000,
      retryCount: 3,
      retryDelay: 500,
    }),
  });

  let decimals = 18;
  try {
    decimals = await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    decimals = Number(decimals);
  } catch {
    decimals = 18;
  }

  const rawBalance = await client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [wallet],
  });

  const balance = Number(rawBalance) / 10 ** decimals;

  // ZLT real score lookup
  const isZLT = token.toLowerCase() === ZLT_ADDRESS.toLowerCase();
  if (isZLT) {
    const realScore = await zpiScoreFromSupabase(wallet);
    if (realScore !== null) {
      return { chain: 'bnb', token, wallet, balance, score: realScore, decimals, zpi_type: 'real' };
    }
  }

  // Simple score (balance * 0.01)
  const score = Math.floor(balance * 0.01);
  return { chain: 'bnb', token, wallet, balance, score, decimals, zpi_type: 'simple' };
}

// ---------------------------------------------------------------------------
// TON handler – TEMPORARILY DISABLED (commented out)
// ---------------------------------------------------------------------------
/*
async function scoreTON(token, wallet) {
  // TON code removed – will be re-enabled later
  return { error: 'TON support temporarily disabled' };
}
*/

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'GET') {
    return corsResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const fullUrl = `${protocol}://${host}${req.url}`;
  const { searchParams } = new URL(fullUrl);
  const token  = searchParams.get('token')?.trim();
  const wallet = searchParams.get('wallet')?.trim();

  if (!token || !wallet) {
    return corsResponse(
      { success: false, error: 'Missing required query parameters: token, wallet' },
      400,
    );
  }

  const chain = detectChain(wallet);
  if (!chain) {
    return corsResponse(
      { success: false, error: 'Unrecognized wallet format. Currently only BNB Chain (0x...) is supported. TON support coming later.' },
      400,
    );
  }

  if (chain === 'bnb' && !BNB_RE.test(token)) {
    return corsResponse(
      { success: false, error: 'BNB Chain token address must be a valid 0x… EVM address.' },
      400,
    );
  }

  try {
    // Only BNB supported for now
    const result = await scoreBNB(token, wallet);
    return corsResponse({ success: true, ...result });
  } catch (err) {
    console.error('[score.js] Error:', err);
    return corsResponse(
      {
        success: false,
        chain,
        token,
        wallet,
        error: err?.message ?? 'Unexpected error',
      },
      500,
    );
  }
}
