// ─────────────────────────────────────────────────────────────────────────────
// CONTRACTS
// ─────────────────────────────────────────────────────────────────────────────
const ZLT_CONTRACT    = "0x05D8762946fA7620b263E1e77003927addf5f7E6";
const OATNFT_CONTRACT = "0x1d1C02F9fcff7EE2073a72181caE53563C82879C";
const STAKED_CONTRACT = "0xa40984640D83230EE6Fa1d912E2030f8485b9eFc";
const LP_ZLT_BNB      = "0xAb168a06623eDe1b6b590733952cca4d7123f1F5"; // ZLT/WBNB PancakeSwap V2
const LP_BNB_USDT     = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"; // WBNB/USDT PancakeSwap V2
const WBNB_ADDRESS    = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

const CHAIN   = "0x38";
const BNB_RPC = "https://bsc-dataseed.binance.org/";
const MORALIS = "https://deep-index.moralis.io/api/v2.2";

// ─────────────────────────────────────────────────────────────────────────────
// ZPI SCORING CONSTANTS
// Used by individual tab scores (trading / liquidity / holding tabs).
// Overall ZPI uses the same weights but adds cap + activity penalty — see
// computeOverallZPI() below.
// ─────────────────────────────────────────────────────────────────────────────
const TRADING_WEIGHT   = 1020;       // per USD of 24-h trading volume
const LIQUIDITY_WEIGHT = 2030;       // per USD of LP value
const NFT_WEIGHT       = 10000;      // per OAT NFT held
const HOLD_WEIGHT      = 3050;       // per 100,000 ZLT held
const HOLD_CAP         = 6_000_000;  // HoldingScore ceiling (overall tab only)
const ACTIVITY_FLOOR   = 7;          // USD — combined vol+lp below this triggers penalty
const HOLD_PENALTY     = 0.3;        // multiplier applied when below ACTIVITY_FLOOR

// ─────────────────────────────────────────────────────────────────────────────
// MORALIS KEY ROTATION
// ─────────────────────────────────────────────────────────────────────────────
const MORALIS_KEYS = [
  process.env.MORALIS_API_KEY,
  process.env.MORALIS_API_KEY_2,
  process.env.MORALIS_API_KEY_3,
  process.env.MORALIS_API_KEY_4,
  process.env.MORALIS_API_KEY_5,
].filter(Boolean);

if (MORALIS_KEYS.length === 0) {
  throw new Error("No Moralis API keys found in environment variables");
}

