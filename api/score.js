// =============================================================================
// api/score.js
// Vercel serverless function — token balance scorer
// Supports: BNB Chain (0x addresses) and TON (EQ/UQ/kQ addresses)
// =============================================================================

import { createPublicClient, http, parseAbi } from 'viem';
import { bsc } from 'viem/chains';

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
// Chain detection
// ---------------------------------------------------------------------------

const BNB_RE  = /^0x[0-9a-fA-F]{40}$/;
const TON_RE  = /^(EQ|UQ|kQ)[a-zA-Z0-9_-]{44}$/;

function detectChain(wallet) {
  if (BNB_RE.test(wallet))  return 'bnb';
  if (TON_RE.test(wallet))  return 'ton';
  return null;
}

// ---------------------------------------------------------------------------
// Minimal ABI fragments
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

  // Fetch decimals with fallback to 18
  let decimals = 18;
  try {
    decimals = await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    decimals = Number(decimals);
  } catch {
    // Non-standard token or RPC hiccup — use fallback
    decimals = 18;
  }

  const rawBalance = await client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [wallet],
  });

  // Convert from wei to human-readable float
  const balance = Number(rawBalance) / 10 ** decimals;
  const score   = Math.floor(balance * 100);

  return { chain: 'bnb', token, wallet, balance, score, decimals };
}

// ---------------------------------------------------------------------------
// TON handler  (dynamically imported to keep cold-start light)
// ---------------------------------------------------------------------------

async function scoreTON(token, wallet) {
  // Dynamic import — only loaded when a TON request actually arrives
  const { TonClient, Address, Cell, beginCell } = await import('@ton/ton');

  const client = new TonClient({
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
  });

  const masterAddress  = Address.parse(token);
  const ownerAddress   = Address.parse(wallet);

  // Step 1: call get_wallet_address on the Jetton master contract
  // Stack argument: owner address as a cell slice
  const ownerCell = beginCell().storeAddress(ownerAddress).endCell();

  const { stack: walletStack } = await client.runMethod(
    masterAddress,
    'get_wallet_address',
    [{ type: 'slice', cell: ownerCell }],
  );

  const jettonWalletAddress = walletStack.readAddress();

  // Step 2: call get_wallet_data on the returned Jetton wallet
  const { stack: dataStack } = await client.runMethod(
    jettonWalletAddress,
    'get_wallet_data',
    [],
  );

  // get_wallet_data returns: balance, owner, master, wallet_code
  const rawBalance = dataStack.readBigNumber();

  const DECIMALS = 9; // standard for TON Jettons
  const balance  = Number(rawBalance) / 10 ** DECIMALS;
  const score    = Math.floor(balance * 100);

  return { chain: 'ton', token, wallet, balance, score, decimals: DECIMALS };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'GET') {
    return corsResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  const { searchParams } = new URL(req.url);
  const token  = searchParams.get('token')?.trim();
  const wallet = searchParams.get('wallet')?.trim();

  // Validate required params
  if (!token || !wallet) {
    return corsResponse(
      { success: false, error: 'Missing required query parameters: token, wallet' },
      400,
    );
  }

  // Detect chain
  const chain = detectChain(wallet);
  if (!chain) {
    return corsResponse(
      {
        success: false,
        error:
          'Unrecognised wallet format. Expected 0x… (BNB Chain) or EQ/UQ/kQ… (TON).',
      },
      400,
    );
  }

  // Additional BNB token address validation
  if (chain === 'bnb' && !BNB_RE.test(token)) {
    return corsResponse(
      { success: false, error: 'BNB Chain token address must be a valid 0x… EVM address.' },
      400,
    );
  }

  try {
    const result = chain === 'bnb'
      ? await scoreBNB(token, wallet)
      : await scoreTON(token, wallet);

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

// Vercel Edge / Serverless config
export const config = {
  runtime: 'nodejs18.x',
};
