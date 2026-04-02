// ── CONTRACTS ─────────────────────────────────────────────────────────────────
const ZLT_CONTRACT    = "0x05D8762946fA7620b263E1e77003927addf5f7E6"; // ZLT token
const OAT_CONTRACT    = "0x1d1C02F9fcff7EE2073a72181caE53563C82879C"; // POE NFT (beta OAT)
const STAKED_CONTRACT = "0xa40984640D83230EE6Fa1d912E2030f8485b9eFc"; // NFT staking contract
const LP_CONTRACT     = "0xAb168a06623eDe1b6b590733952cca4d7123f1F5"; // ZLT LP contract

const CHAIN    = "0x38"; // BNB Smart Chain
const BASE_URL = "https://deep-index.moralis.io/api/v2.2";
const BNB_RPC  = "https://bsc-dataseed.binance.org/"; // public BNB Chain RPC

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

// ── FETCH: Total staked NFTs via direct BNB RPC ───────────────────────────────
// Reads the public uint256 variable `totalStaked` on STAKED_CONTRACT.
// Function selector: keccak256("totalStaked()") = 0x4f2bfe5b
async function fetchTotalStaked() {
  try {
    const res = await fetch(BNB_RPC, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id:      1,
        method:  "eth_call",
        params: [
          { to: STAKED_CONTRACT, data: "0x4f2bfe5b" },
          "latest"
        ]
      })
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    // Result is a 32-byte hex-encoded uint256
    const hex = json.result;
    if (!hex || hex === "0x") return 0;
    return Number(BigInt(hex));
  } catch (e) {
    console.warn("[fetchTotalStaked] RPC call failed:", e.message);
    return 0;
  }
}

// ── FETCH: ZLT balance of LP contract (ZLT locked in LP) ─────────────────────
// Uses direct BNB RPC to read PancakeSwap pair reserves.
// Steps:
//   1. Call token0() (0x0dfe1681) on LP_CONTRACT → address of token0
//   2. Call token1() (0xd21220a7) on LP_CONTRACT → address of token1
//   3. Call getReserves() (0x0902f1ac) → (reserve0 uint112, reserve1 uint112, blockTimestamp uint32)
//   4. Match ZLT_CONTRACT to token0 or token1 → return the correct reserve as a string
async function fetchZLTInLP() {
  try {
    // Helper: single eth_call returning a raw hex result
    async function rpcCall(to, data) {
      const res = await fetch(BNB_RPC, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id:      1,
          method:  "eth_call",
          params:  [{ to, data }, "latest"]
        })
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    }

    // 1. Read token0 and token1 in parallel
    const [hex0, hex1] = await Promise.all([
      rpcCall(LP_CONTRACT, "0x0dfe1681"), // token0()
      rpcCall(LP_CONTRACT, "0xd21220a7")  // token1()
    ]);

    // ABI-decode address: strip 0x + leading 24 zero-padded bytes → last 20 bytes
    const token0 = ("0x" + hex0.slice(-40)).toLowerCase();
    const token1 = ("0x" + hex1.slice(-40)).toLowerCase();
    const zlt    = ZLT_CONTRACT.toLowerCase();

    // 2. Read reserves
    const hexReserves = await rpcCall(LP_CONTRACT, "0x0902f1ac"); // getReserves()

    // getReserves() returns three packed values in 96 bytes (3 × 32-byte slots):
    //   slot 0 (bytes 0–63):   reserve0  (uint112, right-padded to 32 bytes)
    //   slot 1 (bytes 64–127): reserve1  (uint112, right-padded to 32 bytes)
    //   slot 2 (bytes 128–191): blockTimestampLast (uint32)
    const raw = hexReserves.slice(2); // strip 0x
    const reserve0 = BigInt("0x" + raw.slice(0,   64));
    const reserve1 = BigInt("0x" + raw.slice(64, 128));

    // 3. Return the reserve that corresponds to ZLT
    if (token0 === zlt) return reserve0.toString();
    if (token1 === zlt) return reserve1.toString();

    // ZLT not found in either slot — return "0" as fallback
    console.warn("[fetchZLTInLP] ZLT not found in LP pair. token0:", token0, "token1:", token1);
    return "0";

  } catch (e) {
    console.warn("[fetchZLTInLP] RPC call failed:", e.message);
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
