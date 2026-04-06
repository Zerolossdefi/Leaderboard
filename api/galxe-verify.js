// api/galxe-verify.js
//
// Galxe REST Credential endpoint for ZPI Score verification.
//
// Galxe sends a GET request:
//   GET /api/galxe-verify?address=0xABC...&threshold=20000
//
// Must return JSON with numeric 1 (eligible) or 0 (not eligible).
// Never return booleans or strings — Galxe requires integers.
//
// Galxe docs: https://docs.galxe.com/quest/credential-api/rest-cred

export default async function handler(req, res) {

  // ── CORS — Galxe requires this exact origin to save the credential ──
  res.setHeader("Access-Control-Allow-Origin", "https://dashboard.galxe.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");

  // Handle Galxe preflight — must return 204 No Content (not 200)
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ── Only GET is supported (Galxe REST credential uses GET) ──────────
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── Optional header API key — skip check if no key is configured ─────
  // NOTE: Galxe's test button does NOT send custom headers.
  // Only enable this check after the credential is saved and working.
  // To enable: set GALXE_API_KEY in Vercel + add x-api-key header in Galxe dashboard.
  const apiKey = req.headers["x-api-key"];
  if (process.env.GALXE_API_KEY && apiKey && apiKey !== process.env.GALXE_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Parse wallet address from query params ───────────────────────────
  // Galxe sends: ?address=$address  (always lowercase, with 0x prefix)
  const { address, threshold } = req.query;

  if (!address || !address.startsWith("0x")) {
    return res.status(400).json({ error: "Missing or invalid address" });
  }

  // ── ZPI threshold for this quest (default: 20,000 points) ──────────
  // You can create multiple quests with different thresholds by changing
  // this query param in the Galxe endpoint URL.
  // e.g. /api/galxe-verify?address=$address&threshold=500000
  const requiredScore = parseInt(threshold) || 20_000;

  // ── Fetch leaderboard data from your own cached API ──────────────────
  // This hits the Vercel CDN cache (4-hour window), not Moralis directly.
  // No extra CU cost — it serves from cache just like a browser would.
  let leaderboard = [];
  try {
    const response = await fetch(
      "https://leaderboard.zeroloss.app/api/leaderboard",
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000), // 8s timeout
      }
    );
    if (!response.ok) {
      throw new Error(`Leaderboard API returned ${response.status}`);
    }
    const json = await response.json();
    leaderboard = json.leaderboard || [];
  } catch (err) {
    console.error("[galxe-verify] Leaderboard fetch failed:", err.message);
    // Return 0 on error — never crash with 500, it breaks Galxe verification
    return res.status(200).json({ eligible: 0 });
  }

  // ── Find wallet and read its ZPI score ───────────────────────────────
  // Addresses from Galxe are already lowercase — match safely
  const wallet = leaderboard.find(
    (w) => w.address.toLowerCase() === address.toLowerCase()
  );

  const zpiScore = wallet ? (wallet.zpi ?? 0) : 0;
  const eligible = zpiScore >= requiredScore ? 1 : 0;

  console.log(
    `[galxe-verify] address=${address} zpi=${zpiScore} ` +
    `required=${requiredScore} eligible=${eligible}`
  );

  // ── Return Galxe-compatible response ─────────────────────────────────
  // Galxe expression will evaluate: resp.eligible == 1
  return res.status(200).json({ eligible });
}
