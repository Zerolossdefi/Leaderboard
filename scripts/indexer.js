import { createClient } from '@supabase/supabase-js';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { bsc } from 'viem/chains';
import 'dotenv/config';

// ======================= CONFIG =======================
const TRADING_WINDOW_DAYS = 7;
const ZLT        = "0x05D8762946fA7620b263E1e77003927addf5f7E6";
const LP_ZLT_USDT = "0x9aa4073cc0e86508ce18788cdf0e6b6b46677b8d";
const OAT_NFT    = "0x1d1C02F9fcff7EE2073a72181caE53563C82879C";
const SCALE      = 10n ** 12n;
const WEI        = 10n ** 18n;
const BATCH_SIZE = 20;
const RPC_RETRIES    = 3;
const RPC_DELAY_MS   = 100;
const INITIAL_BLOCK = 93_715_000;

// Max log range per getLogs call — BSC public nodes reject ranges > 2 000 blocks
const MAX_LOG_RANGE = 500n;

// ======================= ENV GUARD =======================
for (const key of ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','BNB_RPC','MORALIS_KEYS']) {
    if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
}

// ======================= CLIENTS =======================
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const rpc = createPublicClient({
    chain: bsc,
    transport: http(process.env.BNB_RPC)
});

const moralisKeys = process.env.MORALIS_KEYS.split(',').map(k => k.trim()).filter(Boolean);
if (moralisKeys.length === 0) throw new Error("MORALIS_KEYS is empty after parsing");

// ======================= HELPERS =======================

/**
 * FIX #1 – Moralis pagination.
 * The original code only fetched the first page of NFT owners (default 100 results).
 * This now follows `cursor` until all pages are consumed.
 */
async function moralisFetch(path) {
    for (const key of moralisKeys) {
        try {
            const res = await fetch(`https://deep-index.moralis.io/api/v2.2${path}`, {
                headers: { 'X-API-Key': key }
            });
            if (res.status === 200) return await res.json();
            if (res.status === 401) continue;               // try next key
            throw new Error(`Moralis HTTP ${res.status}`);
        } catch {
            continue;
        }
    }
    throw new Error("All Moralis keys exhausted");
}

async function moralisFetchAllPages(basePath) {
    const allResults = [];
    let cursor = null;

    do {
        const url = cursor ? `${basePath}&cursor=${encodeURIComponent(cursor)}` : basePath;
        const page = await moralisFetch(url);
        if (!page?.result) break;
        allResults.push(...page.result);
        cursor = page.cursor ?? null;
    } while (cursor);

    return allResults;
}

/**
 * FIX #2 – Exponential back-off instead of linear delay.
 */
