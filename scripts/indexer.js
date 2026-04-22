// =============================================================================
// ZPI Indexer – scripts/indexer.js
// $0 infrastructure: dRPC + Lava Network RPC + Moralis NFT + Supabase
// =============================================================================

import { createClient }                        from '@supabase/supabase-js';
import { createPublicClient, custom, parseAbiItem } from 'viem';
import { bsc }                                 from 'viem/chains';
import 'dotenv/config';

// =============================================================================
// CONFIG
// =============================================================================
const ZLT          = '0x05D8762946fA7620b263E1e77003927addf5f7E6';
const LP_ZLT_USDT  = '0x9aa4073cc0e86508ce18788cdf0e6b6b46677b8d';
const OAT_NFT      = '0x1d1C02F9fcff7EE2073a72181caE53563C82879C';

const SCALE        = 10n ** 12n;   // price precision scaler
const WEI          = 10n ** 18n;   // 1 ether in wei

const MAX_LOG_RANGE   = 2_000n;    // blocks per getLogs chunk
const RPC_BATCH_SIZE  = 5;         // parallel readContract calls per batch (reduced to avoid 429)
const DB_BATCH_SIZE   = 100;       // rows per supabase upsert
const LOG_BATCH_SIZE  = 500;       // rows per transfer_logs insert
const RPC_RETRIES     = 4;         // max retries per RPC call
const RPC_DELAY_MS    = 300;       // base delay for exponential backoff
const CHUNK_DELAY_MS  = 150;       // delay between getLogs chunks
const BATCH_DELAY_MS  = 300;       // delay between each batchRead batch

// How far back to start on first run (7 days of BSC blocks @ ~3s/block)
// Updated dynamically at runtime; this is just a safety fallback
const LOOKBACK_BLOCKS = 201_600n;  // 7 days

// Score weights (integer math only — no floats anywhere)
const W_TRADE  = 1_020n;
const W_LP     = 2_030n;
const W_NFT    = 10_000n;
const W_BAL    = 3_050n;
const H_CAP    = 6_000_000n;
const ACTIVITY_THRESHOLD_USD = 7n;

// =============================================================================
// ENV VALIDATION
// =============================================================================
const REQUIRED_ENVS = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'MORALIS_KEYS',
    'DRPC_URL',
    'LAVA_URL',
];
for (const key of REQUIRED_ENVS) {
    if (!process.env[key]?.trim()) {
        throw new Error(`Missing required env var: ${key}`);
    }
}

const moralisKeys = process.env.MORALIS_KEYS.split(',').map(k => k.trim()).filter(Boolean);
if (moralisKeys.length === 0) throw new Error('MORALIS_KEYS is empty after parsing');

// RPC endpoints — dRPC primary, Lava Network fallback
const RPC_URLS = [
    process.env.DRPC_URL.trim(),   // e.g. https://lb.drpc.org/ogrpc?network=bsc&dkey=YOUR_KEY
    process.env.LAVA_URL.trim(),   // e.g. https://bsc.lava.build/YOUR_KEY
];

// =============================================================================
// CLIENTS
// =============================================================================
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Custom transport — tries dRPC first, falls back to Lava Network automatically.
// Works as a drop-in for viem's createPublicClient so all existing
// withRetry(() => rpc.readContract(...)) calls stay unchanged.
let rpcIndex = 0;

function customTransport(urls) {
    return custom({
        async request({ method, params }) {
            // Try each URL once before giving up
            for (let attempt = 0; attempt < urls.length; attempt++) {
                const url = urls[rpcIndex];
                try {
                    const res = await fetch(url, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const json = await res.json();
                    if (json.error) throw new Error(json.error.message);
                    return json.result;
                } catch (err) {
                    console.warn(`[rpc] ${url} failed: ${err.message} — switching endpoint`);
                    rpcIndex = (rpcIndex + 1) % urls.length;
                }
            }
            throw new Error('All RPC endpoints failed');
        },
    });
}

const rpc = createPublicClient({
    chain: bsc,
    transport: customTransport(RPC_URLS),
});

// =============================================================================
// UTILITIES
// =============================================================================

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Retry wrapper with exponential backoff.
 * Handles transient RPC failures gracefully.
 */
async function withRetry(fn, label = 'rpc') {
    for (let attempt = 0; attempt < RPC_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLast = attempt === RPC_RETRIES - 1;
            if (isLast) throw err;
            const delay = RPC_DELAY_MS * 2 ** attempt;
            console.warn(`[retry] ${label} failed (attempt ${attempt + 1}/${RPC_RETRIES}), retrying in ${delay}ms — ${err.message}`);
            await sleep(delay);
        }
    }
}

