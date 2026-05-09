// api/score.js – Fast and reliable BNB-only scorer (no hanging)
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';

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

// Simple address validation
const BNB_RE = /^0x[0-9a-fA-F]{40}$/;

// Minimal ABI
const abi = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals',  type: 'function', inputs: [], outputs: [{ type: 'uint8' }] },
];

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
  const token = searchParams.get('token')?.trim();
  const wallet = searchParams.get('wallet')?.trim();

  if (!token || !wallet) {
    return corsResponse({ success: false, error: 'Missing token or wallet' }, 400);
  }
  if (!BNB_RE.test(token) || !BNB_RE.test(wallet)) {
    return corsResponse({ success: false, error: 'Invalid 0x address format' }, 400);
  }

  try {
    const client = createPublicClient({
      chain: bsc,
      transport: http('https://bsc-dataseed1.binance.org/', { timeout: 5000, retryCount: 1 }),
    });

    // Race against a 2 second timeout
    const [decimals, rawBalance] = await Promise.race([
      Promise.all([
        client.readContract({ address: token, abi, functionName: 'decimals' }).catch(() => 18),
        client.readContract({ address: token, abi, functionName: 'balanceOf', args: [wallet] }),
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), 2000)),
    ]);

    const balance = Number(rawBalance) / (10 ** Number(decimals));
    const score = Math.floor(balance * 0.01); // simple score

    return corsResponse({ success: true, token, wallet, balance, score, decimals: Number(decimals) });
  } catch (err) {
    console.error('[score]', err);
    // Fallback: return a zero score rather than failing
    return corsResponse({ success: true, token, wallet, balance: 0, score: 0, decimals: 18, warning: err.message });
  }
}