async function rpcWithRetry(fn, args = []) {
    for (let i = 0; i < RPC_RETRIES; i++) {
        try {
            return await fn(...args);
        } catch (e) {
            if (i === RPC_RETRIES - 1) throw e;
            await sleep(RPC_DELAY_MS * 2 ** i);
        }
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Reusable generic ABI fragment builder so individual output types are respected.
 */
function makeAbi(name, inputTypes, outputTypes) {
    return [{
        name,
        type: 'function',
        stateMutability: 'view',
        inputs:  inputTypes.map((t, i) => ({ name: `a${i}`, type: t })),
        outputs: outputTypes.map((t, i) => ({ name: `o${i}`, type: t }))
    }];
}

/**
 * FIX #3 – batchRpcCalls now accepts a flexible ABI so it isn't hardcoded to
 * single-address → uint256 signatures.  The old version would silently misparse
 * any call whose signature differed.
 */
async function batchRpcCalls(contract, abi, functionName, argsList) {
    const results = [];
    for (let i = 0; i < argsList.length; i += BATCH_SIZE) {
        const batch = argsList.slice(i, i + BATCH_SIZE);
        const settled = await Promise.allSettled(
            batch.map(args =>
                rpcWithRetry(() => rpc.readContract({ address: contract, abi, functionName, args }))
            )
        );
        for (const r of settled) {
            if (r.status === 'fulfilled') {
                results.push(r.value);
            } else {
                console.error(`batchRpcCalls error for ${functionName}:`, r.reason?.message);
                results.push(0n);   // safe default — downstream BigInt math still works
            }
        }
    }
    return results;
}

/**
 * FIX #4 – Chunked getLogs.
 * BSC full nodes cap log ranges at ~2 000 blocks.  Fetching millions of blocks
 * in one call would always throw.  This splits the range into chunks and
 * concatenates results.
 */
async function getLogsChunked(address, event, fromBlock, toBlock) {
    const allLogs = [];
    let start = fromBlock;

    while (start <= toBlock) {
        const end = start + MAX_LOG_RANGE - 1n < toBlock
            ? start + MAX_LOG_RANGE - 1n
            : toBlock;

        const chunk = await rpcWithRetry(() =>
            rpc.getLogs({ address, event, fromBlock: start, toBlock: end })
        );
        allLogs.push(...chunk);
        start = end + 1n;
        await sleep(200);
    }
    return allLogs;
}

// ======================= MAIN =======================
async function run() {
    console.log("⚡ Starting ZPI v2 Engine (7-Day Window) – Batch Mode");

    // ---------- 1. Resolve fromBlock ----------
    let fromBlock = BigInt(INITIAL_BLOCK);
    const currentBlock = await rpcWithRetry(() => rpc.getBlockNumber());
    console.log(`Current chain head: ${currentBlock}`);

    const { data: state, error: stateError } = await supabase
        .from('sync_state')
        .select('*')
        .eq('id', 'main_sync')
        .single();

    if (stateError || !state) {
        console.log(`Sync state missing (${stateError?.message}). Using initial block ${INITIAL_BLOCK}`);
    } else {
        const stored = Number(state.last_block_indexed);
        if (stored < INITIAL_BLOCK || BigInt(stored) > currentBlock) {
            console.warn(`Stored block ${stored} is out of range. Falling back to ${INITIAL_BLOCK}`);
        } else {
            fromBlock = BigInt(stored);
        }
    }
    console.log(`Indexing from block: ${fromBlock}`);

    // ---------- 2. Detect first run ----------
    const { count: walletCount, error: countError } = await supabase
        .from('wallets')
        .select('*', { count: 'exact', head: true });
    const isFirstRun = (!!countError || walletCount === 0);
    console.log(`Wallets: ${walletCount ?? 0}. First run: ${isFirstRun}`);

    // ---------- 3. Fetch OAT NFT holders (all pages) ----------
    // FIX #1 applied here — paginated fetch
    console.log("Fetching OAT NFT holders (all pages)...");
    const nftRaw = await moralisFetchAllPages(`/nft/${OAT_NFT}/owners?chain=bsc&limit=100`);
    const nftCountMap = new Map();
    for (const nft of nftRaw) {
        const owner = nft.owner_of.toLowerCase();
        nftCountMap.set(owner, (nftCountMap.get(owner) || 0) + 1);
    }
    console.log(`Found ${nftCountMap.size} unique NFT holders across ${nftRaw.length} NFTs.`);

    // ---------- 4. Guard: nothing to do ----------
    if (currentBlock <= fromBlock && !isFirstRun) {
        console.log("No new blocks. Exiting.");
        return;
    }

    // ---------- 5. Fetch transfer logs (chunked) ----------
    // FIX #4: chunked getLogs replaces the single oversized call
    console.log(`Fetching Transfer logs [${fromBlock} → ${currentBlock}]...`);
    const logs = await getLogsChunked(
        ZLT,
        parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
        fromBlock,
        currentBlock
    );
    console.log(`Found ${logs.length} Transfer logs.`);

    const activeAddrs = new Set();
    const transfers   = [];

    for (const log of logs) {
    const from  = log.args.from.toLowerCase();
    const to    = log.args.to.toLowerCase();
    const value = log.args.value.toString();
    transfers.push({
        wallet_address: from,
        value_wei:      value,
        block_number:   Number(log.blockNumber),
        tx_hash:        log.transactionHash.toLowerCase(),
        log_index:      Number(log.logIndex)
    });
        activeAddrs.add(from);
        activeAddrs.add(to);
    }

    // Ensure every NFT holder is processed even if they made no transfers
    for (const addr of nftCountMap.keys()) activeAddrs.add(addr);

    // ---------- 6. Persist transfer logs ----------
    if (transfers.length > 0) {
        // FIX #5 – Batch inserts instead of one massive payload (Supabase caps ~1 MB per request)
        for (let i = 0; i < transfers.length; i += 500) {
            const { error } = await supabase
                .from('transfer_logs')
                .insert(transfers.slice(i, i + 500));
            if (error) throw new Error(`insert transfer_logs failed: ${error.message}`);
        }
        console.log(`Inserted ${transfers.length} transfer logs.`);

        // Aggregate swap counts per sender and update in one RPC call per address
        const counts = {};
        for (const t of transfers) {
            counts[t.wallet_address] = (counts[t.wallet_address] || 0) + 1;
        }
        // FIX #6 – Parallel increment calls with Promise.allSettled so one failure
        //          doesn't abort the entire batch
        const incPromises = Object.entries(counts).map(([addr, inc]) =>
            supabase.rpc('increment_swaps', { addr, inc })
        );
        const incResults = await Promise.allSettled(incPromises);
        for (const r of incResults) {
            if (r.status === 'rejected') console.error('increment_swaps failed:', r.reason);
        }
    }

    // ---------- 7. Prune stale transfer logs ----------
    const cutoff = new Date(Date.now() - TRADING_WINDOW_DAYS * 86_400_000).toISOString();
    const { error: pruneError } = await supabase
        .from('transfer_logs')
        .delete()
        .lt('created_at', cutoff);
    if (pruneError) console.error('Prune transfer_logs failed:', pruneError.message);
    else console.log("Pruned transfer logs older than 7 days.");

    // ---------- 8. Update volume aggregates ----------
    const { error: volError } = await supabase.rpc('update_all_volumes');
    if (volError) throw new Error(`update_all_volumes RPC failed: ${volError.message}`);
    console.log("Volume aggregates updated.");

    // ---------- 9. On-chain data ----------
    const uniqueAddrs = [...activeAddrs];
    console.log(`Unique addresses to score: ${uniqueAddrs.length}`);

    // ABIs
    const balanceOfAbi  = makeAbi('balanceOf',  ['address'], ['uint256']);
    const totalSupplyAbi = makeAbi('totalSupply', [], ['uint256']);
    const getReservesAbi = [{
        name: 'getReserves', type: 'function', stateMutability: 'view',
        inputs: [],
        outputs: [
            { name: '_reserve0', type: 'uint112' },
            { name: '_reserve1', type: 'uint112' },
            { name: '_blockTimestampLast', type: 'uint32' }
        ]
    }];
    const token0Abi = makeAbi('token0', [], ['address']);

    const [balanceResults, lpBalanceResults, totalSupplyLP, reserves, token0] =
        await Promise.all([
            batchRpcCalls(ZLT,        balanceOfAbi,  'balanceOf', uniqueAddrs.map(a => [a])),
            batchRpcCalls(LP_ZLT_USDT, balanceOfAbi, 'balanceOf', uniqueAddrs.map(a => [a])),
            rpcWithRetry(() => rpc.readContract({ address: LP_ZLT_USDT, abi: totalSupplyAbi, functionName: 'totalSupply' })),
            rpcWithRetry(() => rpc.readContract({ address: LP_ZLT_USDT, abi: getReservesAbi, functionName: 'getReserves' })),
            rpcWithRetry(() => rpc.readContract({ address: LP_ZLT_USDT, abi: token0Abi,      functionName: 'token0' })),
        ]);

    // FIX #7 – Guard against zero reserves (pool might be empty / mis-configured)
    const isZLTFirst = token0.toLowerCase() === ZLT.toLowerCase();
    const reserveZLT  = BigInt(isZLTFirst ? reserves[0] : reserves[1]);
    const reserveUSDT = BigInt(isZLTFirst ? reserves[1] : reserves[0]);

    if (reserveZLT === 0n) throw new Error("ZLT reserve is zero — pool may be empty or addresses wrong");
    const priceScaled = (reserveUSDT * SCALE) / reserveZLT;

    // ---------- 10. Bulk-fetch wallet rows (one query, not N queries) ----------
    // FIX #8 – The original had a supabase SELECT inside a per-address loop = N+1 queries.
    //          One query with `.in()` is O(1) round trips.
    const { data: existingWallets, error: walletFetchError } = await supabase
        .from('wallets')
        .select('address, volume_24h_wei, volume_7d_wei, swaps_count')
        .in('address', uniqueAddrs);

    if (walletFetchError) throw new Error(`wallets bulk fetch failed: ${walletFetchError.message}`);

    const walletMap = new Map(
        (existingWallets ?? []).map(w => [w.address, w])
    );

    // ---------- 11. Score computation ----------
    const upsertData = [];

    for (let i = 0; i < uniqueAddrs.length; i++) {
        const addr  = uniqueAddrs[i];
        const bal   = BigInt(balanceResults[i]  ?? 0n);
        const lpBal = BigInt(lpBalanceResults[i] ?? 0n);

        // FIX #9 – Guard against zero totalSupplyLP (division by zero)
        const lpZLT = (totalSupplyLP > 0n)
            ? (lpBal * reserveZLT) / BigInt(totalSupplyLP)
            : 0n;

        const wallet    = walletMap.get(addr);
        const vol7d     = wallet?.volume_7d_wei  ? BigInt(wallet.volume_7d_wei)  : 0n;
        const vol24h    = wallet?.volume_24h_wei ? BigInt(wallet.volume_24h_wei) : 0n;
        const swapsCount = wallet?.swaps_count ?? 0;

        // FIX #10 – All arithmetic kept in BigInt until the very last Number() conversion.
        //           Original mixed BigInt and Number in intermediate steps on some paths.
        const tradeUSD_7d  = (vol7d  * priceScaled) / (WEI * SCALE);
        const tradeUSD_24h = (vol24h * priceScaled) / (WEI * SCALE);

        const tScore = 1_020n * tradeUSD_7d;

        const lpUSD  = (lpZLT * priceScaled) / WEI;   // NOTE: still scaled by SCALE here
        const lScore = 2_030n * lpUSD;

        const nftCount = BigInt(nftCountMap.get(addr) ?? 0);

        // hScore cap + activity discount
        let hScore = (nftCount * 10_000n) + (((bal / WEI) / 100_000n) * 3_050n);
        if (hScore > 6_000_000n) hScore = 6_000_000n;

        // FIX #11 – lpUSD is scaled by SCALE here, so divide before comparing against 7n
        const lpUSDNormal = lpUSD / SCALE;
        if ((tradeUSD_24h + lpUSDNormal) < 7n) hScore = (hScore * 3n) / 10n;

        const zpi = tScore + lScore + hScore;

        upsertData.push({
            address:          addr,
            zlt_balance_wei:  bal.toString(),
            lp_amount_zlt:    lpZLT.toString(),
            nft_count:        Number(nftCount),
            volume_7d_wei:    vol7d.toString(),
            volume_24h_wei:   vol24h.toString(),
            swaps_count:      swapsCount,
            zpi_score:        Number(zpi),
            t_score:          Number(tScore),
            l_score:          Number(lScore),
            h_score:          Number(hScore),
            last_updated:     new Date().toISOString()
        });
    }

    // ---------- 12. Upsert in batches ----------
    for (let i = 0; i < upsertData.length; i += 100) {
        const { error } = await supabase
            .from('wallets')
            .upsert(upsertData.slice(i, i + 100));
        if (error) throw new Error(`Upsert failed: ${error.message}`);
    }
    console.log(`Upserted ${upsertData.length} wallets.`);

    // ---------- 13. Leaderboard cache ----------
    const { data: top100, error: topError } = await supabase
        .from('wallets')
        .select('address, zpi_score, t_score, l_score, h_score, zlt_balance_wei, lp_amount_zlt, nft_count, volume_24h_wei')
        .order('zpi_score', { ascending: false })
        .limit(100);
    if (topError) throw new Error(`Leaderboard fetch failed: ${topError.message}`);

    const { error: cacheError } = await supabase
        .from('leaderboard_cache')
        .upsert({ id: 1, data: top100, updated_at: new Date().toISOString() });
    if (cacheError) console.error('Leaderboard cache upsert failed:', cacheError.message);

    // ---------- 14. Persist sync state ----------
    const { error: syncError } = await supabase
        .from('sync_state')
        .upsert({
            id:               'main_sync',
            last_block_indexed: Number(currentBlock),
            last_full_sync:   new Date().toISOString()
        });
    if (syncError) throw new Error(`sync_state upsert failed: ${syncError.message}`);

    console.log(`✅ Done. Scored ${upsertData.length} wallets. Head block: ${currentBlock}`);
}

run().catch(err => {
    console.error("💥 Fatal error:", err);
    process.exit(1);
});