/**
 * Build minimal ABI fragments for readContract calls.
 */
function makeAbi(name, inputs, outputs) {
    return [{
        name,
        type: 'function',
        stateMutability: 'view',
        inputs:  inputs.map((type, i) => ({ name: `i${i}`, type })),
        outputs: outputs.map((type, i) => ({ name: `o${i}`, type })),
    }];
}

// Pre-built ABIs
const ABI = {
    balanceOf:   makeAbi('balanceOf',   ['address'], ['uint256']),
    totalSupply: makeAbi('totalSupply', [],           ['uint256']),
    token0:      makeAbi('token0',      [],           ['address']),
    getReserves: [{
        name: 'getReserves', type: 'function', stateMutability: 'view',
        inputs: [],
        outputs: [
            { name: '_reserve0',          type: 'uint112' },
            { name: '_reserve1',          type: 'uint112' },
            { name: '_blockTimestampLast', type: 'uint32'  },
        ],
    }],
};

/**
 * Batch readContract calls with concurrency control.
 * Returns 0n for any individual call that fails (safe for BigInt math).
 */
async function batchRead(contract, abi, functionName, argsList) {
    const results = [];
    for (let i = 0; i < argsList.length; i += RPC_BATCH_SIZE) {
        const batch = argsList.slice(i, i + RPC_BATCH_SIZE);
        const settled = await Promise.allSettled(
            batch.map(args =>
                withRetry(
                    () => rpc.readContract({ address: contract, abi, functionName, args }),
                    `${functionName}(${args[0]})`
                )
            )
        );
        for (const r of settled) {
            if (r.status === 'fulfilled') results.push(BigInt(r.value));
            else {
                console.error(`[batchRead] ${functionName} failed:`, r.reason?.message);
                results.push(0n);
            }
        }
        await sleep(BATCH_DELAY_MS); // rate-limit protection between batches
    }
    return results;
}
    return results;
}

// =============================================================================
// MORALIS – NFT OWNER FETCH (PAGINATED)
// =============================================================================

/**
 * Rotates through up to 3 Moralis API keys.
 * Throws only if ALL keys fail for the same request.
 */
async function moralisFetch(path) {
    for (const key of moralisKeys) {
        try {
            const res = await fetch(`https://deep-index.moralis.io/api/v2.2${path}`, {
                headers: { 'X-API-Key': key },
            });
            if (res.status === 200) return await res.json();
            if (res.status === 401) { console.warn('[moralis] 401 on key, rotating...'); continue; }
            throw new Error(`Moralis HTTP ${res.status}`);
        } catch (err) {
            console.warn(`[moralis] key failed: ${err.message}, rotating...`);
        }
    }
    throw new Error('All Moralis keys exhausted');
}

/**
 * Fetches ALL pages of NFT owners using cursor pagination.
 * Returns Map<address, count>.
 */
