// ── CONTRACTS ─────────────────────────────────────────────────────────────────
const ZLT_CONTRACT    = "0x05D8762946fA7620b263E1e77003927addf5f7E6"; // ZLT token
const OAT_CONTRACT    = "0x1d1C02F9fcff7EE2073a72181caE53563C82879C"; // POE NFT (beta OAT)
const STAKED_CONTRACT = "0xa40984640D83230EE6Fa1d912E2030f8485b9eFc"; // NFT staking contract
const LP_CONTRACT     = "0xAb168a06623eDe1b6b590733952cca4d7123f1F5"; // ZLT LP contract

const CHAIN    = "0x38"; // BNB Smart Chain
const BASE_URL = "https://deep-index.moralis.io/api/v2.2";

// ── SCORING FORMULA ───────────────────────────────────────────────────────────
// volumePoints = Math.floor(volume24h / 1e18 / 100) * 5  → 5 pts per 100 ZLT in last 24h
// swapPoints   = swapsCount * 5                          → 5 pts per transfer
// poeBonus     = poeStaked ? 500 : 0
// totalPoints  = volumePoints + swapPoints + poeBonus
function computePoints(volume24h, swapsCount, poeStaked) {
  const volumePoints = Math.floor(volume24h / 1e18 / 100) * 5;
  const swapPoints   = swapsCount * 5;
  const poeBonus     = poeStaked ? 500 : 0;
  return volumePoints + swapPoints + poeBonus;
}

// ── MORALIS FETCH WRAPPER ─────────────────────────────────────────────────────
async function moralisFetch(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      "X-API-Key": process.env.MORALIS_API_KEY,
      "Accept":    "application/json"
    }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Moralis ${res.status} on ${path}: ${body.message || res.statusText}`);
  }
  return res.json();
}

// ── FETCH: OAT NFT holders → Set of addresses (poeStaked detection) ───────────
async function fetchOATHolders() {
  const holders = new Set();
  let cursor = null;
  do {
    const cp   = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await moralisFetch(
      `/nft/${OAT_CONTRACT}/owners?chain=${CHAIN}&format=decimal&limit=100${cp}`
    );
    if (Array.isArray(data.result)) {
      data.result.forEach(item => holders.add(item.owner_of.toLowerCase()));
    }
    cursor = data.cursor || null;
  } while (cursor);
  return holders;
}

// ── FETCH: ZLT transfers → raw array (up to 500, newest first) ───────────────
async function fetchZLTTransfers() {
  let all    = [];
  let cursor = null;
  let page   = 0;
  const MAX  = 5; // 5 pages × 100 = 500 transfers
  do {
    const cp   = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await moralisFetch(
      `/erc20/${ZLT_CONTRACT}/transfers?chain=${CHAIN}&limit=100&order=DESC${cp}`
    );
    if (!Array.isArray(data.result) || data.result.length === 0) break;
    all    = all.concat(data.result);
    cursor = data.cursor || null;
    page++;
  } while (cursor && page < MAX);
  return all;
}

// ── FETCH: Total staked NFTs via totalSupply() on STAKED_CONTRACT ─────────────
async function fetchTotalStaked() {
  try {
    const data = await moralisFetch(
      `/functions/runContractFunction?chain=${CHAIN}` +
      `&address=${STAKED_CONTRACT}` +
      `&function_name=totalSupply` +
      `&abi=${encodeURIComponent(JSON.stringify([{
        "inputs":  [],
        "name":    "totalSupply",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
      }]))}`
    );
    return parseInt(data.result || "0", 10);
  } catch (e) {
    console.warn("totalSupply call failed, using 0:", e.message);
    return 0;
  }
}

// ── FETCH: ZLT balance of LP contract (ZLT locked in LP) ─────────────────────
async function fetchZLTInLP() {
  try {
    const data = await moralisFetch(
      `/erc20/${ZLT_CONTRACT}/balance?chain=${CHAIN}&address=${LP_CONTRACT}`
    );
    // Returns { balance: "rawWeiString" }
    return data.balance || "0";
  } catch (e) {
    console.warn("LP balance fetch failed:", e.message);
    return "0";
  }
}

// ── PROCESS: Build wallet map from transfers + enrich with NFT data ────────────
function processData(transfers, oatHolders) {
  const map = {};
  const now = Date.now();
  const DAY = 86400 * 1000;

  transfers.forEach(tx => {
    const addr = (tx.from_address || "").toLowerCase();
    // Skip zero address (mints)
    if (!addr || addr === "0x0000000000000000000000000000000000000000") return;

    const ts    = new Date(tx.block_timestamp).getTime(); // ISO → ms
    const val   = parseInt(tx.value) || 0;
    const is24h = (now - ts) < DAY;

    if (!map[addr]) {
      map[addr] = {
        address:     addr,
        volume24h:   0,
        totalVolume: 0,
        swapsCount:  0,
        poeStaked:   false,
        points:      0
      };
    }
    map[addr].swapsCount++;
    map[addr].totalVolume += val;
    if (is24h) map[addr].volume24h += val;
  });

  // Enrich: mark POE holders + also add OAT holders not in transfers
  oatHolders.forEach(addr => {
    if (!map[addr]) {
      map[addr] = {
        address:     addr,
        volume24h:   0,
        totalVolume: 0,
        swapsCount:  0,
        poeStaked:   true,
        points:      0
      };
    } else {
      map[addr].poeStaked = true;
    }
  });

  // Compute points for every wallet
  Object.values(map).forEach(w => {
    w.points = computePoints(w.volume24h, w.swapsCount, w.poeStaked);
  });

  // Sort by points desc, take top 50, assign rank
  return Object.values(map)
    .sort((a, b) => b.points - a.points)
    .slice(0, 50)
    .map((w, i) => ({
      rank:        i + 1,
      address:     w.address,
      volume24h:   w.volume24h,
      swapsCount:  w.swapsCount,
      poeStaked:   w.poeStaked,
      points:      w.points
    }));
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!process.env.MORALIS_API_KEY) {
    return res.status(500).json({
      success: false,
      error: "MORALIS_API_KEY is not set in Vercel environment variables."
    });
  }

  try {
    // Run all independent fetches in parallel for speed
    const [oatHolders, transfers, nftStaked, zltInLPRaw] = await Promise.all([
      fetchOATHolders(),
      fetchZLTTransfers(),
      fetchTotalStaked(),
      fetchZLTInLP()
    ]);

    const leaderboard = processData(transfers, oatHolders);

    // totalWallets = unique wallets in leaderboard (covers transfer senders + OAT holders)
    const totalWallets = leaderboard.length;

    // Cache for 60s on Vercel edge, serve stale for 30s while revalidating
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");

    return res.status(200).json({
      success:      true,
      updatedAt:    new Date().toISOString(),
      totalWallets,
      totalTxns:    transfers.length,
      nftStaked,
      zltInLP:      zltInLPRaw, // raw wei string — frontend formats it
      leaderboard
    });

  } catch (err) {
    console.error("[Leaderboard API Error]", err.message);
    return res.status(500).json({
      success: false,
      error:   err.message
    });
  }
}
