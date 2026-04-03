// ── CONTRACTS ─────────────────────────────────────────────────────────────────
const ZLT_CONTRACT    = "0x05D8762946fA7620b263E1e77003927addf5f7E6";
const OAT_CONTRACT    = "0x1d1C02F9fcff7EE2073a72181caE53563C82879C";
const STAKED_CONTRACT = "0xa40984640D83230EE6Fa1d912E2030f8485b9eFc";
const LP_CONTRACT     = "0xAb168a06623eDe1b6b590733952cca4d7123f1F5";

const CHAIN    = "0x38";
const BASE_URL = "https://deep-index.moralis.io/api/v2.2";
const BNB_RPC  = "https://bsc-dataseed.binance.org/";

// ── SCORING (aligned with frontend ZPI: poeBonus = 400) ──────────────────────
function computePoints(volume24h, swapsCount, poeStaked) {
  const volumePoints = Math.floor(volume24h / 1e18 / 100) * 5;
  const swapPoints   = swapsCount * 5;
  const poeBonus     = poeStaked ? 400 : 0;   // ✅ changed from 500 to 400
  return volumePoints + swapPoints + poeBonus;
}

// ── MORALIS FETCH WRAPPER ─────────────────────────────────────────────────
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

// ── FETCH: OAT NFT holders (address -> count) ───────────────────────────────
async function fetchOATHolders() {
  const holderCount = new Map();
  let cursor = null;
  do {
    const cp = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await moralisFetch(
      `/nft/${OAT_CONTRACT}/owners?chain=${CHAIN}&format=decimal&limit=100${cp}`
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

// ── FETCH: ZLT transfers (up to 500) ────────────────────────────────────────
async function fetchZLTTransfers() {
  let all = [], cursor = null, page = 0;
  const MAX_PAGES = 5;
  do {
    const cp = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await moralisFetch(
      `/erc20/${ZLT_CONTRACT}/transfers?chain=${CHAIN}&limit=100&order=DESC${cp}`
    );
    if (!Array.isArray(data.result) || data.result.length === 0) break;
    all = all.concat(data.result);
    cursor = data.cursor || null;
    page++;
  } while (cursor && page < MAX_PAGES);
  return all;
}

// ── FETCH: ZLT balance for a list of addresses ──────────────────────────────
async function fetchZLTBalances(addresses) {
  const unique = [...new Set(addresses)];
  const results = await Promise.all(
    unique.map(async (addr) => {
      try {
        const data = await moralisFetch(
          `/erc20/${ZLT_CONTRACT}/balance?chain=${CHAIN}&address=${addr}`
        );
        return { address: addr, balance: data.balance || "0" };
      } catch {
        return { address: addr, balance: "0" };
      }
    })
  );
  const balanceMap = new Map();
  results.forEach(r => balanceMap.set(r.address, BigInt(r.balance)));
  return balanceMap;
}

// ── FETCH: Total staked NFTs via RPC (storage slot 0xe) ─────────────────────
async function fetchTotalStaked() {
  const hexToNumber = (hex) => { if (!hex || hex === "0x") return 0; try { return Number(BigInt(hex)); } catch { return 0; } };
  try {
    const res = await fetch(BNB_RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: STAKED_CONTRACT, data: "0x4f2bfe5b" }, "latest"] })
    });
    const json = await res.json();
    if (!json.error && json.result) { const val = hexToNumber(json.result); if (val > 0 && val < 1_000_000) return val; }
  } catch(e) { console.warn("totalStaked function failed", e.message); }
  try {
    const res = await fetch(BNB_RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getStorageAt", params: [STAKED_CONTRACT, "0xe", "latest"] })
    });
    const json = await res.json();
    if (!json.error && json.result) { const val = hexToNumber(json.result); if (val > 0 && val < 1_000_000) return val; }
  } catch(e) { console.warn("storage slot failed", e.message); }
  return 0;
}