async function fetchNFTOwners(contractAddress) {
    console.log('[moralis] Fetching NFT owners (all pages)...');
    const ownerMap = new Map();
    let cursor     = null;
    let page       = 0;

    do {
        const qs  = `chain=bsc&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const data = await moralisFetch(`/nft/${contractAddress}/owners?${qs}`);
        if (!data?.result?.length) break;

        for (const nft of data.result) {
            const owner = nft.owner_of.toLowerCase();
            ownerMap.set(owner, (ownerMap.get(owner) || 0) + 1);
        }

        cursor = data.cursor ?? null;
        page++;
        console.log(`[moralis] Page ${page}: ${data.result.length} NFTs, cursor: ${cursor ? 'yes' : 'end'}`);
    } while (cursor);

    console.log(`[moralis] Total: ${ownerMap.size} unique holders across ${page} pages`);
    return ownerMap;
}

// =============================================================================
// BLOCKCHAIN – CHUNKED getLogs
// =============================================================================

const TRANSFER_EVENT = parseAbiItem(
    'event Transfer(address indexed from, address indexed to, uint256 value)'
);

/**
 * Fetches Transfer logs in safe 2000-block chunks.
 * Adds a short delay between chunks to respect ANKR rate limits.
 */
async function getLogsChunked(fromBlock, toBlock) {
    console.log(`[logs] Fetching [${fromBlock} → ${toBlock}] in ${MAX_LOG_RANGE}-block chunks...`);
    const allLogs = [];
    let start     = fromBlock;
    let chunk     = 0;

    while (start <= toBlock) {
        const end = start + MAX_LOG_RANGE - 1n <= toBlock
            ? start + MAX_LOG_RANGE - 1n
            : toBlock;

        const logs = await withRetry(
            () => rpc.getLogs({ address: ZLT, event: TRANSFER_EVENT, fromBlock: start, toBlock: end }),
            `getLogs[${start}-${end}]`
        );

        allLogs.push(...logs);
        chunk++;

        if (chunk % 10 === 0) {
            console.log(`[logs] Chunk ${chunk}: processed up to block ${end}, total logs: ${allLogs.length}`);
        }

        start = end + 1n;
        if (start <= toBlock) await sleep(CHUNK_DELAY_MS);
    }

    console.log(`[logs] Done — ${allLogs.length} Transfer events in ${chunk} chunks`);
    return allLogs;
}

// =============================================================================
// PRICE – ZLT/USDT from LP reserves
// =============================================================================

/**
 * Returns priceScaled = (reserveUSDT * SCALE) / reserveZLT
 * All math stays in BigInt.
 */
async function getZLTPriceScaled() {
    const [reserves, token0Addr] = await Promise.all([
        withRetry(() => rpc.readContract({ address: LP_ZLT_USDT, abi: ABI.getReserves, functionName: 'getReserves' }), 'getReserves'),
        withRetry(() => rpc.readContract({ address: LP_ZLT_USDT, abi: ABI.token0,      functionName: 'token0'      }), 'token0'),
    ]);

    const isZLTFirst  = token0Addr.toLowerCase() === ZLT.toLowerCase();
    const reserveZLT  = BigInt(isZLTFirst ? reserves[0] : reserves[1]);
    const reserveUSDT = BigInt(isZLTFirst ? reserves[1] : reserves[0]);

    if (reserveZLT === 0n) throw new Error('ZLT reserve is zero — check LP address or pool state');

    return (reserveUSDT * SCALE) / reserveZLT;
}

// =============================================================================
// SCORING
// =============================================================================

/**
 * Computes ZPI component scores. Pure BigInt — no floats.
 *
 * tScore = W_TRADE × tradeUSD_7d
 * lScore = W_LP    × lpUSD
 * hScore = (nftCount × W_NFT) + ((balZLT / 1e5) × W_BAL), capped at H_CAP
 *          → reduced to 30% if 24h activity < $7
 * zpi    = tScore + lScore + hScore
 */
function computeScores({ vol7d, vol24h, lpZLT, bal, nftCount, priceScaled, totalSupplyLP, reserveZLT }) {
    const tradeUSD_7d  = (vol7d  * priceScaled) / (WEI * SCALE);
    const tradeUSD_24h = (vol24h * priceScaled) / (WEI * SCALE);

    const tScore = W_TRADE * tradeUSD_7d;

    // lpUSD still carries SCALE factor — normalise before the $7 check
    const lpUSD       = (lpZLT * priceScaled) / WEI;
    const lpUSDNormal = lpUSD  / SCALE;
    const lScore      = W_LP   * lpUSD;

    let hScore = (nftCount * W_NFT) + (((bal / WEI) / 100_000n) * W_BAL);
    if (hScore > H_CAP) hScore = H_CAP;
    if ((tradeUSD_24h + lpUSDNormal) < ACTIVITY_THRESHOLD_USD) {
        hScore = (hScore * 3n) / 10n;
    }

    const zpi = tScore + lScore + hScore;
    return { tScore, lScore, hScore, zpi };
}

// =============================================================================
// MAIN
// =============================================================================

async function run() {
    console.log('⚡ ZPI Indexer starting...');
    console.log(`   dRPC URL : ${process.env.DRPC_URL}`);
    console.log(`   Lava URL : ${process.env.LAVA_URL}`);
    console.log(`   Moralis  : ${moralisKeys.length} key(s)`);

    // -------------------------------------------------------------------------
    // 1. Resolve current block + fromBlock
    // -------------------------------------------------------------------------
    const currentBlock = await withRetry(() => rpc.getBlockNumber(), 'getBlockNumber');
    console.log(`[chain] Head block: ${currentBlock}`);

    // Compute the 7-day lookback as the minimum sensible start
    const sevenDayBlock = currentBlock - LOOKBACK_BLOCKS;

    let fromBlock = sevenDayBlock;  // default: 7 days ago

    const { data: syncState, error: syncErr } = await supabase
        .from('sync_state')
        .select('last_block_indexed')
        .eq('id', 'main_sync')
        .single();

    if (!syncErr && syncState) {
        const stored = BigInt(syncState.last_block_indexed);
        if (stored >= sevenDayBlock && stored < currentBlock) {
            fromBlock = stored + 1n;  // resume from where we left off
            console.log(`[sync] Resuming from stored block: ${fromBlock}`);
        } else {
            console.log(`[sync] Stored block ${stored} out of useful range, using 7-day lookback: ${fromBlock}`);
        }
    } else {
        console.log(`[sync] No sync state found, starting from 7-day lookback: ${fromBlock}`);
    }

    if (fromBlock > currentBlock) {
        console.log('[sync] Already up to date. Nothing to do.');
        return;
    }

    // -------------------------------------------------------------------------
    // 2. Fetch NFT holders (Moralis, paginated)
    // -------------------------------------------------------------------------
    const nftOwners = await fetchNFTOwners(OAT_NFT);

    // -------------------------------------------------------------------------
    // 3. Fetch Transfer logs (chunked getLogs via ANKR)
    // -------------------------------------------------------------------------
    const logs = await getLogsChunked(fromBlock, currentBlock);

    // -------------------------------------------------------------------------
    // 4. Process logs → transfer records + active address set
    // -------------------------------------------------------------------------
    const transfers   = [];
    const activeAddrs = new Set();

    for (const log of logs) {
        const from = log.args.from.toLowerCase();
        const to   = log.args.to.toLowerCase();

        transfers.push({
            wallet_address: from,
            value_wei:      log.args.value.toString(),
            block_number:   Number(log.blockNumber),
            tx_hash:        log.transactionHash.toLowerCase(),
            log_index:      Number(log.logIndex),
        });

        activeAddrs.add(from);
        activeAddrs.add(to);
    }

    // Every NFT holder must be scored even with no transfers
    for (const addr of nftOwners.keys()) activeAddrs.add(addr);

    console.log(`[process] ${transfers.length} transfers, ${activeAddrs.size} unique addresses`);

    // -------------------------------------------------------------------------
    // 5. Insert transfer logs (batched, with dedup via ON CONFLICT DO NOTHING)
    // -------------------------------------------------------------------------
    if (transfers.length > 0) {
        let inserted = 0;
        for (let i = 0; i < transfers.length; i += LOG_BATCH_SIZE) {
            const batch = transfers.slice(i, i + LOG_BATCH_SIZE);
            const { error } = await supabase
                .from('transfer_logs')
                .upsert(batch, { onConflict: 'tx_hash,log_index', ignoreDuplicates: true });
            if (error) throw new Error(`transfer_logs insert failed: ${error.message}`);
            inserted += batch.length;
        }
        console.log(`[db] Inserted/deduped ${inserted} transfer log rows`);

        // Increment swaps_count per sender
        const swapCounts = {};
        for (const t of transfers) {
            swapCounts[t.wallet_address] = (swapCounts[t.wallet_address] || 0) + 1;
        }
        const incResults = await Promise.allSettled(
            Object.entries(swapCounts).map(([addr, inc]) =>
                supabase.rpc('increment_swaps', { addr, inc })
            )
        );
        const incFailed = incResults.filter(r => r.status === 'rejected').length;
        if (incFailed > 0) console.error(`[db] ${incFailed} increment_swaps calls failed`);
    }

    // -------------------------------------------------------------------------
    // 6. Prune transfer_logs older than 7 days
    // -------------------------------------------------------------------------
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { error: pruneErr } = await supabase
        .from('transfer_logs')
        .delete()
        .lt('created_at', cutoff);
    if (pruneErr) console.error('[db] Prune failed:', pruneErr.message);
    else console.log('[db] Pruned transfer_logs older than 7 days');

    // -------------------------------------------------------------------------
    // 7. Refresh volume aggregates (single-pass SQL function)
    // -------------------------------------------------------------------------
    const { error: volErr } = await supabase.rpc('update_all_volumes');
    if (volErr) throw new Error(`update_all_volumes failed: ${volErr.message}`);
    console.log('[db] Volume aggregates refreshed');

    // -------------------------------------------------------------------------
    // 8. On-chain data: balances, LP, price
    // -------------------------------------------------------------------------
    const uniqueAddrs = [...activeAddrs];
    console.log(`[chain] Fetching on-chain data for ${uniqueAddrs.length} addresses...`);

    const addrArgs = uniqueAddrs.map(a => [a]);

    const [zltBalances, lpBalances, totalSupplyLP, priceScaled] = await Promise.all([
        batchRead(ZLT,         ABI.balanceOf, 'balanceOf', addrArgs),
        batchRead(LP_ZLT_USDT, ABI.balanceOf, 'balanceOf', addrArgs),
        withRetry(() => rpc.readContract({ address: LP_ZLT_USDT, abi: ABI.totalSupply, functionName: 'totalSupply' }), 'totalSupply').then(BigInt),
        getZLTPriceScaled(),
    ]);

    // Need reserveZLT to compute lpZLT per wallet
    const reserves   = await withRetry(() => rpc.readContract({ address: LP_ZLT_USDT, abi: ABI.getReserves, functionName: 'getReserves' }), 'getReserves');
    const token0Addr = await withRetry(() => rpc.readContract({ address: LP_ZLT_USDT, abi: ABI.token0, functionName: 'token0' }), 'token0');
    const isZLTFirst = token0Addr.toLowerCase() === ZLT.toLowerCase();
    const reserveZLT = BigInt(isZLTFirst ? reserves[0] : reserves[1]);

    console.log(`[chain] ZLT price (scaled): ${priceScaled}, LP totalSupply: ${totalSupplyLP}`);

    // -------------------------------------------------------------------------
    // 9. Bulk-fetch current wallet rows (volumes, swaps) — chunked to avoid Supabase URL limit
    // -------------------------------------------------------------------------
    const existingWallets = [];
    const ADDR_CHUNK = 500;
    for (let i = 0; i < uniqueAddrs.length; i += ADDR_CHUNK) {
        const chunk = uniqueAddrs.slice(i, i + ADDR_CHUNK);
        const { data, error: walletFetchErr } = await supabase
            .from('wallets')
            .select('address, volume_24h_wei, volume_7d_wei, swaps_count')
            .in('address', chunk);
        if (walletFetchErr) throw new Error(`wallets bulk fetch failed: ${walletFetchErr.message}`);
        if (data) existingWallets.push(...data);
    }

    const walletMap = new Map(
        (existingWallets ?? []).map(w => [w.address, w])
    );

    // -------------------------------------------------------------------------
    // 10. Compute ZPI scores
    // -------------------------------------------------------------------------
    const upsertRows = [];

    for (let i = 0; i < uniqueAddrs.length; i++) {
        const addr  = uniqueAddrs[i];
        const bal   = zltBalances[i];
        const lpBal = lpBalances[i];

        const lpZLT = totalSupplyLP > 0n
            ? (lpBal * reserveZLT) / totalSupplyLP
            : 0n;

        const stored   = walletMap.get(addr);
        const vol7d    = stored?.volume_7d_wei  ? BigInt(stored.volume_7d_wei)  : 0n;
        const vol24h   = stored?.volume_24h_wei ? BigInt(stored.volume_24h_wei) : 0n;
        const swapsCount = stored?.swaps_count ?? 0;
        const nftCount   = BigInt(nftOwners.get(addr) ?? 0);

        const { tScore, lScore, hScore, zpi } = computeScores({
            vol7d, vol24h, lpZLT, bal,
            nftCount, priceScaled,
            totalSupplyLP, reserveZLT,
        });

        upsertRows.push({
            address:         addr,
            zlt_balance_wei: bal.toString(),
            lp_amount_zlt:   lpZLT.toString(),
            nft_count:       Number(nftCount),
            volume_7d_wei:   vol7d.toString(),
            volume_24h_wei:  vol24h.toString(),
            swaps_count:     swapsCount,
            zpi_score:       zpi.toString(),
            t_score:         tScore.toString(),
            l_score:         lScore.toString(),
            h_score:         hScore.toString(),
            last_updated:    new Date().toISOString(),
        });
    }

    // -------------------------------------------------------------------------
    // 11. Upsert wallets in batches
    // -------------------------------------------------------------------------
    for (let i = 0; i < upsertRows.length; i += DB_BATCH_SIZE) {
        const { error } = await supabase
            .from('wallets')
            .upsert(upsertRows.slice(i, i + DB_BATCH_SIZE));
        if (error) throw new Error(`wallets upsert failed: ${error.message}`);
    }
    console.log(`[db] Upserted ${upsertRows.length} wallet rows`);

    // -------------------------------------------------------------------------
    // 12. Build leaderboard cache (top 100 by zpi_score)
    // -------------------------------------------------------------------------
    const { data: top100, error: topErr } = await supabase
        .from('wallets')
        .select('address, zpi_score, t_score, l_score, h_score, zlt_balance_wei, lp_amount_zlt, nft_count, volume_24h_wei, volume_7d_wei, swaps_count')
        .order('zpi_score', { ascending: false })
        .limit(100);
    if (topErr) throw new Error(`leaderboard fetch failed: ${topErr.message}`);

    // Compute summary stats for the API response
    const totalWallets = upsertRows.length;
    const totalTxns    = transfers.length;
    const nftStaked    = [...nftOwners.values()].reduce((a, b) => a + b, 0);
    const zltInLP      = reserveZLT.toString();

    const { error: cacheErr } = await supabase
        .from('leaderboard_cache')
        .upsert({
            id:         1,
            data:       { top100, totalWallets, totalTxns, nftStaked, zltInLP },
            updated_at: new Date().toISOString(),
        });
    if (cacheErr) console.error('[db] leaderboard_cache upsert failed:', cacheErr.message);
    else console.log('[db] Leaderboard cache updated');

    // -------------------------------------------------------------------------
    // 13. Update sync state
    // -------------------------------------------------------------------------
    const { error: syncUpdateErr } = await supabase
        .from('sync_state')
        .upsert({
            id:                 'main_sync',
            last_block_indexed: Number(currentBlock),
            last_full_sync:     new Date().toISOString(),
        });
    if (syncUpdateErr) throw new Error(`sync_state update failed: ${syncUpdateErr.message}`);

    console.log(`✅ Done. Wallets: ${upsertRows.length}, Transfers: ${transfers.length}, Head: ${currentBlock}`);
}

run().catch(err => {
    console.error('💥 Fatal:', err.message);
    process.exit(1);
});
