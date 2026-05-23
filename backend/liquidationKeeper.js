// Alert function for liquidations
const { log } = require('./logger');
const ENABLE_ALERTS = String(process.env.ENABLE_ALERTS || '').toLowerCase() === 'true';

async function sendLiquidationAlert(liq) {
  const alertMsg = [
    '⚠️ LIQUIDATION ALERT',
    `User: ${liq.wallet}`,
    `Market: ${liq.market}`,
    `Side: ${liq.side}`,
    `Price: $${liq.executionPrice}`,
    `Margin Lost: ${liq.marginSol} SOL`,
    `Penalty: ${liq.penaltySol} SOL`,
    `Recovered: ${liq.recoveredSol} SOL`,
    `Time: ${liq.timestamp}`
  ].join(' | ');
  if (!ENABLE_ALERTS) {
    log('CRITICAL', 'LIQUIDATION', alertMsg, liq);
    return;
  }
  // Future integration: send email, webhook, SMS, etc.
  // Example:
  // await sendEmailAlert(alertMsg);
  // await sendWebhookAlert(liq);
  // await sendSmsAlert(alertMsg);
  log('CRITICAL', 'LIQUIDATION', alertMsg + ' [ALERT SENT]', liq);
}
// backend/liquidationKeeper.js
// Server-side liquidation keeper for automatic position liquidations

const crypto = require('crypto');

function makeId() {
  return crypto.randomBytes(12).toString('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startLiquidationKeeper({ ledger, logger = console }) {
  if (!ledger || !ledger.wallets || !ledger.markets) throw new Error('LiquidationKeeper: ledger.wallets and ledger.markets required');
  if (!ledger.liquidations) ledger.liquidations = [];
  let intervalId = null;
  let shuttingDown = false;
  let heartbeatCount = 0;

  async function liquidatePosition(account, position, market, pool, attempt = 1) {
    try {
      if (position.liquidating) return false;
      position.liquidating = true;
      const markPrice = market.px;
      const solUsd = ledger.meta?.solUsd || 0;
      const qty = Math.max(0, Number(position.qty) || 0);
      const marginSol = Math.max(0, Number(position.margin) || 0);
      const marginUsd = Math.max(0, Number(position.marginUsd) || 0);
      const liqPrice = Number(position.liq);
      const side = position.side;
      let shouldLiq = false;
      if (side === 'long' && markPrice <= liqPrice) shouldLiq = true;
      if (side === 'short' && markPrice >= liqPrice) shouldLiq = true;
      if (!shouldLiq) {
        position.liquidating = false;
        return false;
      }
      // Penalty and recovery logic (same as endpoint)
      const pnlUsd = side === 'long' ? (markPrice - position.entry) * qty : (position.entry - markPrice) * qty;
      const pnlSol = solUsd > 0 ? pnlUsd / solUsd : 0;
      const penaltySol = Math.max(0, marginSol * 0.05);
      const penaltyUsd = penaltySol * solUsd;
      const recovered = Math.max(0, marginSol + pnlSol - penaltySol - (position.feeSol || 0));
      account.balanceSol = Math.max(0, (account.balanceSol || 0) + recovered);
      account.realizedPnlUsd = (account.realizedPnlUsd || 0) + (pnlUsd - penaltyUsd - (position.feeUsd || 0));
      account.realizedBasisUsd = (account.realizedBasisUsd || 0) + marginUsd;
      if (pool) {
        pool.reservedUsd = Math.max(0, (pool.reservedUsd || 0) - (position.notional || 0));
        pool.insuranceUsd = Math.max(0, (pool.insuranceUsd || 0) + penaltyUsd);
        pool.feeAccruedUsd = Math.max(0, (pool.feeAccruedUsd || 0) + (position.feeUsd || 0));
        pool.liquidityUsd = Math.max(0, (pool.liquidityUsd || 0) - pnlUsd + (position.feeUsd || 0));
      }
      // Remove position
      const idx = (account.positions || []).findIndex((p) => p.id === position.id);
      if (idx >= 0) account.positions.splice(idx, 1);
      // Record liquidation event
      const liq = {
        id: makeId(),
        wallet: account.walletAddress,
        positionId: position.id,
        market: market.sym,
        side,
        executionPrice: markPrice,
        marginSol,
        penaltySol,
        recoveredSol: recovered,
        pnlUsd,
        timestamp: new Date().toISOString(),
        triggeredBy: 'SERVER_KEEPER',
      };
      ledger.liquidations.push(liq);
      log('INFO', 'LIQUIDATION', 'Position liquidated', {
        wallet: account.walletAddress,
        market: market.sym,
        side,
        executionPrice: markPrice,
        marginSol,
        penaltySol,
        recoveredSol: recovered,
        pnlUsd,
      });
      await sendLiquidationAlert(liq);
      return true;
    } catch (err) {
      log('ERROR', 'LIQUIDATION', 'Error liquidating position', { positionId: position.id, error: err.message });
      if (attempt < 3) {
        await sleep(1000);
        return liquidatePosition(account, position, market, pool, attempt + 1);
      }
      return false;
    } finally {
      position.liquidating = false;
    }
  }

  async function checkAllPositions() {
    let checked = 0;
    for (const account of Object.values(ledger.wallets)) {
      for (const position of (account.positions || [])) {
        checked++;
        const market = ledger.markets[position.sym];
        if (!market || !market.px) continue;
        const pool = ledger.pools ? ledger.pools[position.sym] : null;
        await liquidatePosition(account, position, market, pool);
        if (shuttingDown) return;
      }
    }
    heartbeatCount++;
    if (heartbeatCount % 6 === 0) {
      log('INFO', 'LIQUIDATION', 'Keeper heartbeat', { checked });
    }
  }

  intervalId = setInterval(checkAllPositions, 10000);
  // Run immediately on start
  checkAllPositions();

  function shutdown() {
    if (intervalId) clearInterval(intervalId);
    shuttingDown = true;
    log('INFO', 'SYSTEM', 'LiquidationKeeper shutdown complete.');
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { startLiquidationKeeper };