// ── FETCH: ZLT in LP (reserve from pair) ───────────────────────────────────
async function fetchZLTInLP() {
  try {
    async function rpcCall(to, data) {
      const res = await fetch(BNB_RPC, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] })
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    }
    const [hex0, hex1] = await Promise.all([ rpcCall(LP_CONTRACT, "0x0dfe1681"), rpcCall(LP_CONTRACT, "0xd21220a7") ]);
    const token0 = ("0x" + hex0.slice(-40)).toLowerCase();
    const token1 = ("0x" + hex1.slice(-40)).toLowerCase();
    const zlt = ZLT_CONTRACT.toLowerCase();
    const hexReserves = await rpcCall(LP_CONTRACT, "0x0902f1ac");
    const raw = hexReserves.slice(2);
    const reserve0 = BigInt("0x" + raw.slice(0, 64));
    const reserve1 = BigInt("0x" + raw.slice(64, 128));
    if (token0 === zlt) return reserve0.toString();
    if (token1 === zlt) return reserve1.toString();
    return "0";
  } catch(e) { console.warn("fetchZLTInLP failed", e.message); return "0"; }
}

// ── FETCH: LP amount for a list of addresses (placeholder) ──────────────────
// TODO: replace with real on‑chain reads from staking contract
async function fetchLPAmounts(addresses) {
  const map = new Map();
  addresses.forEach(addr => {
    const hash = parseInt(addr.slice(-8), 16);
    const lpAmount = (hash % 50000) + 1000;
    map.set(addr, lpAmount);
  });
  return map;
}

// ── PROCESS: Build enriched wallet data ─────────────────────────────────────
function processData(transfers, oatCounts, zltBalances, lpAmounts) {
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
      map.set(addr, {
        address: addr,
        volume24h: 0,
        totalVolume: 0,
        swapsCount: 0,
        poeStaked: false,
        nftCount: 0,
        zltBalance: 0n,
        lpAmount: 0
      });
    }
    const entry = map.get(addr);
    entry.swapsCount++;
    entry.totalVolume += val;
    if (is24h) entry.volume24h += val;
  }

  for (const [addr, count] of oatCounts.entries()) {
    if (!map.has(addr)) {
      map.set(addr, {
        address: addr,
        volume24h: 0,
        totalVolume: 0,
        swapsCount: 0,
        poeStaked: true,
        nftCount: count,
        zltBalance: 0n,
        lpAmount: 0
      });
    } else {
      map.get(addr).poeStaked = true;
      map.get(addr).nftCount = count;
    }
  }

  for (const [addr, entry] of map.entries()) {
    entry.zltBalance = zltBalances.get(addr) || 0n;
    entry.lpAmount = lpAmounts.get(addr) || 0;
    if (!entry.nftCount && oatCounts.has(addr)) entry.nftCount = oatCounts.get(addr);
  }

  const wallets = Array.from(map.values());
  for (const w of wallets) {
    w.points = computePoints(w.volume24h, w.swapsCount, w.poeStaked);
  }
  wallets.sort((a,b) => b.points - a.points);
  return wallets.slice(0, 50).map(w => ({
    rank: 0,
    address: w.address,
    volume24h: w.volume24h,
    swapsCount: w.swapsCount,
    poeStaked: w.poeStaked,
    points: w.points,
    nftCount: w.nftCount,
    zltBalance: w.zltBalance.toString(),
    lpAmount: w.lpAmount
  }));
}

// ── HANDLER ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!process.env.MORALIS_API_KEY) {
    return res.status(500).json({ success: false, error: "MORALIS_API_KEY missing" });
  }

  try {
    const [oatCounts, transfers, nftStaked, zltInLP] = await Promise.all([
      fetchOATHolders(),
      fetchZLTTransfers(),
      fetchTotalStaked(),
      fetchZLTInLP()
    ]);

    const allAddresses = new Set();
    for (const tx of transfers) {
      const addr = tx.from_address?.toLowerCase();
      if (addr && addr !== "0x0000000000000000000000000000000000000000") allAddresses.add(addr);
    }
    for (const addr of oatCounts.keys()) allAddresses.add(addr);

    const [zltBalances, lpAmounts] = await Promise.all([
      fetchZLTBalances([...allAddresses]),
      fetchLPAmounts([...allAddresses])
    ]);

    const leaderboard = processData(transfers, oatCounts, zltBalances, lpAmounts);
    const totalWallets = leaderboard.length;
    const totalTxns = transfers.length;

    res.setHeader("Cache-Control", "s-maxage=14400, stale-while-revalidate=3600");
    return res.status(200).json({
      success: true,
      updatedAt: new Date().toISOString(),
      totalWallets,
      totalTxns,
      nftStaked,
      zltInLP,
      leaderboard
    });
  } catch (err) {
    console.error("[Leaderboard API Error]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
