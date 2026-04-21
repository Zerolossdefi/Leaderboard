import { createClient } from '@supabase/supabase-js';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { bsc } from 'viem/chains';
import 'dotenv/config';

// ======================= CONFIG =======================
const TRADING_WINDOW_DAYS = 7;
const ZLT = "0x05D8762946fA7620b263E1e77003927addf5f7E6";
const LP_ZLT_USDT = "0x9aa4073cc0e86508ce18788cdf0e6b6b46677b8d";
const OAT_NFT = "0x1d1C02F9fcff7EE2073a72181caE53563C82879C";
const SCALE = 10n ** 12n;
const WEI = 10n ** 18n;
const BATCH_SIZE = 20; // For parallel RPC calls
const RPC_RETRIES = 3;
const RPC_DELAY_MS = 100;

// ======================= CLIENTS =======================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const rpc = createPublicClient({ chain: bsc, transport: http(process.env.BNB_RPC) });
const moralisKeys = process.env.MORALIS_KEYS.split(',').map(k => k.trim());

// ======================= HELPERS =======================
async function moralisFetch(path) {
    for (let key of moralisKeys) {
        try {
            const res = await fetch(`https://deep-index.moralis.io/api/v2.2${path}`, {
                headers: { 'X-API-Key': key }
            });
            if (res.status === 200) return await res.json();
            if (res.status === 401) continue; // key exhausted
            throw new Error(`Moralis error ${res.status}`);
        } catch (e) { continue; }
    }
    throw new Error("All Moralis keys exhausted");
}

async function rpcWithRetry(fn, args = []) {
    for (let i = 0; i < RPC_RETRIES; i++) {
        try {
            return await fn(...args);
        } catch (e) {
            if (i === RPC_RETRIES - 1) throw e;
            await new Promise(r => setTimeout(r, RPC_DELAY_MS * (i + 1)));
        }
    }
}

