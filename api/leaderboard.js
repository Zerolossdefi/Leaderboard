// ─────────────────────────────────────────────────────────────────────────────
// CONTRACTS
// ─────────────────────────────────────────────────────────────────────────────
const ZLT_CONTRACT    = "0x05D8762946fA7620b263E1e77003927addf5f7E6";
const OATNFT_CONTRACT = "0x1d1C02F9fcff7EE2073a72181caE53563C82879C";
const STAKED_CONTRACT = "0xa40984640D83230EE6Fa1d912E2030f8485b9eFc";
const LP_ZLT_USDT     = "0x9aa4073cc0e86508ce18788cdf0e6b6b46677b8d"; // ZLT/USDT PancakeSwap V2 — used for scoring + stat card
const LP_ZLT_BNB      = "0xAb168a06623eDe1b6b590733952cca4d7123f1F5"; // ZLT/BNB  PancakeSwap V2 — stat card only (not used for scoring)

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
    // 429 exponential backoff: retry same key up to 4 times (1s, 2s, 4s, capped at 10s)
    // before rotating to the next key.
    let backoff = 1000;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${MORALIS}${path}`, {
          headers: { "X-API-Key": MORALIS_KEYS[i], Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });
        if (res.status === 429) {
          console.warn(`Moralis key ${i + 1} rate-limited (attempt ${attempt + 1}), waiting ${backoff}ms...`);
          await new Promise(r => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 10000);
          continue; // retry same key
        }
        if (res.status === 401) {
          console.warn(`Moralis key ${i + 1} returned 401, trying next...`);
          lastError = new Error(`Key ${i + 1} unauthorized`);
          break; // rotate to next key immediately
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(`Moralis ${res.status}: ${body.message || res.statusText}`);
        }
        return res.json();
      } catch (err) {
        // Only break the backoff loop for non-429 errors (fetch/timeout)
        if (err.message && err.message.startsWith("Moralis ")) throw err; // propagate non-retriable errors
        console.warn(`Moralis key ${i + 1} attempt ${attempt + 1} failed:`, err.message);
        lastError = err;
        break; // rotate key on network/timeout errors
      }
    }
    // If we exhausted backoff retries on 429, record and rotate
    if (!lastError || lastError.message !== `Key ${i + 1} unauthorized`) {
      lastError = new Error(`Key ${i + 1} rate-limited after retries`);
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
// ZLT PRICE — derived from on-chain ZLT/USDT PancakeSwap V2 reserves
// Direct single-hop: ZLT reserve / USDT reserve gives price in USD.
// USDT has 18 decimals on BSC (same as ZLT), so no decimal adjustment needed.
// FIX 4 + FIX 6: Use safe BigInt scaling to avoid precision loss on large
// reserves; throw on failure instead of returning 0 (API runs every 4h).
// ─────────────────────────────────────────────────────────────────────────────
async function fetchZLTPriceUSD() {
  const [t0hex, resHex] = await Promise.all([
    rpcCall(LP_ZLT_USDT, "0x0dfe1681"), // token0()
    rpcCall(LP_ZLT_USDT, "0x0902f1ac"), // getReserves()
  ]);

  const isZLTt0 = ("0x" + t0hex.slice(-40)).toLowerCase() === ZLT_CONTRACT.toLowerCase();
  const raw     = resHex.slice(2);
  const r0      = BigInt("0x" + raw.slice(0, 64));
  const r1      = BigInt("0x" + raw.slice(64, 128));

  const resZLT  = isZLTt0 ? r0 : r1;
  const resUSDT = isZLTt0 ? r1 : r0;

  if (resZLT === 0n) throw new Error("ZLT reserve is zero — cannot compute price");

  // FIX 4: Multiply USDT side by 1e10 before integer division to preserve
  // 10 decimal places of precision, then scale back. Both tokens are 18 dec.
  const SCALE       = 10_000_000_000n; // 1e10
  const zltPriceUSD = Number((resUSDT * SCALE) / resZLT) / 1e10;
  console.log(`[ZLT Price] $${zltPriceUSD.toFixed(8)} (ZLT/USDT pair)`);
  return zltPriceUSD;
  // FIX 6: No try/catch — caller receives the thrown error and returns 500.
  // A stale/zero price must never silently corrupt scoring.
}

// ─────────────────────────────────────────────────────────────────────────────
// OAT NFT HOLDERS  →  Map<address, nftCount>
// FIX 1: Use item.amount (parseInt, fallback to 1) instead of fixed +1.
// Moralis returns amount for both ERC-721 and ERC-1155; respects true balance.
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
        const owner  = item.owner_of.toLowerCase();
        // FIX 1: use item.amount with parseInt; fallback to 1 if missing/NaN
        const amount = parseInt(item.amount, 10) || 1;
        holderCount.set(owner, (holderCount.get(owner) || 0) + amount);
      });
    }
    cursor = data.cursor || null;
  } while (cursor);
  return holderCount;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZLT TRANSFERS  →  raw Moralis transfer objects (for totalTxns count only)
// FIX 7: MAX_PAGES increased from 20 → 300 (up to 30,000 transfers).
// Transfers fetch is kept intact because transfers.length = totalTxns.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchZLTTransfers() {
  let all = [], cursor = null, page = 0;
  const MAX_PAGES = 300; // FIX 7: was 20; now fetches up to 30,000 transfers
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
// SWAP EVENT FETCHER  →  Map<address, { volume24h: BigInt, swapsCount: number }>
// FIX 2: Replace raw ERC-20 transfers with PancakeSwap V2 Swap events for
// accurate buy-side detection. Fetches from both LP_ZLT_USDT and LP_ZLT_BNB.
//
// Swap(address indexed sender, uint256 amount0In, uint256 amount1In,
//      uint256 amount0Out, uint256 amount1Out, address indexed to)
// topic0: 0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822
//
// A buy = the `to` address receives ZLT as output (amountZLTOut > 0).
// ZLT side determined per-pair using token0() (cached once per pair).
// Only buys within the last 24h count toward volume24h and swapsCount.
// ─────────────────────────────────────────────────────────────────────────────
const SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

// Cache token0 results so we only call RPC once per pair per handler invocation
const token0Cache = new Map();

async function getPairIsZLTToken0(pairAddr) {
  if (token0Cache.has(pairAddr)) return token0Cache.get(pairAddr);
  const t0hex  = await rpcCall(pairAddr, "0x0dfe1681"); // token0()
  const isZLT0 = ("0x" + t0hex.slice(-40)).toLowerCase() === ZLT_CONTRACT.toLowerCase();
  token0Cache.set(pairAddr, isZLT0);
  return isZLT0;
}

async function fetchSwapBuys() {
  const now     = Math.floor(Date.now() / 1000);
  const cutoff  = now - 86_400; // 24h ago (unix seconds)

  // Resolve current block to anchor fromBlock for ~24h window (~28800 blocks)
  const blockHex = await (async () => {
    const r = await fetch(BNB_RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    const j = await r.json();
    return j.result; // hex string
  })();
  const latestBlock  = parseInt(blockHex, 16);
  const fromBlock    = "0x" + (latestBlock - 28_800).toString(16);

  // FIX 2: Fetch Swap logs from both pairs
  const pairs = [LP_ZLT_USDT, LP_ZLT_BNB];

  // Fetch token0 flags for both pairs in parallel (cached)
  const [isZLT0_USDT, isZLT0_BNB] = await Promise.all([
    getPairIsZLTToken0(LP_ZLT_USDT),
    getPairIsZLTToken0(LP_ZLT_BNB),
  ]);
  const isZLT0Map = new Map([
    [LP_ZLT_USDT.toLowerCase(), isZLT0_USDT],
    [LP_ZLT_BNB.toLowerCase(),  isZLT0_BNB],
  ]);

  // eth_getLogs per pair (BSC node handles up to 5000 results per call)
  async function getLogsForPair(pairAddr) {
    const r = await fetch(BNB_RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getLogs",
        params: [{
          fromBlock,
          toBlock: "latest",
          address: pairAddr,
          topics: [SWAP_TOPIC],
        }],
      }),
    });
    const j = await r.json();
    if (j.error) {
      console.warn(`[eth_getLogs] ${pairAddr}: ${j.error.message}`);
      return [];
    }
    return j.result || [];
  }

  const [logsUSDT, logsBNB] = await Promise.allSettled([
    getLogsForPair(LP_ZLT_USDT),
    getLogsForPair(LP_ZLT_BNB),
  ]);

  // Collect all logs from both pairs
  const allLogs = [];
  if (logsUSDT.status === "fulfilled") {
    (logsUSDT.value || []).forEach(log => allLogs.push({ log, pairAddr: LP_ZLT_USDT }));
  } else {
    console.warn("[SwapBuys] LP_ZLT_USDT logs failed:", logsUSDT.reason?.message);
  }
  if (logsBNB.status === "fulfilled") {
    (logsBNB.value || []).forEach(log => allLogs.push({ log, pairAddr: LP_ZLT_BNB }));
  } else {
    console.warn("[SwapBuys] LP_ZLT_BNB logs failed:", logsBNB.reason?.message);
  }

  // Collect unique block numbers from all logs, then batch-fetch their timestamps
  const uniqueBlockHexes = [...new Set(allLogs.map(({ log }) => log.blockNumber).filter(Boolean))];

  async function fetchBlockTimestamp(blockHex) {
    const r = await fetch(BNB_RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber",
        params: [blockHex, false],
      }),
    });
    const j = await r.json();
    if (j.error || !j.result) return null;
    return parseInt(j.result.timestamp, 16);
  }

  // Fetch timestamps in batches of 20 (pure RPC, 0 Moralis CU)
  const blockTsMap = new Map(); // Map<blockHex, unixTimestamp>
  const blockBatchSize = 20;
  for (let i = 0; i < uniqueBlockHexes.length; i += blockBatchSize) {
    const chunk = uniqueBlockHexes.slice(i, i + blockBatchSize);
    const results = await Promise.allSettled(chunk.map(bh => fetchBlockTimestamp(bh)));
    results.forEach((res, idx) => {
      if (res.status === "fulfilled" && res.value !== null) {
        blockTsMap.set(chunk[idx], res.value);
      }
    });
  }

  // Map: address → { volume24h: BigInt, swapsCount: number }
  const buyMap = new Map();

  // Process all logs using the blockTsMap we fetched above
  allLogs.forEach(({ log, pairAddr }) => {
    const isZLT0 = isZLT0Map.get(pairAddr.toLowerCase());
    const data = log.data.slice(2);
    if (data.length < 256) return;

    const amount0In  = BigInt("0x" + data.slice(0,   64));
    const amount1In  = BigInt("0x" + data.slice(64,  128));
    const amount0Out = BigInt("0x" + data.slice(128, 192));
    const amount1Out = BigInt("0x" + data.slice(192, 256));

    const zltOut = isZLT0 ? amount0Out : amount1Out;
    if (zltOut === 0n) return;

    if (!log.topics[2]) return;
    const to = "0x" + log.topics[2].slice(26);

    const blockTs = blockTsMap.has(log.blockNumber)
      ? blockTsMap.get(log.blockNumber)
      : cutoff;
    const is24h = blockTs >= cutoff;

    if (!buyMap.has(to)) {
      buyMap.set(to, { volume24h: 0n, swapsCount: 0 });
    }
    if (is24h) {
      const e = buyMap.get(to);
      e.volume24h  += zltOut;
      e.swapsCount += 1;
    }
  });

  return buyMap;
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
// Reads LP token balance per wallet from the ZLT/USDT pair,
// computes proportional ZLT share from the pool reserves.
// FIX 4: Use safe BigInt scaling (multiply by 1e10) before dividing to avoid
// precision loss when lpBal * reserveZLT overflows Number safely.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLPPositions(addresses) {
  const [totalSupplyHex, t0hex, resHex] = await Promise.all([
    rpcCall(LP_ZLT_USDT, "0x18160ddd"), // totalSupply()
    rpcCall(LP_ZLT_USDT, "0x0dfe1681"), // token0()
    rpcCall(LP_ZLT_USDT, "0x0902f1ac"), // getReserves()
  ]);

  const totalSupply = BigInt(totalSupplyHex || "0x0");
  if (totalSupply === 0n) return new Map();

  const isZLTt0    = ("0x" + t0hex.slice(-40)).toLowerCase() === ZLT_CONTRACT.toLowerCase();
  const raw        = resHex.slice(2);
  const r0         = BigInt("0x" + raw.slice(0, 64));
  const r1         = BigInt("0x" + raw.slice(64, 128));
  const reserveZLT = isZLTt0 ? r0 : r1;

  const unique  = [...new Set(addresses)];
  const settled = await batchedPromises(unique, async (addr) => {
    const padded = addr.replace("0x", "").toLowerCase().padStart(64, "0");
    const result = await rpcCall(LP_ZLT_USDT, "0x70a08231" + padded);
    const lpBal  = BigInt(result || "0x0");
    let zltShare = 0;
    if (lpBal > 0n) {
      // FIX 4: scale by 1e10 first to preserve 10 decimal digits of precision
      // before converting BigInt → Number, then divide out the scale factor.
      const SCALE  = 10_000_000_000n; // 1e10
      const scaled = (lpBal * reserveZLT * SCALE) / totalSupply;
      zltShare     = Number(scaled) / 1e10 / 1e18; // 1e18 = ZLT decimals
    }
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
// FIX 8: Use correct selector 0x817a5e53 (totalStaked() view) directly.
// Removed brute-force selector loop and storage-slot fallback.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTotalStaked() {
  try {
    // getMainPoolInfo() selector: 0x5b9f6f7a
    const result = await rpcCall(STAKED_CONTRACT, "0x5b9f6f7a");
    if (!result || result === "0x") return 0;

    // Decode the second uint256 (total staked NFTs)
    const raw = result.slice(2); // remove '0x'
    if (raw.length < 128) return 0;
    const totalStakedHex = "0x" + raw.slice(64, 128);
    const n = Number(BigInt(totalStakedHex));

    // Sanity cap (adjust if needed, but 1M is safe for this contract)
    return (n > 0 && n < 1_000_000) ? n : 0;
  } catch (err) {
    console.error("[fetchTotalStaked] failed:", err.message);
    return 0;
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// ZLT RESERVE IN LP  —  STAT CARD TOTAL (both pairs combined)
// Returns the sum of ZLT reserves from ZLT/USDT + ZLT/BNB pairs.
// This is display-only; LP scoring still uses ZLT/USDT only (fetchLPPositions).
// ─────────────────────────────────────────────────────────────────────────────
async function fetchZLTReserveInLP() {
  // Helper: extract ZLT reserve from any pair given its address
  async function getZLTReserve(pairAddr) {
    const [t0hex, resHex] = await Promise.all([
      rpcCall(pairAddr, "0x0dfe1681"), // token0()
      rpcCall(pairAddr, "0x0902f1ac"), // getReserves()
    ]);
    const isZLTt0 = ("0x" + t0hex.slice(-40)).toLowerCase() === ZLT_CONTRACT.toLowerCase();
    const raw     = resHex.slice(2);
    const r0      = BigInt("0x" + raw.slice(0, 64));
    const r1      = BigInt("0x" + raw.slice(64, 128));
    return isZLTt0 ? r0 : r1;
  }

  // Fetch both pairs in parallel; fall back to 0n if either fails
  const [resUsdt, resBnb] = await Promise.allSettled([
    getZLTReserve(LP_ZLT_USDT),
    getZLTReserve(LP_ZLT_BNB),
  ]);

  const zltUsdt = resUsdt.status === "fulfilled" ? resUsdt.value : 0n;
  const zltBnb  = resBnb.status  === "fulfilled" ? resBnb.value  : 0n;

  if (resUsdt.status === "rejected") console.warn("ZLT/USDT reserve failed:", resUsdt.reason?.message);
  if (resBnb.status  === "rejected") console.warn("ZLT/BNB reserve failed:",  resBnb.reason?.message);

  return zltUsdt + zltBnb; // combined total shown on stat card
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
// BUILD WALLET MAP from transfers (for totalTxns count) + NFT holders
// FIX 3: Wallets seeded here start with volume24h=0n, swapsCount=0.
// Swap event data is merged in the handler — holders/LP-only wallets
// are never zeroed out; they simply keep their initial zero trading fields.
// ─────────────────────────────────────────────────────────────────────────────
function buildWalletMap(transfers, oatCounts) {
  const map  = new Map();
  const ZERO = "0x0000000000000000000000000000000000000000";

  // Seed unique sender addresses from transfers (volume/swaps filled by swap events)
  for (const tx of transfers) {
    const addr = tx.from_address?.toLowerCase();
    if (!addr || addr === ZERO) continue;
    if (!map.has(addr)) {
      // FIX 3: volume24h and swapsCount start at zero; swap events layer on top
      map.set(addr, { address: addr, volume24h: 0n, swapsCount: 0, nftCount: 0 });
    }
  }

  // Seed NFT holders — may add wallets not in transfers
  for (const [addr, count] of oatCounts) {
    if (!map.has(addr)) {
      // FIX 3: NFT-only wallets get zero trading fields — they still appear
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
    // FIX 6: fetchZLTPriceUSD now throws on failure — no null fallback.
    // FIX 2: fetchSwapBuys replaces transfer-based trading data.
    const [oatCounts, transfers, swapBuys, nftStaked, zltReserve, zltPriceUSD] =
      await Promise.all([
        fetchOATHolders(),
        fetchZLTTransfers(),   // kept for totalTxns count (FIX 7)
        fetchSwapBuys(),       // FIX 2: Swap event buys from both pairs
        fetchTotalStaked(),
        fetchZLTReserveInLP(),
        fetchZLTPriceUSD(),    // FIX 6: throws on failure
      ]);

    // ── Phase 2: build wallet map (seeds all known addresses) ────────────
    const walletMap = buildWalletMap(transfers, oatCounts);

    // FIX 2 + FIX 3: Merge swap buy data into walletMap.
    // Wallets that bought ZLT get their volume24h/swapsCount populated.
    // Wallets that only hold/LP/NFT keep volume24h=0n, swapsCount=0 — never dropped.
    for (const [addr, data] of swapBuys) {
      if (!walletMap.has(addr)) {
        walletMap.set(addr, { address: addr, volume24h: data.volume24h, swapsCount: data.swapsCount, nftCount: 0 });
      } else {
        const w = walletMap.get(addr);
        w.volume24h  = data.volume24h;  // BigInt — replace (swap events are source of truth)
        w.swapsCount = data.swapsCount;
      }
    }

    const allAddrs = [...walletMap.keys()];

    // ── Phase 3: batched on-chain reads (zero Moralis CU) ────────────────
    const [zltBalances, lpPositions] = await Promise.all([
      fetchZLTBalances(allAddrs),
      fetchLPPositions(allAddrs),
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
        volume24h:   w.volume24h,     // wei string (ZLT bought in last 24h)
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

    // Sort by trading + liquidity score descending
    scored.sort((a, b) => (b.tScore + b.lScore) - (a.tScore + a.lScore));
    const leaderboard = scored.slice(0, 100);

    // ── Phase 5: compute activeWallets ───────────────────────────────────
    // FIX 5: Count wallets where ZLT balance > 0 OR NFT count > 0 OR LP > 0
    const activeWallets = scored.filter(w =>
      BigInt(w.zltBalance) > 0n || w.nftCount > 0 || w.lpAmountZLT > 0
    ).length;

    // ── Phase 6: aggregate stats ─────────────────────────────────────────
    res.setHeader("Cache-Control", "s-maxage=14400, stale-while-revalidate=3600");
    return res.status(200).json({
      success:       true,
      updatedAt:     new Date().toISOString(),
      zltPriceUSD,
      totalWallets:  allAddrs.length,
      totalTxns:     transfers.length, // FIX 7: kept — raw transfer count
      activeWallets,                   // FIX 5: wallets with any on-chain presence
      nftStaked,
      zltInLP:       zltReserve.toString(),
      leaderboard,
    });

  } catch (err) {
    console.error("[Leaderboard API Error]", err.message, err.stack);
    return res.status(500).json({ success: false, error: err.message });
  }
}
