// api/score.js – Generic token scoring for any BEP‑20 on BNB Chain
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';

const PUBLIC_RPC = 'https://bsc-dataseed1.binance.org/';
const client = createPublicClient({ chain: bsc, transport: http(PUBLIC_RPC) });

// Minimal ABI for balanceOf and decimals
const abi = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals',  type: 'function', inputs: [], outputs: [{ type: 'uint8' }] },
];

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { token, wallet } = req.query;
  if (!token || !wallet) {
    return res.status(400).json({ error: 'Missing token or wallet address' });
  }

  try {
    // 1. Get token decimals (default 18)
    let decimals = 18;
    try {
      decimals = await client.readContract({ address: token, abi, functionName: 'decimals' });
    } catch (e) { /* ignore, use default */ }

    // 2. Get token balance
    const balanceRaw = await client.readContract({
      address: token,
      abi,
      functionName: 'balanceOf',
      args: [wallet],
    });
    const balance = Number(balanceRaw) / 10 ** decimals;

    // 3. Simple score = balance * 0.01 (scaled for readability)
    const score = Math.floor(balance * 0.01);

    res.status(200).json({
      success: true,
      token,
      wallet,
      balance,
      score,
      decimals,
    });
  } catch (err) {
    console.error('[score]', err);
    res.status(500).json({ error: err.message });
  }
}
