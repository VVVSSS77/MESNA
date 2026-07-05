// Cached distributor feed: claims, buybacks, airdrops for the MESNA site.
// Runs server-side on Vercel; the edge cache shares one result with every
// visitor so the page loads instantly and everyone sees the same tape.
// Set HELIUS_API_KEY in Vercel project env vars for fast, reliable RPC.

const WALLET = "BULLxAZaHruijDeRGwWcFm5spQmJFy195nxoWPkex93q";
const MINT = "Mesna16gkqw9jSYixEYP3d4gjCh5mUGkAskTVUwYjCU";
const RPC_URL = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : "https://api.mainnet-beta.solana.com";

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

function walletSolDelta(tx) {
  const keys = tx.transaction.message.accountKeys || [];
  const i = keys.findIndex(k => (k.pubkey || k) === WALLET);
  if (i < 0 || !tx.meta.preBalances) return 0;
  return (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
}

function parseTx(tx) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const instrs = [];
  for (const ix of tx.transaction.message.instructions || []) instrs.push(ix);
  for (const inner of tx.meta.innerInstructions || []) instrs.push(...inner.instructions);
  let out = 0, outCount = 0, bought = 0;
  for (const ix of instrs) {
    const p = ix.parsed;
    if (!p || p.type !== "transferChecked" || !p.info || p.info.mint !== MINT) continue;
    const amt = p.info.tokenAmount ? p.info.tokenAmount.uiAmount : 0;
    if (!amt) continue;
    if (p.info.authority === WALLET) { out += amt; outCount++; }
    else bought += amt;
  }
  const solDelta = walletSolDelta(tx);
  if (outCount) return { type: "airdrop", total: out, recipients: outCount };
  if (bought > 0) return { type: "buyback", total: bought, sol: Math.max(0, -solDelta) };
  if (solDelta > 0.0005) return { type: "claim", sol: solDelta };
  return null;
}

module.exports = async (req, res) => {
  try {
    const sigs = ((await rpc("getSignaturesForAddress", [WALLET, { limit: 50 }])) || [])
      .filter(s => !s.err);
    const events = [];
    let failed = 0;
    const CHUNK = process.env.HELIUS_API_KEY ? 8 : 3;
    for (let i = 0; i < sigs.length; i += CHUNK) {
      const chunk = sigs.slice(i, i + CHUNK);
      const txs = await Promise.all(chunk.map(s =>
        rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }])
          .catch(() => { failed++; return null; })
      ));
      txs.forEach((tx, j) => {
        const d = parseTx(tx);
        if (d) events.push({ ...d, sig: chunk[j].signature, t: chunk[j].blockTime || null });
      });
    }
    // if the RPC dropped most lookups (rate-limited public endpoint), tell the
    // browser to fall back to its own walk instead of caching a hollow feed
    if (failed > sigs.length / 2) {
      res.setHeader("Cache-Control", "no-store");
      res.status(503).json({ error: "rpc degraded", failed, total: sigs.length });
      return;
    }
    // newest first, capped
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({ events: events.slice(0, 30) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