async function batchRpcCalls(contract, method, argsList) {
    // argsList: array of [address] for balanceOf, etc.
    const results = [];
    for (let i = 0; i < argsList.length; i += BATCH_SIZE) {
        const batch = argsList.slice(i, i + BATCH_SIZE);
        const promises = batch.map(args => rpcWithRetry(() => rpc.readContract({
            address: contract,
            abi: [{ name: method, type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
            functionName: method,
            args
        })));
        const batchResults = await Promise.all(promises);
        results.push(...batchResults);
    }
    return results;
}

// ======================= MAIN =======================
async function run() {
    console.log("⚡ Starting ZPI v2 Engine (7‑Day Window) – Batch Mode");

    // 1. Get last indexed block
    const { data: state } = await supabase.from('sync_state').select('*').eq('id', 'main_sync').single();
    const fromBlock = BigInt(state.last_block_indexed);
    const toBlock = await rpcWithRetry(() => rpc.getBlockNumber());

    // 2. Fetch new transfer logs
    const logs = await rpcWithRetry(() => rpc.getLogs({
        address: ZLT,
        event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
        fromBlock, toBlock
    }));

    const activeAddrs = new Set();
    const transfers = [];
    for (const log of logs) {
        const from = log.args.from.toLowerCase();
        const value = log.args.value.toString();
        transfers.push({
            wallet_address: from,
            value_wei: value,
            block_number: Number(log.blockNumber)
        });
        activeAddrs.add(from);
        // Also add 'to' address to update balances later
        const to = log.args.to.toLowerCase();
        activeAddrs.add(to);
    }

    if (transfers.length > 0) {
        // Insert new transfer logs
        await supabase.from('transfer_logs').insert(transfers);
        // Update swaps_count for wallets that sent transfers
        const counts = {};
        for (const t of transfers) {
            counts[t.wallet_address] = (counts[t.wallet_address] || 0) + 1;
        }
        for (const [addr, cnt] of Object.entries(counts)) {
            await supabase.rpc('increment_swaps', { addr, inc: cnt });
        }
    }

    // 3. Clean old transfer logs (> 7 days)
    const cutoff = new Date(Date.now() - (TRADING_WINDOW_DAYS * 86400000)).toISOString();
    await supabase.from('transfer_logs').delete().lt('created_at', cutoff);

        // 4. Compute volume aggregates in batch (SQL)
    await supabase.rpc('update_all_volumes');

    // 5. Fetch OAT NFT holders once
    const nftData = await moralisFetch(`/nft/${OAT_NFT}/owners?chain=bsc`);
    const nftCountMap = new Map();
    for (const nft of nftData.result) {
        const owner = nft.owner_of.toLowerCase();
        nftCountMap.set(owner, (nftCountMap.get(owner) || 0) + 1);
    }

    // 6. Get active wallet addresses (those in transfer logs or NFT holders)
    const allActive = [...activeAddrs];
    for (const addr of nftCountMap.keys()) allActive.push(addr);
    const uniqueAddrs = [...new Set(allActive)];

    // 7. Batch fetch ZLT balances, LP balances, and totalSupply
    const balanceResults = await batchRpcCalls(ZLT, 'balanceOf', uniqueAddrs.map(a => [a]));
    const lpBalanceResults = await batchRpcCalls(LP_ZLT_USDT, 'balanceOf', uniqueAddrs.map(a => [a]));
    const totalSupplyLP = await rpcWithRetry(() => rpc.readContract({
        address: LP_ZLT_USDT,
        abi: [{ name: 'totalSupply', type: 'function', outputs: [{ type: 'uint256' }] }],
        functionName: 'totalSupply'
    }));

    // 8. Fetch LP reserves and determine token order
    const reserves = await rpcWithRetry(() => rpc.readContract({
        address: LP_ZLT_USDT,
        abi: [{ name: 'getReserves', type: 'function', outputs: [{ name: 'r0', type: 'uint112' }, { name: 'r1', type: 'uint112' }] }],
        functionName: 'getReserves'
    }));
    const token0 = await rpcWithRetry(() => rpc.readContract({
        address: LP_ZLT_USDT,
        abi: [{ name: 'token0', type: 'function', outputs: [{ type: 'address' }] }],
        functionName: 'token0'
    }));
    const isZLTFirst = token0.toLowerCase() === ZLT.toLowerCase();
    const reserveZLT = isZLTFirst ? reserves[0] : reserves[1];
    const reserveUSDT = isZLTFirst ? reserves[1] : reserves[0];
    const priceScaled = (BigInt(reserveUSDT) * SCALE) / BigInt(reserveZLT);

    // 9. Prepare data for upsert
    const upsertData = [];
    for (let i = 0; i < uniqueAddrs.length; i++) {
        const addr = uniqueAddrs[i];
        const bal = balanceResults[i];
        const lpBal = lpBalanceResults[i];
        const lpZLT = totalSupplyLP > 0n ? (BigInt(lpBal) * BigInt(reserveZLT)) / totalSupplyLP : 0n;

        // Get volumes from the wallet table (already updated)
        const { data: wallet } = await supabase.from('wallets').select('volume_24h_wei, volume_7d_wei, swaps_count').eq('address', addr).single();
        const vol7d = wallet?.volume_7d_wei || '0';
        const vol24h = wallet?.volume_24h_wei || '0';
        const swapsCount = wallet?.swaps_count || 0;

        const tradeUSD_7d = (BigInt(vol7d) * priceScaled) / (WEI * SCALE); // wei * priceScaled / 1e30 = USD (integer)
        const tScore = 1020n * tradeUSD_7d;
        const lpUSD = (lpZLT * priceScaled) / WEI;
        const lScore = 2030n * lpUSD;

        const tradeUSD_24h = (BigInt(vol24h) * priceScaled) / (WEI * SCALE);
        const nftCount = nftCountMap.get(addr) || 0;

        let hScore = (BigInt(nftCount) * 10000n) + (((bal / WEI) / 100000n) * 3050n);
        if (hScore > 6000000n) hScore = 6000000n;
        if ((tradeUSD_24h + (lpUSD / SCALE)) < 7n) hScore = (hScore * 3n) / 10n;

        const zpi = tScore + lScore + hScore;

        upsertData.push({
            address: addr,
            zlt_balance_wei: bal.toString(),
            lp_amount_zlt: lpZLT.toString(),
            nft_count: nftCount,
            volume_7d_wei: vol7d,
            volume_24h_wei: vol24h,
            swaps_count: swapsCount,
            zpi_score: Number(zpi),
            t_score: Number(tScore),
            l_score: Number(lScore),
            h_score: Number(hScore),
            last_updated: new Date().toISOString()
        });
    }

    // 10. Upsert in batches to avoid row limit
    for (let i = 0; i < upsertData.length; i += 100) {
        await supabase.from('wallets').upsert(upsertData.slice(i, i + 100));
    }

    // 11. Get top 100 and store in leaderboard_cache
    const { data: top100 } = await supabase.from('wallets')
        .select('address, zpi_score, t_score, l_score, h_score, zlt_balance_wei, lp_amount_zlt, nft_count, volume_24h_wei')
        .order('zpi_score', { ascending: false })
        .limit(100);

    await supabase.from('leaderboard_cache').upsert({
        id: 1,
        data: top100,
        updated_at: new Date().toISOString()
    });

    // 12. Update sync state
    await supabase.from('sync_state').update({ last_block_indexed: Number(toBlock) }).eq('id', 'main_sync');

    console.log("✅ Season Update Complete.");
}

run().catch(console.error);
