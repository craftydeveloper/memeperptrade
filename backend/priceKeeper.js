// backend/priceKeeper.js
// Periodically fetches prices from DexScreener and updates in-memory markets


const fetch = global.fetch || require('node-fetch');
const { log } = require('./logger');

let intervalId = null;
let shuttingDown = false;

async function fetchWithRetry(url, attempts = 5, baseDelayMs = 2000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      // Exponential backoff: delay increases with each attempt
      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(2, i); // 2s, 4s, 8s, ...
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

function startServerPriceKeeper({ ledger }) {
  if (!ledger || !ledger.markets) throw new Error('PriceKeeper: ledger.markets required');
  if (intervalId) return; // already running
  shuttingDown = false;

  async function updateAllMarkets() {
    const markets = Object.values(ledger.markets);
    // Stagger requests: 1s apart per token
    for (let idx = 0; idx < markets.length; idx++) {
      const market = markets[idx];
      if (!market.addr) {
        log('WARN', 'PRICE', 'Market missing token address, skipping', { sym: market.sym });
        continue;
      }
      const url = `https://api.dexscreener.com/latest/dex/tokens/${market.addr}`;
      try {
        const data = await fetchWithRetry(url);
        if (!data.pairs || !Array.isArray(data.pairs) || !data.pairs[0]) {
          log('WARN', 'PRICE', 'No pairs for market, skipping', { sym: market.sym, addr: market.addr });
          continue;
        }
        const price = Number(data.pairs[0].priceUsd);
        if (!Number.isFinite(price) || price <= 0) {
          log('WARN', 'PRICE', 'Invalid price for market', { sym: market.sym, price: data.pairs[0].priceUsd });
          continue;
        }
        market.px = price;
        const now = new Date().toISOString();
        market.updatedAt = now;
        market.lastServerUpdate = now;
        log('INFO', 'PRICE', 'Market price updated', { sym: market.sym, price, time: now });
      } catch (err) {
        log('ERROR', 'PRICE', 'Error updating market price', { sym: market.sym, addr: market.addr, error: err.message });
      }
      if (shuttingDown) break;
      // Stagger: wait 1s before next token
      if (idx < markets.length - 1) await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Increase fetch interval to 60s to reduce API load
  intervalId = setInterval(updateAllMarkets, 60000);
  // Run immediately on start
  updateAllMarkets();

  // Graceful shutdown
  function shutdown() {
    if (intervalId) clearInterval(intervalId);
    shuttingDown = true;
    log('INFO', 'SYSTEM', 'PriceKeeper shutdown complete.');
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { startServerPriceKeeper };
