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
  const score   = Math.floor(balance * 100);

  return { chain: 'bnb', token, wallet, balance, score, decimals };
}

// ---------------------------------------------------------------------------
// TON handler (dynamically imported)
// ---------------------------------------------------------------------------

async function scoreTON(token, wallet) {
  const { TonClient, Address, beginCell } = await import('@ton/ton');

  const client = new TonClient({
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
  });

  const masterAddress  = Address.parse(token);
  const ownerAddress   = Address.parse(wallet);

  const ownerCell = beginCell().storeAddress(ownerAddress).endCell();

  const { stack: walletStack } = await client.runMethod(
    masterAddress,
    'get_wallet_address',
    [{ type: 'slice', cell: ownerCell }],
  );

  const jettonWalletAddress = walletStack.readAddress();

  const { stack: dataStack } = await client.runMethod(
    jettonWalletAddress,
    'get_wallet_data',
    [],
  );

  const rawBalance = dataStack.readBigNumber();
  const DECIMALS = 9;
  const balance  = Number(rawBalance) / 10 ** DECIMALS;
  const score    = Math.floor(balance * 100);

  return { chain: 'ton', token, wallet, balance, score, decimals: DECIMALS };
}

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

  // Build absolute URL from relative path
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
      { success: false, error: 'Unrecognised wallet format. Expected 0x… (BNB Chain) or EQ/UQ/kQ… (TON).' },
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
    const result = chain === 'bnb'
      ? await scoreBNB(token, wallet)
      : await scoreTON(token, wallet);

    return corsResponse({ success: true, ...result });
  } catch (err) {
    console.error('[score.js] Error:', err);
    return corsResponse(
      { success: false, chain, token, wallet, error: err?.message ?? 'Unexpected error' },
      500,
    );
  }
}