async function moralisFetch(path) {
  let lastError = null;
  for (let i = 0; i < MORALIS_KEYS.length; i++) {
    try {
      const res = await fetch(`${MORALIS}${path}`, {
        headers: { "X-API-Key": MORALIS_KEYS[i], Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401) {
        console.warn(`Moralis key ${i + 1} returned 401, trying next...`);
        lastError = new Error(`Key ${i + 1} unauthorized`);
        continue;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Moralis ${res.status}: ${body.message || res.statusText}`);
      }
      return res.json();
    } catch (err) {
      console.warn(`Moralis key ${i + 1} failed:`, err.message);
      lastError = err;
    }
  }
  throw new Error(`All Moralis keys exhausted: ${lastError?.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function rpcCall(to, data) {
  const res = await fetch(BNB_RPC, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    signal:  AbortSignal.timeout(8000),
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method:  "eth_call",
      params:  [{ to, data }, "latest"],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

async function batchedPromises(items, fn, batchSize = 20) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk   = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(chunk.map(fn));
    results.push(...settled);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZLT PRICE — derived from on-chain PancakeSwap V2 reserves (zero API cost)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchZLTPriceUSD() {
  try {
    const [t0_zlt, res_zlt, res_bnb_usdt, t0_bnb] = await Promise.all([
      rpcCall(LP_ZLT_BNB,  "0x0dfe1681"), // token0()
      rpcCall(LP_ZLT_BNB,  "0x0902f1ac"), // getReserves()
      rpcCall(LP_BNB_USDT, "0x0902f1ac"), // getReserves()
      rpcCall(LP_BNB_USDT, "0x0dfe1681"), // token0()
    ]);

    // ZLT/WBNB reserves
    const raw_zlt = res_zlt.slice(2);
    const r0_zlt  = BigInt("0x" + raw_zlt.slice(0, 64));
    const r1_zlt  = BigInt("0x" + raw_zlt.slice(64, 128));
    const isZLTt0 = ("0x" + t0_zlt.slice(-40)).toLowerCase() === ZLT_CONTRACT.toLowerCase();
    const resZLT  = isZLTt0 ? r0_zlt : r1_zlt;
    const resWBNB = isZLTt0 ? r1_zlt : r0_zlt;
    if (resZLT === 0n) throw new Error("ZLT reserve is zero");

    const zltInBNB = Number(resWBNB) / Number(resZLT);

    // WBNB/USDT reserves
    const isWBNBt0  = ("0x" + t0_bnb.slice(-40)).toLowerCase() === WBNB_ADDRESS.toLowerCase();
    const raw_bnb   = res_bnb_usdt.slice(2);
    const r0_bnb    = BigInt("0x" + raw_bnb.slice(0, 64));
    const r1_bnb    = BigInt("0x" + raw_bnb.slice(64, 128));
    const resWBNB2  = isWBNBt0 ? r0_bnb : r1_bnb;
    const resUSDT   = isWBNBt0 ? r1_bnb : r0_bnb;
    if (resWBNB2 === 0n) throw new Error("WBNB reserve is zero");

    const bnbInUSD    = Number(resUSDT) / Number(resWBNB2);
    const zltPriceUSD = zltInBNB * bnbInUSD;
    console.log(`[ZLT Price] BNB=$${bnbInUSD.toFixed(2)}, ZLT=$${zltPriceUSD.toFixed(8)}`);
    return zltPriceUSD;
  } catch (err) {
    console.error("[fetchZLTPriceUSD] failed:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OAT NFT HOLDERS  →  Map<address, nftCount>
// ─────────────────────────────────────────────────────────────────────────────
async function fetchOATHolders() {
  const holderCount = new Map();
  let cursor = null;
  do {
    const cp   = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await moralisFetch(
      `/nft/${OATNFT_CONTRACT}/owners?chain=${CHAIN}&format=decimal&limit=100${cp}`
    );
    if (Array.isArray(data.result)) {
      data.result.forEach(item => {
        const owner = item.owner_of.toLowerCase();
        holderCount.set(owner, (holderCount.get(owner) || 0) + 1);
      });
    }
    cursor = data.cursor || null;
  } while (cursor);
  return holderCount;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZLT TRANSFERS  →  raw Moralis transfer objects (up to 2000)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchZLTTransfers() {
  let all = [], cursor = null, page = 0;
  const MAX_PAGES = 20;
  do {
    const cp   = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await moralisFetch(
      `/erc20/${ZLT_CONTRACT}/transfers?chain=${CHAIN}&limit=100&order=DESC${cp}`
    );
    if (!Array.isArray(data.result) || data.result.length === 0) break;
    all    = all.concat(data.result);
    cursor = data.cursor || null;
    page++;
  } while (cursor && page < MAX_PAGES);
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZLT BALANCES  →  Map<address, BigInt>  (batched RPC, no Moralis CU)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchZLTBalances(addresses) {
  const unique  = [...new Set(addresses)];
  const settled = await batchedPromises(unique, async (addr) => {
    const padded   = addr.replace("0x", "").toLowerCase().padStart(64, "0");
    const result   = await rpcCall(ZLT_CONTRACT, "0x70a08231" + padded);
    return { addr, balance: BigInt(result || "0x0") };
  }, 20);

  const map = new Map();
  settled.forEach((s, i) => {
    map.set(unique[i], s.status === "fulfilled" ? s.value.balance : 0n);
  });
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL LP POSITIONS  →  Map<address, lpAmountZLT>
// Reads LP token balance per wallet, computes proportional ZLT share.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLPPositions(addresses, reserveZLT) {
  const totalSupplyHex = await rpcCall(LP_ZLT_BNB, "0x18160ddd"); // totalSupply()
  const totalSupply    = BigInt(totalSupplyHex || "0x0");
  if (totalSupply === 0n) return new Map();

  const unique  = [...new Set(addresses)];
  const settled = await batchedPromises(unique, async (addr) => {
    const padded   = addr.replace("0x", "").toLowerCase().padStart(64, "0");
    const result   = await rpcCall(LP_ZLT_BNB, "0x70a08231" + padded);
    const lpBal    = BigInt(result || "0x0");
    const zltShare = lpBal > 0n
      ? Number((lpBal * reserveZLT) / totalSupply) / 1e18
      : 0;
    return { addr, zltShare };
  }, 20);

  const map = new Map();
  settled.forEach((s, i) => {
    map.set(unique[i], s.status === "fulfilled" ? s.value.zltShare : 0);
  });
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOTAL STAKED NFTs
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTotalStaked() {
  const toNum = hex => {
    if (!hex || hex === "0x") return 0;
    try { const n = Number(BigInt(hex)); return n > 0 && n < 1_000_000 ? n : 0; }
    catch { return 0; }
  };
  const selectors = ["0x4f2bfe5b", "0x59a80d0d", "0x0b3a6a75"];
  for (const sel of selectors) {
    try { const n = toNum(await rpcCall(STAKED_CONTRACT, sel)); if (n > 0) return n; }
    catch(_) {}
  }
  try {
    const res  = await fetch(BNB_RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"eth_getStorageAt", params:[STAKED_CONTRACT,"0xe","latest"] }),
    });
    const json = await res.json();
    const n    = toNum(json.result);
    if (n > 0) return n;
  } catch(e) { console.warn("storage slot fallback failed:", e.message); }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZLT RESERVE IN LP  (reused for LP position calculation and stat card)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchZLTReserveInLP() {
  try {
    const [t0hex, resHex] = await Promise.all([
      rpcCall(LP_ZLT_BNB, "0x0dfe1681"),
      rpcCall(LP_ZLT_BNB, "0x0902f1ac"),
    ]);
    const isZLTt0 = ("0x" + t0hex.slice(-40)).toLowerCase() === ZLT_CONTRACT.toLowerCase();
    const raw     = resHex.slice(2);
    const r0      = BigInt("0x" + raw.slice(0, 64));
    const r1      = BigInt("0x" + raw.slice(64, 128));
    return isZLTt0 ? r0 : r1;
  } catch(e) {
    console.warn("fetchZLTReserveInLP failed:", e.message);
    return 0n;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZPI SCORING — INDIVIDUAL TAB SCORES (unchanged, used for tab sorting/display)
//
//   tScore = floor(TRADING_WEIGHT × volume24hUSD)
//   lScore = floor(LIQUIDITY_WEIGHT × lpValueUSD)
//   hScore = (nftCount × NFT_WEIGHT) + floor(zltBal / 100_000) × HOLD_WEIGHT
// ─────────────────────────────────────────────────────────────────────────────
function computeTabScores(w, zltPriceUSD) {
  const price = zltPriceUSD ?? 0;

  const vol24hZLT = Number(w.volume24h) / 1e18;
  const tScore    = Math.floor(TRADING_WEIGHT * vol24hZLT * price);

  const lpValueUSD = w.lpAmountZLT * price;
  const lScore     = Math.floor(LIQUIDITY_WEIGHT * lpValueUSD);

  const zltBal = Number(w.zltBalance) / 1e18;
  const hScore = (w.nftCount * NFT_WEIGHT) + (Math.floor(zltBal / 100_000) * HOLD_WEIGHT);

  return { tScore, lScore, hScore };
}

// ─────────────────────────────────────────────────────────────────────────────
// ZPI SCORING — OVERALL TAB (separate formula per spec)
//
//   TradingScore  = TradingVolumeUSD × 1020
//   LPScore       = LPVolumeUSD × 2030
//   HoldingScore  = (nftCount × 10000) + floor(ZLT / 100000) × 3050
//                   capped at 6,000,000
//   If (TradingVolumeUSD + LPVolumeUSD) < 7:
//       HoldingScore = HoldingScore × 0.3
//   OverallZPI    = TradingScore + LPScore + HoldingScore
// ─────────────────────────────────────────────────────────────────────────────
function computeOverallZPI(w, zltPriceUSD, tScore, lScore, hScoreRaw) {
  const price = zltPriceUSD ?? 0;

  const tradingVolumeUSD = (Number(w.volume24h) / 1e18) * price;
  const lpVolumeUSD      = w.lpAmountZLT * price;

  // Cap HoldingScore
  let hScore = Math.min(hScoreRaw, HOLD_CAP);

  // Low-activity penalty: wallet has <$7 combined trading+LP volume
  if ((tradingVolumeUSD + lpVolumeUSD) < ACTIVITY_FLOOR) {
    hScore = Math.floor(hScore * HOLD_PENALTY);
  }

  const zpi = tScore + lScore + hScore;
  return { zpi, hScore };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD WALLET MAP from transfers + NFT holders
// ─────────────────────────────────────────────────────────────────────────────
function buildWalletMap(transfers, oatCounts) {
  const map  = new Map();
  const now  = Date.now();
  const DAY  = 86_400_000;
  const ZERO = "0x0000000000000000000000000000000000000000";

  for (const tx of transfers) {
    const addr = tx.from_address?.toLowerCase();
    if (!addr || addr === ZERO) continue;
    const val   = BigInt(tx.value || "0");
    const is24h = (now - new Date(tx.block_timestamp).getTime()) < DAY;
    if (!map.has(addr)) {
      map.set(addr, { address: addr, volume24h: 0n, swapsCount: 0, nftCount: 0 });
    }
    const e = map.get(addr);
    e.swapsCount++;
    if (is24h) e.volume24h += val;
  }

  for (const [addr, count] of oatCounts) {
    if (!map.has(addr)) {
      map.set(addr, { address: addr, volume24h: 0n, swapsCount: 0, nftCount: count });
    } else {
      map.get(addr).nftCount = count;
    }
  }

  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // ── Phase 1: parallel independent fetches ────────────────────────────
    const [oatCounts, transfers, nftStaked, zltReserve, zltPriceUSD] =
      await Promise.all([
        fetchOATHolders(),
        fetchZLTTransfers(),
        fetchTotalStaked(),
        fetchZLTReserveInLP(),
        fetchZLTPriceUSD(),
      ]);

    if (zltPriceUSD === null) {
      console.warn("ZLT price unavailable — USD values will be zero");
    }

    // ── Phase 2: collect unique addresses ────────────────────────────────
    const walletMap = buildWalletMap(transfers, oatCounts);
    const allAddrs  = [...walletMap.keys()];

    // ── Phase 3: batched on-chain reads (zero Moralis CU) ────────────────
    const [zltBalances, lpPositions] = await Promise.all([
      fetchZLTBalances(allAddrs),
      fetchLPPositions(allAddrs, zltReserve),
    ]);

    // ── Phase 4: score every wallet ──────────────────────────────────────
    const scored = allAddrs.map(addr => {
      const w          = walletMap.get(addr);
      w.zltBalance     = (zltBalances.get(addr) ?? 0n).toString();
      w.lpAmountZLT    = lpPositions.get(addr) ?? 0;
      w.volume24h      = w.volume24h.toString();

      // Individual tab scores (unmodified formula)
      const { tScore, lScore, hScore: hScoreRaw } = computeTabScores(w, zltPriceUSD);

      // Overall ZPI (cap + activity penalty applied)
      const { zpi, hScore } = computeOverallZPI(w, zltPriceUSD, tScore, lScore, hScoreRaw);

      return {
        address:     w.address,
        volume24h:   w.volume24h,     // wei string
        swapsCount:  w.swapsCount,
        nftCount:    w.nftCount,
        zltBalance:  w.zltBalance,    // wei string
        lpAmountZLT: w.lpAmountZLT,   // plain ZLT float
        poeStaked:   w.nftCount > 0,
        zpi,        // overall score (cap + penalty applied)
        tScore,     // raw trading score  — for trading tab
        lScore,     // raw LP score       — for liquidity tab
        hScore,     // adjusted holding score (cap applied, penalty if applicable)
      };
    });

    // Sort by trading + liquidity score descending (filters out passive smart
    // contracts such as routers, vaults and staking contracts that accumulate
    // ZPI purely from holding but have zero real market activity).
    scored.sort((a, b) => (b.tScore + b.lScore) - (a.tScore + a.lScore));
    const leaderboard = scored.slice(0, 100);

    // ── Phase 5: aggregate stats ─────────────────────────────────────────
    res.setHeader("Cache-Control", "s-maxage=14400, stale-while-revalidate=3600");
    return res.status(200).json({
      success:      true,
      updatedAt:    new Date().toISOString(),
      zltPriceUSD:  zltPriceUSD ?? null,
      totalWallets: allAddrs.length,
      totalTxns:    transfers.length,
      nftStaked,
      zltInLP:      zltReserve.toString(),
      leaderboard,
    });

  } catch (err) {
    console.error("[Leaderboard API Error]", err.message, err.stack);
    return res.status(500).json({ success: false, error: err.message });
  }
}
