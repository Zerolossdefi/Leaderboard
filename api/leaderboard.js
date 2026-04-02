// ─────────────────────────────────────────────────────────────────────────────
// CONTRACTS & CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const ZLT_CONTRACT    = "0x05D8762946fA7620b263E1e77003927addf5f7E6";
const OAT_CONTRACT    = "0x1d1C02F9fcff7EE2073a72181caE53563C82879C";
const STAKED_CONTRACT = "0xa40984640D83230EE6Fa1d912E2030f8485b9eFc";
const LP_CONTRACT     = "0xAb168a06623eDe1b6b590733952cca4d7123f1F5";

const CHAIN    = "0x38"; // BNB Smart Chain
const BASE_URL = "https://deep-index.moralis.io/api/v2.2";
const BNB_RPC  = "https://bsc-dataseed.binance.org/";

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITER – ensures at most one Moralis call every 4 hours
// ─────────────────────────────────────────────────────────────────────────────
let lastMoralisFetch = 0;
let moralisCache = null;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

async function getMoralisData() {
  const now = Date.now();
  if (moralisCache && (now - lastMoralisFetch) < FOUR_HOURS_MS) {
    console.log(`[Cache] Using cached Moralis data (age ${Math.round((now - lastMoralisFetch) / 60000)} min)`);
    return moralisCache;
  }

  console.log("[Cache] Fetching fresh Moralis data...");
  const [oatHolders, transfers, nftStaked, zltInLPRaw] = await Promise.all([
    fetchOATHolders(),
    fetchZLTTransfers(),
    fetchTotalStaked(),
    fetchZLTInLP()
  ]);
  moralisCache = { oatHolders, transfers, nftStaked, zltInLPRaw };
  lastMoralisFetch = now;
  return moralisCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING
// ─────────────────────────────────────────────────────────────────────────────
function computePoints(volume24h, swapsCount, poeStaked) {
  const volPts = Math.floor(volume24h / 1e18 / 100) * 5;
  const swapPts = swapsCount * 5;
  const poeBonus = poeStaked ? 500 : 0;
  return volPts + swapPts + poeBonus;
}

// ─────────────────────────────────────────────────────────────────────────────
// MORALIS WRAPPER (requires env MORALIS_API_KEY)
// ─────────────────────────────────────────────────────────────────────────────
async function moralisFetch(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "X-API-Key": process.env.MORALIS_API_KEY,
      Accept: "application/json"
    }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Moralis ${res.status} on ${path}: ${body.message || res.statusText}`);
  }
  return res.json();
}

async function fetchOATHolders() {
  const holders = new Set();
  let cursor = null;
  do {
    const cp = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await moralisFetch(`/nft/${OAT_CONTRACT}/owners?chain=${CHAIN}&format=decimal&limit=100${cp}`);
    if (Array.isArray(data.result)) {
      data.result.forEach(item => holders.add(item.owner_of.toLowerCase()));
    }
    cursor = data.cursor || null;
  } while (cursor);
  return holders;
}

async function fetchZLTTransfers() {
  let all = [], cursor = null, page = 0;
  const MAX_PAGES = 5;
  do {
    const cp = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await moralisFetch(`/erc20/${ZLT_CONTRACT}/transfers?chain=${CHAIN}&limit=100&order=DESC${cp}`);
    if (!Array.isArray(data.result) || data.result.length === 0) break;
    all = all.concat(data.result);
    cursor = data.cursor || null;
    page++;
  } while (cursor && page < MAX_PAGES);
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// BNB RPC CALLS (no Moralis)
// ─────────────────────────────────────────────────────────────────────────────
async function rpcCall(to, data) {
  const res = await fetch(BNB_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] })
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// totalStaked – use function selector first, fallback to storage slot 0xe
async function fetchTotalStaked() {
  const hexToInt = (hex) => {
    if (!hex || hex === "0x") return 0;
    const val = Number(BigInt(hex));
    return (val > 0 && val < 1_000_000) ? val : 0;
  };
  try {
    const result = await rpcCall(STAKED_CONTRACT, "0x4f2bfe5b");
    const val = hexToInt(result);
    if (val) return val;
  } catch (e) { /* fall through */ }
  try {
    const result = await rpcCall(STAKED_CONTRACT, "0xe"); // storage slot 14 decimal
    const val = hexToInt(result);
    if (val) return val;
  } catch (e) { /* fall through */ }
  console.warn("[fetchTotalStaked] Could not read totalStaked");
  return 0;
}

// ZLT reserve in LP pair
async function fetchZLTInLP() {
  try {
    const [hex0, hex1] = await Promise.all([
      rpcCall(LP_CONTRACT, "0x0dfe1681"),
      rpcCall(LP_CONTRACT, "0xd21220a7")
    ]);
    const token0 = ("0x" + hex0.slice(-40)).toLowerCase();
    const token1 = ("0x" + hex1.slice(-40)).toLowerCase();
    const zlt = ZLT_CONTRACT.toLowerCase();
    const reservesHex = await rpcCall(LP_CONTRACT, "0x0902f1ac");
    const raw = reservesHex.slice(2);
    const reserve0 = BigInt("0x" + raw.slice(0, 64));
    const reserve1 = BigInt("0x" + raw.slice(64, 128));
    if (token0 === zlt) return reserve0.toString();
    if (token1 === zlt) return reserve1.toString();
    console.warn("[fetchZLTInLP] ZLT not found in LP pair");
    return "0";
  } catch (e) {
    console.warn("[fetchZLTInLP] RPC failed:", e.message);
    return "0";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA PROCESSING
// ─────────────────────────────────────────────────────────────────────────────
function processData(transfers, oatHolders) {
  const map = new Map();
  const now = Date.now();
  const DAY_MS = 86400000;

  for (const tx of transfers) {
    const addr = tx.from_address?.toLowerCase();
    if (!addr || addr === "0x0000000000000000000000000000000000000000") continue;
    const ts = new Date(tx.block_timestamp).getTime();
    const val = parseInt(tx.value) || 0;
    const is24h = (now - ts) < DAY_MS;

    if (!map.has(addr)) {
      map.set(addr, { address: addr, volume24h: 0, totalVolume: 0, swapsCount: 0, poeStaked: false });
    }
    const entry = map.get(addr);
    entry.swapsCount++;
    entry.totalVolume += val;
    if (is24h) entry.volume24h += val;
  }

  for (const addr of oatHolders) {
    if (!map.has(addr)) {
      map.set(addr, { address: addr, volume24h: 0, totalVolume: 0, swapsCount: 0, poeStaked: true });
    } else {
      map.get(addr).poeStaked = true;
    }
  }

  const wallets = Array.from(map.values());
  for (const w of wallets) {
    w.points = computePoints(w.volume24h, w.swapsCount, w.poeStaked);
  }

  wallets.sort((a, b) => b.points - a.points);
  return wallets.slice(0, 50).map((w, i) => ({
    rank: i + 1,
    address: w.address,
    volume24h: w.volume24h,
    swapsCount: w.swapsCount,
    poeStaked: w.poeStaked,
    points: w.points
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER (Vercel)
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS & preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!process.env.MORALIS_API_KEY) {
    return res.status(500).json({ success: false, error: "MORALIS_API_KEY missing" });
  }

  try {
    const { oatHolders, transfers, nftStaked, zltInLPRaw } = await getMoralisData();
    const leaderboard = processData(transfers, oatHolders);
    const totalWallets = leaderboard.length;

    // Vercel edge cache – 4 hours, revalidate in background
    res.setHeader("Cache-Control", "s-maxage=14400, stale-while-revalidate=3600");

    return res.status(200).json({
      success: true,
      updatedAt: new Date().toISOString(),
      totalWallets,
      totalTxns: transfers.length,
      nftStaked,
      zltInLP: zltInLPRaw,
      leaderboard
    });
  } catch (err) {
    console.error("[Leaderboard API Error]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
