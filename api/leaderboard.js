// =============================================================================
// api/leaderboard.js — Vercel Serverless Function
// Reads leaderboard_cache from Supabase and returns the standard JSON shape.
// =============================================================================

import { createClient } from '@supabase/supabase-js';

// Supabase client — uses env vars set in Vercel project settings
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Cache responses for 5 minutes at the CDN edge (Vercel)
const CACHE_MAX_AGE = 300;

export default async function handler(req, res) {
    // CORS — allow any frontend origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    try {
        const { data, error } = await supabase
            .from('leaderboard_cache')
            .select('data, updated_at')
            .eq('id', 1)
            .single();

        if (error) throw error;

        if (!data) {
            return res.status(503).json({
                success: false,
                error:   'Leaderboard not yet populated. Indexer may still be running.',
            });
        }

        const cached = data.data;

        // Set CDN cache headers so Vercel edge caches the response
        res.setHeader('Cache-Control', `public, s-maxage=${CACHE_MAX_AGE}, stale-while-revalidate=60`);

        // Return the exact shape the frontend expects
        return res.status(200).json({
            success:      true,
            updatedAt:    data.updated_at,
            activeWallets: cached.totalWallets ?? 0,  
            totalTxns:    cached.totalTxns     ?? 0,
            nftStaked:    cached.nftStaked     ?? 0,
            zltInLP:      cached.zltInLP       ?? null,
            zltPriceUSD:  cached.zltPriceUSD   ?? null,
            leaderboard:  cached.top100        ?? [],
        });

    } catch (err) {
        console.error('[leaderboard] Error:', err.message);
        return res.status(500).json({
            success: false,
            error:   'Internal server error',
        });
    }
}
