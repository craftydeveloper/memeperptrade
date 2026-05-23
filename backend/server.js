const { log } = require('./logger');
const MAX_POSITIONS_PER_USER = 10;
const MAX_TOTAL_OI = 1000000;

// Helper to update ledger.stats
function updateLedgerStats(ledger) {
  const allAccounts = Object.values(ledger.wallets || {});
  let totalPositions = 0;
  let totalOI = 0;
  for (const acc of allAccounts) {
    for (const pos of acc.positions || []) {
      totalPositions++;
      totalOI += Number(pos.notional) || 0;
    }
  }
  ledger.stats = {
    totalPositions,
    totalOI,
    totalUsers: allAccounts.length,
    lastUpdated: new Date().toISOString(),
  };
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { startServerPriceKeeper } = require('./priceKeeper');
const { startLiquidationKeeper } = require('./liquidationKeeper');

const app = express();
const PORT = Number(process.env.PORT || 8787);
// Use the actual workspace root for all static and data files
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(WORKSPACE_ROOT, '.data');
const DATA_FILE = path.join(DATA_DIR, 'testnet-shared-ledger.json');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;
const ADD_BALANCE_MAX_SOL = 10;
const ADD_BALANCE_WINDOW_MS = 6 * 60 * 60 * 1000;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MIN_POOL_LIQUIDITY_USD = 50000;

const sessions = new Map();

// Start server-side price keeper (does not block server startup)
setImmediate(() => {
  try {
    startServerPriceKeeper({ ledger: db, logger: log });
    log('INFO', 'SYSTEM', 'PriceKeeper started');
  } catch (err) {
    log('ERROR', 'SYSTEM', 'Failed to start PriceKeeper', { error: err.message });
  }
  try {
    startLiquidationKeeper({ ledger: db, logger: log });
    log('INFO', 'SYSTEM', 'LiquidationKeeper started');
  } catch (err) {
    log('ERROR', 'SYSTEM', 'Failed to start LiquidationKeeper', { error: err.message });
  }
});
const nonces = new Map();
const adminChallenges = new Map();
const adminSessions = new Map();
const rateLimitStore = new Map(); // key -> { count, resetAt }
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PROVIDER_RPC_URL = String(process.env.RPC_URL || '').trim();
const PROVIDER_BIRDEYE_KEY = String(process.env.BIRDEYE_KEY || '').trim();
const ADMIN_WALLET = walletKey(String(process.env.ADMIN_WALLET || process.env.OWNER_WALLET || '').trim());
const ADMIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 60 * 60 * 1000;

function checkRateLimit(key, maxPerWindow) {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { ok: true };
  }
  if (entry.count >= maxPerWindow) {
    return { ok: false, retryAfterMs: entry.resetAt - now };
  }
  entry.count++;
  return { ok: true };
}

function rateLimitBy(keyFn, maxPerWindow) {
  return (req, res, next) => {
    const result = checkRateLimit(keyFn(req), maxPerWindow);
    if (!result.ok) {
      res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      res.status(429).json({ error: 'Too many requests', retryAfterMs: result.retryAfterMs });
      return;
    }
    next();
  };
}

// 10 auth attempts per IP per minute; 30 trading actions per wallet per minute
const authRateLimit = rateLimitBy((req) => `auth:${req.ip}`, 10);
const tradingRateLimit = rateLimitBy((req) => {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const sess = sessions.get(token);
  return sess ? `trade:${sess.walletAddress}` : `trade:ip:${req.ip}`;
}, 30);
const providerRateLimit = rateLimitBy((req) => `provider:${req.ip}`, 120);
const betaJoinRateLimit = rateLimitBy((req) => `beta-join:${req.ip}`, 12);
const adminRateLimit = rateLimitBy((req) => `beta-admin:${req.ip}`, 30);

const NODE_ENV = String(process.env.NODE_ENV || 'development').toLowerCase();
const IS_PROD = NODE_ENV === 'production';
const DEV_ALLOWED_ORIGINS = new Set([
  'http://localhost:8787',
  'http://127.0.0.1:8787',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
]);

function parseAllowedOrigins() {
  const raw = String(process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const configuredOrigins = parseAllowedOrigins();
// Wildcard CORS is never allowed in production — a misconfigured env var should not open all origins
const ALLOW_ANY_ORIGIN = !IS_PROD && configuredOrigins.includes('*');
const allowedOriginSet = new Set(configuredOrigins.filter((origin) => origin !== '*'));
if (!IS_PROD) {
  DEV_ALLOWED_ORIGINS.forEach((origin) => allowedOriginSet.add(origin));
}
const ALLOW_NULL_ORIGIN = !IS_PROD || process.env.ALLOW_NULL_ORIGIN === '1';

const corsOptions = {
  origin: (origin, callback) => {
    // Keep non-browser callers working (curl, health checks).
    if (!origin) return callback(null, true);
    // file:// and sandboxed origins should only be allowed outside production unless explicitly enabled.
    if (origin === 'null') return callback(null, ALLOW_NULL_ORIGIN);
    if (ALLOW_ANY_ORIGIN) return callback(null, true);
    if (allowedOriginSet.has(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

console.log(
  `[CORS] env=${NODE_ENV} allowAny=${ALLOW_ANY_ORIGIN} allowNull=${ALLOW_NULL_ORIGIN} allowedOrigins=${Array.from(allowedOriginSet).join(',') || '(none)'}`
);

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // explicit pre-flight for all routes
app.use(express.json({ limit: '1mb' }));

// Secure HTTP headers (no external dep needed)
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-XSS-Protection', '0');
  res.set('X-Permitted-Cross-Domain-Policies', 'none');
  next();
});

// Request logging — redact path/origin details in production to avoid leaking request patterns
app.use((req, _res, next) => {
  if (!IS_PROD) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} origin=${req.headers.origin || '—'}`);
  }
  next();
});

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDb() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    return { wallets: {}, markets: {}, pools: {}, meta: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { wallets: {}, markets: {}, pools: {}, meta: {} };
  } catch {
    return { wallets: {}, markets: {}, pools: {}, meta: {} };
  }
}

function ensureDbShape(nextDb) {
  const shaped = nextDb && typeof nextDb === 'object' ? nextDb : {};
  if (!shaped.wallets || typeof shaped.wallets !== 'object') shaped.wallets = {};
  if (!shaped.markets || typeof shaped.markets !== 'object') shaped.markets = {};
  if (!shaped.pools || typeof shaped.pools !== 'object') shaped.pools = {};
  if (!shaped.meta || typeof shaped.meta !== 'object') shaped.meta = {};
  shaped.meta.solUsd = Math.max(0, clampNumber(shaped.meta.solUsd, 0));
  return shaped;
}

let db = ensureDbShape(loadDb());

function saveDb() {
  ensureDataDir();
  const tmp = `${DATA_FILE}.tmp`;
  db = ensureDbShape(db);
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function nowIso() {
  return new Date().toISOString();
}

function clampNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function walletKey(walletAddress) {
  return String(walletAddress || '').trim().toLowerCase();
}

function marketKey(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function marketAddressKey(address) {
  return String(address || '').trim().toLowerCase();
}

function findStoredMarketKey(inputMarket) {
  const addr = marketAddressKey(typeof inputMarket === 'string' ? '' : inputMarket?.addr);
  const sym = marketKey(typeof inputMarket === 'string' ? inputMarket : inputMarket?.sym);

  if (addr) {
    const byAddr = Object.keys(db.markets).find((key) => marketAddressKey(db.markets[key]?.addr) === addr);
    if (byAddr) return byAddr;
  }

  if (sym) {
    if (db.markets[sym]) return sym;
    const bySym = Object.keys(db.markets).find((key) => marketKey(db.markets[key]?.sym) === sym);
    if (bySym) return bySym;
  }

  return addr || sym || '';
}

function makeId() {
  return crypto.randomBytes(12).toString('hex');
}

function base58Decode(input) {
  const text = String(input || '').trim();
  if (!text) return Buffer.alloc(0);
  const bytes = [0];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const value = BASE58_ALPHABET.indexOf(char);
    if (value < 0) throw new Error('Invalid base58 character');
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      const x = bytes[j] * 58 + carry;
      bytes[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < text.length && text[i] === '1'; i += 1) {
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

function isValidWalletAddress(walletAddress) {
  try {
    return base58Decode(walletAddress).length === 32;
  } catch {
    return false;
  }
}

function createWalletPublicKey(walletAddress) {
  const raw = base58Decode(walletAddress);
  if (raw.length !== 32) throw new Error('Invalid wallet public key length');
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function verifyWalletSignature(walletAddress, message, signatureBase64) {
  try {
    const publicKey = createWalletPublicKey(walletAddress);
    const signature = Buffer.from(String(signatureBase64 || ''), 'base64');
    if (signature.length !== 64) return false;
    return crypto.verify(null, Buffer.from(String(message || ''), 'utf8'), publicKey, signature);
  } catch {
    return false;
  }
}

function buildNonceMessage(walletAddress, nonce, issuedAt) {
  return [
    'MemePerp Testnet Login',
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

function sanitizeMarket(market) {
  const sym = marketKey(market?.sym);
  return {
    sym,
    name: String(market?.name || sym || 'Token'),
    addr: String(market?.addr || '').trim(),
    px: Math.max(0, clampNumber(market?.px, 0)),
    maxLev: Math.max(1, clampNumber(market?.maxLev, 20)),
    oiCap: Math.max(0, clampNumber(market?.oiCap, 0)),
    enabled: market?.enabled !== false,
    delisted: !!market?.delisted,
    updatedAt: String(market?.updatedAt || nowIso()),
  };
}

function sanitizePool(pool, market = {}) {
  const sym = marketKey(pool?.sym || market?.sym);
  const oiCap = Math.max(0, clampNumber(market?.oiCap, pool?.oiCap || 0));
  const defaultLiquidityUsd = Math.max(MIN_POOL_LIQUIDITY_USD, oiCap > 0 ? oiCap * 8 : 0);
  return {
    sym,
    name: String(pool?.name || market?.name || sym || 'Token'),
    addr: String(pool?.addr || market?.addr || '').trim(),
    liquidityUsd: Math.max(MIN_POOL_LIQUIDITY_USD, clampNumber(pool?.liquidityUsd, defaultLiquidityUsd)),
    reservedUsd: Math.max(0, clampNumber(pool?.reservedUsd, 0)),
    longOpenInterestUsd: Math.max(0, clampNumber(pool?.longOpenInterestUsd, 0)),
    shortOpenInterestUsd: Math.max(0, clampNumber(pool?.shortOpenInterestUsd, 0)),
    insuranceUsd: Math.max(0, clampNumber(pool?.insuranceUsd, 0)),
    feeAccruedUsd: Math.max(0, clampNumber(pool?.feeAccruedUsd, 0)),
    maxUtilizationPct: Math.min(95, Math.max(10, clampNumber(pool?.maxUtilizationPct, 70))),
    baseSpreadBps: Math.max(1, clampNumber(pool?.baseSpreadBps, 12)),
    impactFactor: Math.max(0.001, clampNumber(pool?.impactFactor, 0.18)),
    skewFactor: Math.max(0.001, clampNumber(pool?.skewFactor, 0.08)),
    feeOpenBps: Math.max(0, clampNumber(pool?.feeOpenBps, 10)),
    feeCloseBps: Math.max(0, clampNumber(pool?.feeCloseBps, 10)),
    maintenanceMarginRatio: Math.min(0.5, Math.max(0.005, clampNumber(pool?.maintenanceMarginRatio, 0.06))),
    oiCap,
    updatedAt: String(pool?.updatedAt || nowIso()),
  };
}

function upsertObservedMarket(inputMarket) {
  const sym = marketKey(inputMarket?.sym);
  const key = findStoredMarketKey(inputMarket);
  if (!key || !sym) return null;
  const existing = db.markets[key] ? sanitizeMarket(db.markets[key]) : sanitizeMarket({ sym, addr: inputMarket?.addr });
  const next = sanitizeMarket({
    ...existing,
    ...inputMarket,
    sym,
    name: inputMarket?.name || existing.name,
    addr: inputMarket?.addr || existing.addr,
    px: clampNumber(inputMarket?.px, existing.px),
    maxLev: clampNumber(inputMarket?.maxLev, existing.maxLev),
    oiCap: clampNumber(inputMarket?.oiCap, existing.oiCap),
    enabled: inputMarket?.enabled == null ? existing.enabled : inputMarket.enabled,
    delisted: inputMarket?.delisted == null ? existing.delisted : inputMarket.delisted,
    updatedAt: nowIso(),
  });
  db.markets[key] = next;
  const currentPool = db.pools[key] ? sanitizePool(db.pools[key], next) : sanitizePool({ sym, addr: next.addr }, next);
  db.pools[key] = sanitizePool({ ...currentPool, name: next.name, addr: next.addr, oiCap: next.oiCap, updatedAt: nowIso() }, next);
  return db.markets[key];
}

function getMarketRecord(inputMarket) {
  const key = findStoredMarketKey(inputMarket);
  if (!key) return null;
  if (inputMarket && typeof inputMarket === 'object') return upsertObservedMarket(inputMarket);
  if (!db.markets[key]) {
    const sym = marketKey(typeof inputMarket === 'string' ? inputMarket : inputMarket?.sym);
    if (!sym) return null;
    db.markets[key] = sanitizeMarket({ sym, addr: typeof inputMarket === 'object' ? inputMarket?.addr : '' });
  }
  return sanitizeMarket(db.markets[key]);
}

function getPoolRecord(inputMarket) {
  const market = getMarketRecord(inputMarket);
  if (!market) return null;
  const key = findStoredMarketKey(market);
  if (!db.pools[key]) db.pools[key] = sanitizePool({ sym: market.sym, addr: market.addr }, market);
  db.pools[key] = sanitizePool(db.pools[key], market);
  return db.pools[key];
}

function getSolUsdPrice() {
  return Math.max(0, clampNumber(db.meta?.solUsd, 0));
}

function syncObservedMarkets(markets = [], solUsd = 0) {
  if (Number.isFinite(Number(solUsd)) && Number(solUsd) > 0) db.meta.solUsd = Number(solUsd);
  let changed = false;
  (Array.isArray(markets) ? markets : []).forEach((market) => {
    const next = upsertObservedMarket(market);
    if (next) changed = true;
  });
  const triggered = processPendingLimitOrders();
  const tpSlTriggered = processTpSlTriggers();
  if (changed || triggered || tpSlTriggered || db.meta.solUsd > 0) saveDb();
}

function getDirectionalPremiumPct(pool, side, notionalUsd) {
  const liquidityUsd = Math.max(pool?.liquidityUsd || 0, 1);
  const sizeRatio = Math.max(0, notionalUsd) / liquidityUsd;
  const skewBefore = Math.max(0, clampNumber(pool?.longOpenInterestUsd, 0)) - Math.max(0, clampNumber(pool?.shortOpenInterestUsd, 0));
  const direction = side === 'short' ? -1 : 1;
  const skewAfter = skewBefore + (direction * Math.max(0, notionalUsd));
  const spreadPct = Math.max(0.0001, clampNumber(pool?.baseSpreadBps, 0) / 10000);
  const impactPct = sizeRatio * Math.max(0.001, clampNumber(pool?.impactFactor, 0.18));
  const skewBias = Math.max((direction * skewBefore) / liquidityUsd, (direction * skewAfter) / liquidityUsd);
  const skewPct = Math.max(-(spreadPct * 0.5), skewBias * Math.max(0.001, clampNumber(pool?.skewFactor, 0.08)));
  return {
    spreadPct,
    impactPct,
    skewPct,
    totalPct: Math.max(0.0001, spreadPct + impactPct + skewPct),
    skewBefore,
    skewAfter,
  };
}

function computeLiquidationPrice({ entryPrice, quantity, marginUsd, side, maintenanceMarginRatio }) {
  const entry = Math.max(0, clampNumber(entryPrice, 0));
  const qty = Math.max(0, clampNumber(quantity, 0));
  const margin = Math.max(0, clampNumber(marginUsd, 0));
  const mmr = Math.min(0.95, Math.max(0.001, clampNumber(maintenanceMarginRatio, 0.06)));
  if (!entry || !qty) return 0;

  if (side === 'short') {
    const denom = qty * (1 + mmr);
    if (denom <= 0) return 0;
    return Math.max(0.0000001, (margin + (entry * qty)) / denom);
  }

  const denom = qty * (1 - mmr);
  if (denom <= 0) return 0;
  return Math.max(0.0000001, ((entry * qty) - margin) / denom);
}

function buildTradeQuote({ market, pool, side, marginSol, leverage, mode = 'open', quantity = 0, positionNotionalUsd = 0 }) {
  const normalizedSide = side === 'short' ? 'short' : 'long';
  const solUsd = getSolUsdPrice();
  const midPrice = Math.max(0, clampNumber(market?.px, 0));
  const lev = Math.max(1, clampNumber(leverage, 1));
  if (!midPrice) return { error: 'Market price unavailable' };
  if (!solUsd) return { error: 'SOL/USD price unavailable' };

  const notionalUsd = mode === 'open'
    ? Math.max(0, marginSol * solUsd * lev)
    : Math.max(0, clampNumber(positionNotionalUsd, 0) || (Math.max(0, clampNumber(quantity, 0)) * midPrice));
  if (!notionalUsd) return { error: mode === 'open' ? 'Trade size too small' : 'Position notional unavailable' };

  const executionSide = mode === 'open'
    ? normalizedSide
    : (normalizedSide === 'long' ? 'short' : 'long');
  const premium = getDirectionalPremiumPct(pool, executionSide, notionalUsd);
  // Use raw market price as execution price — no spread/impact/skew markup applied to entry
  const executionPrice = Math.max(0.0000001, midPrice);
  const feeBps = mode === 'open' ? Math.max(0, clampNumber(pool?.feeOpenBps, 0)) : Math.max(0, clampNumber(pool?.feeCloseBps, 0));
  const feeUsd = notionalUsd * (feeBps / 10000);
  const feeSol = solUsd > 0 ? feeUsd / solUsd : 0;
  const marginUsd = Math.max(0, marginSol * solUsd);
  const quantityOut = mode === 'open' ? (executionPrice > 0 ? notionalUsd / executionPrice : 0) : Math.max(0, clampNumber(quantity, 0));
  const maintenanceMarginRatio = Math.max(0.005, clampNumber(pool?.maintenanceMarginRatio, 0.06));
  const liqPrice = mode === 'open'
    ? computeLiquidationPrice({
      entryPrice: executionPrice,
      quantity: quantityOut,
      marginUsd,
      side: normalizedSide,
      maintenanceMarginRatio,
    })
    : 0;
  const utilizationAfterPct = Math.max(0, ((Math.max(0, clampNumber(pool?.reservedUsd, 0)) + (mode === 'open' ? notionalUsd : 0)) / Math.max(1, clampNumber(pool?.liquidityUsd, MIN_POOL_LIQUIDITY_USD))) * 100);
  return {
    mode,
    side: normalizedSide,
    market: marketKey(market?.sym),
    midPrice,
    executionPrice,
    marginUsd,
    notionalUsd,
    quantity: quantityOut,
    leverage: lev,
    liqPrice,
    maintenanceMarginRatio,
    feeUsd,
    feeSol,
    spreadPct: premium.spreadPct * 100,
    impactPct: premium.impactPct * 100,
    skewPct: premium.skewPct * 100,
    totalPremiumPct: premium.totalPct * 100,
    utilizationAfterPct,
    maxUtilizationPct: Math.max(0, clampNumber(pool?.maxUtilizationPct, 70)),
    poolLiquidityUsd: Math.max(0, clampNumber(pool?.liquidityUsd, 0)),
    reservedUsd: Math.max(0, clampNumber(pool?.reservedUsd, 0)),
    solUsd,
  };
}

function applyMarginModeToQuote({ account, quote, marginMode, side, marginSol }) {
  if (!quote || typeof quote !== 'object') return quote;
  const normalizedMode = marginMode === 'cross' ? 'cross' : 'isolated';
  quote.marginMode = normalizedMode;

  if (normalizedMode !== 'cross') {
    quote.effectiveMarginUsd = quote.marginUsd;
    return quote;
  }

  const accountBalanceSol = Math.max(0, clampNumber(account?.balanceSol, 0));
  const balanceAfterOpenUsd = Math.max(0, (accountBalanceSol - (Math.max(0, clampNumber(marginSol, 0)) + Math.max(0, clampNumber(quote.feeSol, 0)))) * Math.max(0, clampNumber(quote.solUsd, 0)));
  const existingCross = (Array.isArray(account?.positions) ? account.positions : []).filter((position) => String(position?.status || 'open') === 'open' && position?.marginMode === 'cross');
  const existingCrossNotional = existingCross.reduce((sum, position) => sum + Math.max(0, clampNumber(position?.notional, 0)), 0);
  const totalCrossNotionalAfter = existingCrossNotional + Math.max(0, clampNumber(quote.notionalUsd, 0));
  const bufferShare = totalCrossNotionalAfter > 0 ? (balanceAfterOpenUsd * (Math.max(0, clampNumber(quote.notionalUsd, 0)) / totalCrossNotionalAfter)) : balanceAfterOpenUsd;
  const effectiveMarginUsd = Math.max(quote.marginUsd, quote.marginUsd + Math.max(0, bufferShare));

  quote.effectiveMarginUsd = effectiveMarginUsd;
  quote.liqPrice = computeLiquidationPrice({
    entryPrice: quote.executionPrice,
    quantity: quote.quantity,
    marginUsd: effectiveMarginUsd,
    side,
    maintenanceMarginRatio: quote.maintenanceMarginRatio,
  });
  return quote;
}

function applyPoolOpen(pool, side, notionalUsd, feeUsd) {
  const next = pool;
  next.reservedUsd = Math.max(0, clampNumber(next.reservedUsd, 0) + notionalUsd);
  if (side === 'short') next.shortOpenInterestUsd = Math.max(0, clampNumber(next.shortOpenInterestUsd, 0) + notionalUsd);
  else next.longOpenInterestUsd = Math.max(0, clampNumber(next.longOpenInterestUsd, 0) + notionalUsd);
  next.feeAccruedUsd = Math.max(0, clampNumber(next.feeAccruedUsd, 0) + feeUsd);
  next.liquidityUsd = Math.max(MIN_POOL_LIQUIDITY_USD, clampNumber(next.liquidityUsd, MIN_POOL_LIQUIDITY_USD) + feeUsd);
  next.updatedAt = nowIso();
}

function applyPoolRelease(pool, side, releasedNotionalUsd) {
  const next = pool;
  next.reservedUsd = Math.max(0, clampNumber(next.reservedUsd, 0) - releasedNotionalUsd);
  if (side === 'short') next.shortOpenInterestUsd = Math.max(0, clampNumber(next.shortOpenInterestUsd, 0) - releasedNotionalUsd);
  else next.longOpenInterestUsd = Math.max(0, clampNumber(next.longOpenInterestUsd, 0) - releasedNotionalUsd);
  next.updatedAt = nowIso();
}

function getWalletRecord(walletAddress) {
  const key = walletKey(walletAddress);
  if (!db.wallets[key]) {
    db.wallets[key] = {
      walletAddress: key,
      balanceSol: 0,
      realizedPnlUsd: 0,
      realizedBasisUsd: 0,
      positions: [],
      openOrders: [],
      history: [],
      balanceGrants: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }
  return db.wallets[key];
}

function sortHistoryDesc(history) {
  return [...history].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
}

function sanitizeHistoryEntry(entry, walletAddress) {
  return {
    id: String(entry?.id || makeId()),
    ts: String(entry?.ts || nowIso()),
    type: String(entry?.type || 'INFO'),
    msg: String(entry?.msg || ''),
    sig: entry?.sig ? String(entry.sig) : '—',
    chainStatus: String(entry?.chainStatus || '—'),
    walletOwner: walletKey(entry?.walletOwner || walletAddress),
  };
}

function sanitizePosition(position, walletAddress) {
  const side = position?.side === 'short' ? 'short' : 'long';
  const marginMode = position?.marginMode === 'cross' ? 'cross' : 'isolated';
  const margin = Math.max(0, clampNumber(position?.margin, 0));
  const marginUsd = Math.max(0, clampNumber(position?.marginUsd, 0));
  const effectiveMarginUsd = marginMode === 'cross'
    ? Math.max(marginUsd, clampNumber(position?.effectiveMarginUsd, marginUsd))
    : marginUsd;
  const lev = Math.max(1, clampNumber(position?.lev, 1));
  const entry = Math.max(0, clampNumber(position?.entry, 0));
  const qty = Math.max(0, clampNumber(position?.qty, 0));
  const maintenanceMarginRatio = Math.min(0.95, Math.max(0.001, clampNumber(position?.maintenanceMarginRatio, 0.06)));
  const recomputedLiq = computeLiquidationPrice({
    entryPrice: entry,
    quantity: qty,
    marginUsd: effectiveMarginUsd,
    side,
    maintenanceMarginRatio,
  });
  const liq = recomputedLiq > 0 ? recomputedLiq : Math.max(0, clampNumber(position?.liq, 0));
  const rawTpSl = position?.tpSl && typeof position.tpSl === 'object'
    ? position.tpSl
    : {
      tp: position?.tp,
      tpRoi: position?.tpRoi,
      sl: position?.sl,
      slRoi: position?.slRoi,
      tpQty: position?.tpQty,
      tpQtyPct: position?.tpQtyPct,
      slQty: position?.slQty,
      slQtyPct: position?.slQtyPct,
    };
  const tpSl = {
    tp: rawTpSl?.tp == null ? null : Math.max(0, clampNumber(rawTpSl.tp, 0)),
    tpRoi: rawTpSl?.tpRoi == null ? null : clampNumber(rawTpSl.tpRoi, 0),
    sl: rawTpSl?.sl == null ? null : Math.max(0, clampNumber(rawTpSl.sl, 0)),
    slRoi: rawTpSl?.slRoi == null ? null : clampNumber(rawTpSl.slRoi, 0),
    tpQty: rawTpSl?.tpQty == null ? null : Math.max(0, clampNumber(rawTpSl.tpQty, 0)),
    tpQtyPct: rawTpSl?.tpQtyPct == null ? null : Math.min(100, Math.max(0, clampNumber(rawTpSl.tpQtyPct, 0))),
    slQty: rawTpSl?.slQty == null ? null : Math.max(0, clampNumber(rawTpSl.slQty, 0)),
    slQtyPct: rawTpSl?.slQtyPct == null ? null : Math.min(100, Math.max(0, clampNumber(rawTpSl.slQtyPct, 0))),
  };

  return {
    id: String(position?.id || makeId()),
    walletOwner: walletKey(position?.walletOwner || walletAddress),
    sym: String(position?.sym || 'TOKEN'),
    name: String(position?.name || position?.sym || 'Token'),
    addr: String(position?.addr || ''),
    side,
    marginMode,
    margin,
    marginUsd,
    effectiveMarginUsd,
    lev,
    entry,
    qty,
    liq,
    maintenanceMarginRatio,
    notional: Math.max(0, clampNumber(position?.notional, 0)),
    limit: position?.limit == null ? null : clampNumber(position.limit, 0),
    tpSl,
    tp: tpSl.tp,
    tpRoi: tpSl.tpRoi,
    sl: tpSl.sl,
    slRoi: tpSl.slRoi,
    tpQty: tpSl.tpQty,
    tpQtyPct: tpSl.tpQtyPct,
    slQty: tpSl.slQty,
    slQtyPct: tpSl.slQtyPct,
    status: String(position?.status || 'open'),
    openedAt: String(position?.openedAt || nowIso()),
  };
}

function sanitizeOpenOrder(order, walletAddress) {
  return {
    id: String(order?.id || makeId()),
    walletOwner: walletKey(order?.walletOwner || walletAddress),
    sym: String(order?.sym || 'TOKEN'),
    name: String(order?.name || order?.sym || 'Token'),
    addr: String(order?.addr || ''),
    side: order?.side === 'short' ? 'short' : 'long',
    marginMode: order?.marginMode === 'cross' ? 'cross' : 'isolated',
    marginSol: Math.max(0, clampNumber(order?.marginSol, 0)),
    leverage: Math.max(1, clampNumber(order?.leverage, 1)),
    limitPrice: Math.max(0, clampNumber(order?.limitPrice, 0)),
    orderType: 'limit',
    status: 'open',
    auditSig: order?.auditSig ? String(order.auditSig) : '—',
    createdAt: String(order?.createdAt || nowIso()),
  };
}

function sanitizeTpSlPayload(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    tp: raw.tp == null ? null : Math.max(0, clampNumber(raw.tp, 0)),
    tpRoi: raw.tpRoi == null ? null : clampNumber(raw.tpRoi, 0),
    sl: raw.sl == null ? null : Math.max(0, clampNumber(raw.sl, 0)),
    slRoi: raw.slRoi == null ? null : clampNumber(raw.slRoi, 0),
    tpQty: raw.tpQty == null ? null : Math.max(0, clampNumber(raw.tpQty, 0)),
    tpQtyPct: raw.tpQtyPct == null ? null : Math.min(100, Math.max(0, clampNumber(raw.tpQtyPct, 0))),
    slQty: raw.slQty == null ? null : Math.max(0, clampNumber(raw.slQty, 0)),
    slQtyPct: raw.slQtyPct == null ? null : Math.min(100, Math.max(0, clampNumber(raw.slQtyPct, 0))),
  };
}

function hasAnyTpSl(tpSl) {
  return !!(tpSl && typeof tpSl === 'object' && (
    tpSl.tp != null || tpSl.tpRoi != null || tpSl.sl != null || tpSl.slRoi != null
  ));
}

function computePriceFromRoi(entryPrice, roiPct, side, leverage, leg = 'tp') {
  const entry = Math.max(0, clampNumber(entryPrice, 0));
  const roiMagnitude = Math.abs(clampNumber(roiPct, 0));
  const roi = leg === 'sl' ? -roiMagnitude : roiMagnitude;
  const lev = Math.max(1, clampNumber(leverage, 1));
  if (!entry || !Number.isFinite(roi)) return 0;
  // ROI is on margin (leveraged), so price move = roi / leverage.
  // TP ROI always maps to profit-direction; SL ROI always maps to loss-direction.
  const result = side === 'short'
    ? entry * (1 - (roi / (lev * 100)))
    : entry * (1 + (roi / (lev * 100)));
  return Math.max(0, result);
}

function resolveTpSlPrice(position, tpSl, leg) {
  if (!position || !tpSl) return 0;
  const side = position.side === 'short' ? 'short' : 'long';
  const entry = Math.max(0, clampNumber(position.entry, 0));
  const lev = Math.max(1, clampNumber(position.lev, 1));
  if (!entry) return 0;
  if (leg === 'tp') {
    if (tpSl.tp != null && tpSl.tp > 0) return Math.max(0, clampNumber(tpSl.tp, 0));
    if (tpSl.tpRoi != null) return computePriceFromRoi(entry, tpSl.tpRoi, side, lev, 'tp');
    return 0;
  }
  if (tpSl.sl != null && tpSl.sl > 0) return Math.max(0, clampNumber(tpSl.sl, 0));
  if (tpSl.slRoi != null) return computePriceFromRoi(entry, tpSl.slRoi, side, lev, 'sl');
  return 0;
}

function resolveTpSlClosePct(position, tpSl, leg) {
  const qty = Math.max(0, clampNumber(position?.qty, 0));
  if (!qty) return null;
  const qtyField = leg === 'tp' ? 'tpQty' : 'slQty';
  const pctField = leg === 'tp' ? 'tpQtyPct' : 'slQtyPct';
  const rawQty = tpSl?.[qtyField];
  if (rawQty != null) {
    const cappedQty = Math.min(qty, Math.max(0, clampNumber(rawQty, 0)));
    const pct = (cappedQty / qty) * 100;
    return Math.min(100, Math.max(0, pct));
  }
  const rawPct = tpSl?.[pctField];
  if (rawPct != null) return Math.min(100, Math.max(0, clampNumber(rawPct, 0)));
  // No qty/% set — caller must skip this trigger
  return null;
}

function validateTpSlForExecution({ side, entryPrice, leverage, quantity, tpSl }) {
  const payload = sanitizeTpSlPayload(tpSl || {});
  if (!hasAnyTpSl(payload)) return { ok: true, tpSl: payload };

  const simulatedPosition = {
    side: side === 'short' ? 'short' : 'long',
    entry: Math.max(0, clampNumber(entryPrice, 0)),
    lev: Math.max(1, clampNumber(leverage, 1)),
    qty: Math.max(0, clampNumber(quantity, 0)),
  };

  const tpPrice = resolveTpSlPrice(simulatedPosition, payload, 'tp');
  const slPrice = resolveTpSlPrice(simulatedPosition, payload, 'sl');
  const tpPct = resolveTpSlClosePct(simulatedPosition, payload, 'tp');
  const slPct = resolveTpSlClosePct(simulatedPosition, payload, 'sl');

  if (tpPrice > 0 && tpPct == null) {
    return { ok: false, error: 'TP requires a close quantity or close percentage.', code: 'TP_QTY_REQUIRED' };
  }
  if (slPrice > 0 && slPct == null) {
    return { ok: false, error: 'SL requires a close quantity or close percentage.', code: 'SL_QTY_REQUIRED' };
  }

  if (tpPrice > 0) {
    const invalidTp = simulatedPosition.side === 'short' ? tpPrice >= simulatedPosition.entry : tpPrice <= simulatedPosition.entry;
    if (invalidTp) {
      return {
        ok: false,
        error: `TP would trigger immediately at entry. ${simulatedPosition.side === 'short' ? 'Short TP must be below entry.' : 'Long TP must be above entry.'}`,
        code: 'TP_IMMEDIATE_TRIGGER',
      };
    }
  }

  if (slPrice > 0) {
    const invalidSl = simulatedPosition.side === 'short' ? slPrice <= simulatedPosition.entry : slPrice >= simulatedPosition.entry;
    if (invalidSl) {
      return {
        ok: false,
        error: `SL would trigger immediately at entry. ${simulatedPosition.side === 'short' ? 'Short SL must be above entry.' : 'Long SL must be below entry.'}`,
        code: 'SL_IMMEDIATE_TRIGGER',
      };
    }
  }

  return { ok: true, tpSl: payload };
}

function isTpTriggered(side, markPrice, triggerPrice) {
  const mark = Math.max(0, clampNumber(markPrice, 0));
  const trigger = Math.max(0, clampNumber(triggerPrice, 0));
  if (!mark || !trigger) return false;
  return side === 'short' ? mark <= trigger : mark >= trigger;
}

function isSlTriggered(side, markPrice, triggerPrice) {
  const mark = Math.max(0, clampNumber(markPrice, 0));
  const trigger = Math.max(0, clampNumber(triggerPrice, 0));
  if (!mark || !trigger) return false;
  return side === 'short' ? mark >= trigger : mark <= trigger;
}

function isLimitOrderTriggerable(side, markPrice, limitPrice) {
  const mark = Math.max(0, clampNumber(markPrice, 0));
  const limit = Math.max(0, clampNumber(limitPrice, 0));
  if (!mark || !limit) return false;
  if (side === 'short') return mark >= limit;
  return mark <= limit;
}

function applyOpenPositionToAccount({
  account,
  observedMarket,
  pool,
  side,
  marginMode,
  marginSol,
  leverage,
  limitPrice,
  tpSl,
  auditSig,
  quote,
}) {
  const existingPositionIndex = account.positions.findIndex((position) => (
    walletKey(position.walletOwner) === account.walletAddress
    && (
      (marketAddressKey(position.addr) && marketAddressKey(position.addr) === marketAddressKey(observedMarket.addr))
      || marketKey(position.sym) === marketKey(observedMarket.sym)
    )
    && String(position.status || 'open') === 'open'
  ));
  const existingPosition = existingPositionIndex >= 0 ? account.positions[existingPositionIndex] : null;
  if (existingPosition && existingPosition.side !== side) {
    return {
      ok: false,
      status: 409,
      error: `You already have an open ${existingPosition.side.toUpperCase()} ${observedMarket.sym} position. Reduce/close it before switching side.`,
      code: 'OPPOSITE_POSITION_EXISTS',
    };
  }
  if (existingPosition && existingPosition.marginMode !== marginMode) {
    return {
      ok: false,
      status: 409,
      error: `Existing ${observedMarket.sym} position is in ${String(existingPosition.marginMode).toUpperCase()} mode. Close it before switching margin mode.`,
      code: 'MARGIN_MODE_MISMATCH',
    };
  }

  const totalRequiredSol = Math.max(0, marginSol + Math.max(0, clampNumber(quote?.feeSol, 0)));
  if (totalRequiredSol > Math.max(0, clampNumber(account.balanceSol, 0)) + 1e-9) {
    return {
      ok: false,
      status: 400,
      error: 'Insufficient shared balance',
      code: 'INSUFFICIENT_BALANCE',
    };
  }

  account.balanceSol = Math.max(0, account.balanceSol - totalRequiredSol);
  applyPoolOpen(pool, side, quote.notionalUsd, quote.feeUsd);
  let positionAction = 'OPEN';
  if (!existingPosition) {
    account.positions.push(sanitizePosition({
      id: makeId(),
      walletOwner: account.walletAddress,
      sym: observedMarket.sym,
      name: observedMarket.name || observedMarket.sym,
      addr: observedMarket.addr || '',
      side,
      marginMode,
      margin: marginSol,
      marginUsd: quote.marginUsd,
      effectiveMarginUsd: Math.max(quote.marginUsd, clampNumber(quote.effectiveMarginUsd, quote.marginUsd)),
      lev: leverage,
      entry: quote.executionPrice,
      qty: quote.quantity,
      liq: quote.liqPrice,
      maintenanceMarginRatio: quote.maintenanceMarginRatio,
      notional: quote.notionalUsd,
      limit: limitPrice,
      tpSl: sanitizeTpSlPayload(tpSl),
      status: 'open',
      openedAt: nowIso(),
    }, account.walletAddress));
  } else {
    const currentQty = Math.max(0, clampNumber(existingPosition.qty, 0));
    const addQty = Math.max(0, clampNumber(quote.quantity, 0));
    const nextQty = currentQty + addQty;
    const nextEntry = nextQty > 0
      ? (((Math.max(0, clampNumber(existingPosition.entry, 0)) * currentQty) + (quote.executionPrice * addQty)) / nextQty)
      : Math.max(0, clampNumber(existingPosition.entry, 0));
    const nextMargin = Math.max(0, clampNumber(existingPosition.margin, 0)) + marginSol;
    const nextMarginUsd = Math.max(0, clampNumber(existingPosition.marginUsd, 0)) + quote.marginUsd;
    const nextNotional = Math.max(0, clampNumber(existingPosition.notional, 0)) + quote.notionalUsd;
    const mmr = Math.max(0.005, clampNumber(existingPosition.maintenanceMarginRatio, quote.maintenanceMarginRatio || 0.06));
    const nextLev = nextMarginUsd > 0 ? (nextNotional / nextMarginUsd) : Math.max(1, clampNumber(existingPosition.lev, leverage));
    const nextLiq = computeLiquidationPrice({
      entryPrice: nextEntry,
      quantity: nextQty,
      marginUsd: nextMarginUsd,
      side,
      maintenanceMarginRatio: mmr,
    });

    account.positions[existingPositionIndex] = sanitizePosition({
      ...existingPosition,
      sym: observedMarket.sym,
      name: observedMarket.name || observedMarket.sym,
      addr: observedMarket.addr || existingPosition.addr || '',
      side,
      marginMode,
      margin: nextMargin,
      marginUsd: nextMarginUsd,
      effectiveMarginUsd: nextMarginUsd,
      lev: nextLev,
      entry: nextEntry,
      qty: nextQty,
      liq: nextLiq,
      maintenanceMarginRatio: mmr,
      notional: nextNotional,
      limit: limitPrice == null ? existingPosition.limit : limitPrice,
      tpSl: hasAnyTpSl(tpSl) ? sanitizeTpSlPayload(tpSl) : (existingPosition.tpSl || null),
      status: 'open',
      openedAt: existingPosition.openedAt || nowIso(),
    }, account.walletAddress);
    positionAction = 'ADD';
  }

  appendHistory(account, positionAction, `${positionAction === 'ADD' ? 'Added to' : side.toUpperCase()} ${observedMarket.sym} ${marginSol.toFixed(2)} SOL ($${quote.marginUsd.toFixed(2)}) @ ${quote.executionPrice.toFixed(6)} · impact ${quote.totalPremiumPct.toFixed(2)}% · fee $${quote.feeUsd.toFixed(2)}`, auditSig);
  recalcAccountRiskMetrics(account);
  persistRecord(account);
  return { ok: true, positionAction };
}

function processPendingLimitOrders() {
  let changed = false;
  Object.keys(db.wallets || {}).forEach((walletAddr) => {
    const account = getWalletRecord(walletAddr);
    if (!Array.isArray(account.openOrders) || !account.openOrders.length) return;
    const nextOrders = [];
    account.openOrders.forEach((rawOrder) => {
      const order = sanitizeOpenOrder(rawOrder, walletAddr);
      const market = getMarketRecord({ sym: order.sym, name: order.name, addr: order.addr });
      if (!market?.sym || !market?.px || !isLimitOrderTriggerable(order.side, market.px, order.limitPrice)) {
        nextOrders.push(order);
        return;
      }
      const pool = getPoolRecord(market);
      const quote = buildTradeQuote({
        market,
        pool,
        side: order.side,
        marginSol: order.marginSol,
        leverage: order.leverage,
        mode: 'open',
      });
      if (quote.error || quote.utilizationAfterPct > quote.maxUtilizationPct + 1e-9) {
        nextOrders.push(order);
        return;
      }
      applyMarginModeToQuote({ account, quote, marginMode: order.marginMode, side: order.side, marginSol: order.marginSol });
      const opened = applyOpenPositionToAccount({
        account,
        observedMarket: market,
        pool,
        side: order.side,
        marginMode: order.marginMode,
        marginSol: order.marginSol,
        leverage: order.leverage,
        limitPrice: order.limitPrice,
        tpSl: null,
        auditSig: order.auditSig,
        quote,
      });
      if (!opened.ok) {
        nextOrders.push(order);
        return;
      }
      changed = true;
    });
    account.openOrders = nextOrders;
    persistRecord(account);
  });
  return changed;
}

function executePositionClose(account, index, closePct, auditSig = 'AUTO-TP/SL', reasonLabel = 'TP/SL') {
  if (!account || index < 0 || index >= account.positions.length) return false;
  const position = account.positions[index];
  const pct = Math.min(100, Math.max(0, clampNumber(closePct, 100)));
  if (!pct || pct > 100) return false;

  const closeRatio = pct / 100;
  const positionQty = Math.max(0, clampNumber(position.qty, 0));
  const positionNotional = Math.max(0, clampNumber(position.notional, 0));
  const positionMarginSol = Math.max(0, clampNumber(position.margin, 0));
  const positionMarginUsd = Math.max(0, clampNumber(position.marginUsd, 0));
  const closeQty = positionQty * closeRatio;
  const closeNotionalUsd = positionNotional * closeRatio;
  const releasedMarginSol = positionMarginSol * closeRatio;
  const releasedMarginUsd = positionMarginUsd * closeRatio;
  if (closeQty <= 0 || closeNotionalUsd <= 0) return false;

  const market = getMarketRecord({ sym: position.sym, name: position.name, addr: position.addr });
  const pool = getPoolRecord(market);
  const quote = buildTradeQuote({
    market,
    pool,
    side: position.side,
    marginSol: releasedMarginSol,
    leverage: Math.max(1, clampNumber(position.lev, 1)),
    mode: 'close',
    quantity: closeQty,
    positionNotionalUsd: closeNotionalUsd,
  });
  if (quote.error) return false;

  const markPrice = quote.executionPrice;
  const solUsd = quote.solUsd;
  const pnlUsd = position.side === 'long'
    ? (markPrice - position.entry) * closeQty
    : (position.entry - markPrice) * closeQty;
  const pnlSol = pnlUsd / solUsd;
  const payoutSol = Math.max(0, releasedMarginSol + pnlSol - quote.feeSol);
  account.balanceSol = Math.max(0, account.balanceSol + payoutSol);
  account.realizedPnlUsd += (pnlUsd - quote.feeUsd);
  account.realizedBasisUsd += releasedMarginUsd;
  applyPoolRelease(pool, position.side, closeNotionalUsd);
  pool.feeAccruedUsd = Math.max(0, clampNumber(pool.feeAccruedUsd, 0) + quote.feeUsd);
  pool.liquidityUsd = Math.max(MIN_POOL_LIQUIDITY_USD, clampNumber(pool.liquidityUsd, MIN_POOL_LIQUIDITY_USD) - pnlUsd + quote.feeUsd);

  if (pct >= 100 - 1e-9) {
    account.positions.splice(index, 1);
    appendHistory(account, reasonLabel, `${reasonLabel} ${position.sym} @ ${markPrice.toFixed(6)} · PnL ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} · fee $${quote.feeUsd.toFixed(2)} · ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`, auditSig);
  } else {
    const remainingQty = Math.max(0, positionQty - closeQty);
    const remainingNotional = Math.max(0, positionNotional - closeNotionalUsd);
    const remainingMarginSol = Math.max(0, positionMarginSol - releasedMarginSol);
    const remainingMarginUsd = Math.max(0, positionMarginUsd - releasedMarginUsd);
    const mmr = Math.max(0.005, clampNumber(position.maintenanceMarginRatio, 0.06));
    const remainingLiq = computeLiquidationPrice({
      entryPrice: Math.max(0, clampNumber(position.entry, 0)),
      quantity: remainingQty,
      marginUsd: remainingMarginUsd,
      side: position.side,
      maintenanceMarginRatio: mmr,
    });
    const remainingLev = remainingMarginUsd > 0
      ? remainingNotional / remainingMarginUsd
      : Math.max(1, clampNumber(position.lev, 1));

    const nextTpSl = sanitizeTpSlPayload(position?.tpSl || position);
    if (reasonLabel === 'SL') {
      nextTpSl.sl = null;
      nextTpSl.slRoi = null;
      nextTpSl.slQty = null;
      nextTpSl.slQtyPct = null;
    } else if (reasonLabel === 'TP') {
      nextTpSl.tp = null;
      nextTpSl.tpRoi = null;
      nextTpSl.tpQty = null;
      nextTpSl.tpQtyPct = null;
    }

    account.positions[index] = sanitizePosition({
      ...position,
      qty: remainingQty,
      notional: remainingNotional,
      margin: remainingMarginSol,
      marginUsd: remainingMarginUsd,
      effectiveMarginUsd: remainingMarginUsd,
      lev: remainingLev,
      liq: remainingLiq,
      maintenanceMarginRatio: mmr,
      tpSl: nextTpSl,
      tp: nextTpSl.tp,
      tpRoi: nextTpSl.tpRoi,
      sl: nextTpSl.sl,
      slRoi: nextTpSl.slRoi,
      tpQty: nextTpSl.tpQty,
      tpQtyPct: nextTpSl.tpQtyPct,
      slQty: nextTpSl.slQty,
      slQtyPct: nextTpSl.slQtyPct,
      status: 'open',
    }, account.walletAddress);
    appendHistory(account, reasonLabel, `${reasonLabel} reduced ${position.sym} by ${pct.toFixed(2)}% @ ${markPrice.toFixed(6)} · PnL ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} · fee $${quote.feeUsd.toFixed(2)} · ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`, auditSig);
  }

  recalcAccountRiskMetrics(account);
  persistRecord(account);
  return true;
}

function processTpSlTriggers() {
  let changed = false;
  Object.keys(db.wallets || {}).forEach((walletAddr) => {
    const account = getWalletRecord(walletAddr);
    if (!Array.isArray(account.positions) || !account.positions.length) return;

    for (let i = 0; i < account.positions.length; i += 1) {
      const position = sanitizePosition(account.positions[i], walletAddr);
      if (String(position?.status || 'open') !== 'open') continue;

      const tpSl = sanitizeTpSlPayload(position?.tpSl || position);
      if (!hasAnyTpSl(tpSl)) continue;

      const market = getMarketRecord({ sym: position.sym, name: position.name, addr: position.addr });
      const markPrice = Math.max(0, clampNumber(market?.px, 0));
      if (!markPrice) continue;

      const side = position.side === 'short' ? 'short' : 'long';
      const tpPrice = resolveTpSlPrice(position, tpSl, 'tp');
      const slPrice = resolveTpSlPrice(position, tpSl, 'sl');

        // Calculate actual ROI
        let roi = 0;
        if (side === 'short') {
          roi = ((position.entry - markPrice) / position.entry) * position.lev * 100;
        } else {
          roi = ((markPrice - position.entry) / position.entry) * position.lev * 100;
        }

        log('DEBUG', 'TP/SL', `Wallet: ${walletAddr}, Symbol: ${position.sym}, Side: ${side}, Entry: ${position.entry}, Mark: ${markPrice}, Lev: ${position.lev}, ROI: ${roi.toFixed(2)}, TP: ${tpSl.tpRoi}, SL: ${tpSl.slRoi}`);

        // SL: trigger if price or ROI
        if (slPrice > 0 && (isSlTriggered(side, markPrice, slPrice) || (tpSl.slRoi != null && roi <= -Math.abs(tpSl.slRoi)))) {
          log('INFO', 'TP/SL', `SL TRIGGERED for ${position.sym} (Wallet: ${walletAddr}) at ROI: ${roi.toFixed(2)} (SL ROI: ${tpSl.slRoi}), Mark: ${markPrice}, SL Price: ${slPrice}`);
          const slPct = resolveTpSlClosePct(position, tpSl, 'sl');
          if (slPct == null) continue; // qty/% not set — skip trigger
          const didClose = executePositionClose(account, i, slPct, 'AUTO-TP/SL', 'SL');
          if (didClose) {
            changed = true;
            if (slPct >= 100 - 1e-9) i -= 1;
          }
          continue;
        }

        // TP: trigger if price or ROI
        if (tpPrice > 0 && (isTpTriggered(side, markPrice, tpPrice) || (tpSl.tpRoi != null && roi >= Math.abs(tpSl.tpRoi)))) {
          log('INFO', 'TP/SL', `TP TRIGGERED for ${position.sym} (Wallet: ${walletAddr}) at ROI: ${roi.toFixed(2)} (TP ROI: ${tpSl.tpRoi}), Mark: ${markPrice}, TP Price: ${tpPrice}`);
          let tpPct = resolveTpSlClosePct(position, tpSl, 'tp');
          if (tpPct == null) {
            // Default to 100% close if no tpQty/tpQtyPct is set
            log('WARN', 'TP/SL', `No tpQty/tpQtyPct set for TP on ${position.sym} (Wallet: ${walletAddr}), defaulting to 100% close.`);
            tpPct = 100;
          }
          const didClose = executePositionClose(account, i, tpPct, 'AUTO-TP/SL', 'TP');
          if (didClose) {
            changed = true;
            if (tpPct >= 100 - 1e-9) i -= 1;
          }
        }
    }
  });

  return changed;
}

function recalcAccountRiskMetrics(record) {
  const solUsd = getSolUsdPrice();
  const freeBalanceUsd = Math.max(0, clampNumber(record?.balanceSol, 0) * solUsd);
  const openCrossPositions = (Array.isArray(record?.positions) ? record.positions : []).filter((position) => (
    String(position?.status || 'open') === 'open' && position?.marginMode === 'cross'
  ));
  const totalCrossNotional = openCrossPositions.reduce((sum, position) => sum + Math.max(0, clampNumber(position?.notional, 0)), 0);

  record.positions = (Array.isArray(record?.positions) ? record.positions : []).map((position) => {
    const baseMarginUsd = Math.max(0, clampNumber(position?.marginUsd, 0));
    const side = position?.side === 'short' ? 'short' : 'long';
    const mmr = Math.min(0.95, Math.max(0.001, clampNumber(position?.maintenanceMarginRatio, 0.06)));
    const qty = Math.max(0, clampNumber(position?.qty, 0));
    const entry = Math.max(0, clampNumber(position?.entry, 0));
    const isCross = position?.marginMode === 'cross';

    let sharedBufferUsd = 0;
    if (isCross && openCrossPositions.length > 0 && freeBalanceUsd > 0) {
      if (totalCrossNotional > 0) {
        sharedBufferUsd = freeBalanceUsd * (Math.max(0, clampNumber(position?.notional, 0)) / totalCrossNotional);
      } else {
        sharedBufferUsd = freeBalanceUsd / openCrossPositions.length;
      }
    }

    const effectiveMarginUsd = isCross ? Math.max(baseMarginUsd, baseMarginUsd + sharedBufferUsd) : baseMarginUsd;
    const liq = computeLiquidationPrice({
      entryPrice: entry,
      quantity: qty,
      marginUsd: effectiveMarginUsd,
      side,
      maintenanceMarginRatio: mmr,
    });

    return sanitizePosition({
      ...position,
      effectiveMarginUsd,
      liq,
    }, record.walletAddress);
  });
}

function normalizeWalletRecord(record, walletAddress) {
  const normalizedAddress = walletKey(walletAddress || record?.walletAddress);
  return {
    walletAddress: normalizedAddress,
    balanceSol: Math.max(0, clampNumber(record?.balanceSol, 0)),
    realizedPnlUsd: clampNumber(record?.realizedPnlUsd, 0),
    realizedBasisUsd: Math.max(0, clampNumber(record?.realizedBasisUsd, 0)),
    positions: Array.isArray(record?.positions)
      ? record.positions.map((position) => sanitizePosition(position, normalizedAddress)).filter((position) => position.walletOwner === normalizedAddress)
      : [],
    openOrders: Array.isArray(record?.openOrders)
      ? record.openOrders.map((order) => sanitizeOpenOrder(order, normalizedAddress)).filter((order) => order.walletOwner === normalizedAddress)
      : [],
    history: Array.isArray(record?.history)
      ? sortHistoryDesc(record.history.map((entry) => sanitizeHistoryEntry(entry, normalizedAddress)).filter((entry) => entry.walletOwner === normalizedAddress)).slice(0, 500)
      : [],
    balanceGrants: Array.isArray(record?.balanceGrants)
      ? record.balanceGrants.map((grant) => ({
          amountSol: Math.max(0, clampNumber(grant?.amountSol, 0)),
          grantedAt: String(grant?.grantedAt || nowIso()),
        }))
      : [],
    createdAt: String(record?.createdAt || nowIso()),
    updatedAt: String(record?.updatedAt || nowIso()),
  };
}

function getAccountState(walletAddress) {
  const record = normalizeWalletRecord(getWalletRecord(walletAddress), walletAddress);
  recalcAccountRiskMetrics(record);
  db.wallets[walletKey(walletAddress)] = record;
  return {
    walletAddress: record.walletAddress,
    balanceSol: record.balanceSol,
    realizedPnl: record.realizedPnlUsd,
    realizedBasis: record.realizedBasisUsd,
    positions: record.positions,
    openOrders: record.openOrders,
    history: record.history,
  };
}

function persistRecord(record) {
  record.updatedAt = nowIso();
  db.wallets[record.walletAddress] = normalizeWalletRecord(record, record.walletAddress);
  saveDb();
}

function appendHistory(record, type, msg, sig = '—') {
  record.history.unshift(sanitizeHistoryEntry({ type, msg, sig, chainStatus: sig && sig !== '—' ? 'submitted' : '—' }, record.walletAddress));
  record.history = sortHistoryDesc(record.history).slice(0, 500);
}

function currentGrantUsage(record) {
  const nowMs = Date.now();
  const cutoff = nowMs - ADD_BALANCE_WINDOW_MS;
  record.balanceGrants = record.balanceGrants.filter((grant) => new Date(grant.grantedAt).getTime() >= cutoff);
  let oldestGrantTs = Number.POSITIVE_INFINITY;
  const used = record.balanceGrants.reduce((sum, grant) => {
    const grantTs = new Date(grant.grantedAt).getTime();
    if (Number.isFinite(grantTs) && grantTs < oldestGrantTs) oldestGrantTs = grantTs;
    return sum + clampNumber(grant.amountSol, 0);
  }, 0);
  const remaining = Math.max(0, ADD_BALANCE_MAX_SOL - used);
  const retryInMs = Number.isFinite(oldestGrantTs)
    ? Math.max(0, (oldestGrantTs + ADD_BALANCE_WINDOW_MS) - nowMs)
    : 0;
  const retryAt = new Date(nowMs + retryInMs).toISOString();
  return { used, remaining, retryInMs, retryAt };
}

function requireAuth(req, res, next) {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const session = sessions.get(token);
  if (!token || !session) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    res.status(401).json({ error: 'Session expired' });
    return;
  }
  req.walletAddress = session.walletAddress;
  req.sessionToken = token;
  next();
}

function isValidEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value || value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getBetaWaitlist() {
  if (!Array.isArray(db.meta.betaWaitlist)) db.meta.betaWaitlist = [];
  return db.meta.betaWaitlist;
}

function getClientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

function buildAdminChallengeMessage(walletAddress, nonce, issuedAt) {
  return [
    'MemePerp Beta Admin Access',
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

function requireAdmin(req, res, next) {
  if (!ADMIN_WALLET) {
    res.status(503).json({ error: 'Admin wallet is not configured on server' });
    return;
  }
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const session = adminSessions.get(token);
  if (!token || !session) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    res.status(401).json({ error: 'Admin session expired' });
    return;
  }
  if (session.walletAddress !== ADMIN_WALLET) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  req.adminWalletAddress = session.walletAddress;
  next();
}

function isLikelySolanaAddress(value) {
  const text = String(value || '').trim();
  return text.length >= 32 && text.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(text);
}

async function providerFetchJson(url, options = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable in this Node runtime');
  }
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
}

app.get('/api/testnet/health', (_req, res) => {
  res.json({ ok: true, port: PORT, time: nowIso() });
});

app.post('/api/mainnet/beta/join', betaJoinRateLimit, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  const list = getBetaWaitlist();
  const found = list.find((entry) => String(entry?.email || '').toLowerCase() === email);
  if (found) {
    res.status(409).json({ error: 'Email already submitted', code: 'EMAIL_ALREADY_SUBMITTED' });
    return;
  }

  list.unshift({ email, createdAt: nowIso(), sourceIp: getClientIp(req) });
  db.meta.betaWaitlist = list.slice(0, 10000);
  saveDb();
  res.json({ ok: true });
});

app.post('/api/mainnet/admin/challenge', adminRateLimit, (req, res) => {
  if (!ADMIN_WALLET) {
    res.status(503).json({ error: 'Admin wallet is not configured on server' });
    return;
  }
  const walletAddress = walletKey(String(req.body?.walletAddress || '').trim());
  if (!isValidWalletAddress(walletAddress)) {
    res.status(400).json({ error: 'Invalid wallet address' });
    return;
  }
  if (walletAddress !== ADMIN_WALLET) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = nowIso();
  const message = buildAdminChallengeMessage(walletAddress, nonce, issuedAt);
  adminChallenges.set(walletAddress, { nonce, issuedAt, message, expiresAt: Date.now() + ADMIN_CHALLENGE_TTL_MS });
  res.json({ ok: true, walletAddress, nonce, issuedAt, message });
});

app.post('/api/mainnet/admin/verify', adminRateLimit, (req, res) => {
  if (!ADMIN_WALLET) {
    res.status(503).json({ error: 'Admin wallet is not configured on server' });
    return;
  }
  const walletAddress = walletKey(String(req.body?.walletAddress || '').trim());
  const message = String(req.body?.message || '');
  const signature = String(req.body?.signature || '');
  if (!isValidWalletAddress(walletAddress)) {
    res.status(400).json({ error: 'Invalid wallet address' });
    return;
  }
  if (walletAddress !== ADMIN_WALLET) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const pending = adminChallenges.get(walletAddress);
  if (!pending || pending.expiresAt <= Date.now()) {
    adminChallenges.delete(walletAddress);
    res.status(400).json({ error: 'Challenge expired or missing' });
    return;
  }
  if (message !== pending.message) {
    res.status(400).json({ error: 'Message mismatch' });
    return;
  }
  if (!verifyWalletSignature(walletAddress, message, signature)) {
    res.status(401).json({ error: 'Signature verification failed' });
    return;
  }

  adminChallenges.delete(walletAddress);
  const adminToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  adminSessions.set(adminToken, { walletAddress, expiresAt });
  res.json({ ok: true, adminToken, expiresAt });
});

app.get('/api/mainnet/beta/list', adminRateLimit, requireAdmin, (_req, res) => {
  const list = getBetaWaitlist();
  res.json({
    ok: true,
    count: list.length,
    items: list.map((entry) => ({
      email: String(entry?.email || '').trim().toLowerCase(),
      createdAt: String(entry?.createdAt || nowIso()),
    })),
  });
});

app.get('/api/mainnet/provider/status', providerRateLimit, (_req, res) => {
  res.json({
    ok: true,
    birdeyeConfigured: !!PROVIDER_BIRDEYE_KEY,
    rpcConfigured: !!PROVIDER_RPC_URL,
  });
});

app.get('/api/mainnet/provider/price', providerRateLimit, async (req, res) => {
  const address = String(req.query?.address || '').trim();
  if (!isLikelySolanaAddress(address)) {
    res.status(400).json({ error: 'Invalid token address' });
    return;
  }

  const targetUrl = `https://public-api.birdeye.so/defi/price?address=${encodeURIComponent(address)}`;
  const headers = PROVIDER_BIRDEYE_KEY ? { 'X-API-KEY': PROVIDER_BIRDEYE_KEY } : {};
  try {
    const upstream = await providerFetchJson(targetUrl, { method: 'GET', headers });
    if (!upstream.ok || !upstream.json) {
      res.status(502).json({ error: 'Upstream price provider failed' });
      return;
    }
    const price = Number(upstream.json?.data?.value ?? upstream.json?.value ?? 0);
    res.json({ ok: true, address, price: Number.isFinite(price) ? price : 0 });
  } catch (error) {
    res.status(502).json({ error: 'Provider request failed' });
  }
});

app.get('/api/mainnet/provider/ohlcv', providerRateLimit, async (req, res) => {
  const address = String(req.query?.address || '').trim();
  const resolution = String(req.query?.type || req.query?.resolution || '1').trim();
  const limitRaw = Math.max(1, Math.min(500, clampNumber(req.query?.limit, 200)));
  const limit = Math.floor(limitRaw);
  if (!isLikelySolanaAddress(address)) {
    res.status(400).json({ error: 'Invalid token address' });
    return;
  }
  if (!/^([1-9][0-9]*|1H|4H|1D)$/.test(resolution)) {
    res.status(400).json({ error: 'Invalid resolution' });
    return;
  }

  const targetUrl = `https://public-api.birdeye.so/defi/ohlcv?address=${encodeURIComponent(address)}&type=${encodeURIComponent(resolution)}&limit=${encodeURIComponent(limit)}`;
  const headers = PROVIDER_BIRDEYE_KEY ? { 'X-API-KEY': PROVIDER_BIRDEYE_KEY } : {};
  try {
    const upstream = await providerFetchJson(targetUrl, { method: 'GET', headers });
    if (!upstream.ok || !upstream.json) {
      res.status(502).json({ error: 'Upstream OHLCV provider failed' });
      return;
    }
    const items = Array.isArray(upstream.json?.data?.items) ? upstream.json.data.items : [];
    res.json({ ok: true, address, items });
  } catch (_error) {
    res.status(502).json({ error: 'Provider request failed' });
  }
});

app.get('/api/mainnet/provider/search', providerRateLimit, async (req, res) => {
  const keyword = String(req.query?.keyword || '').trim();
  if (!keyword || keyword.length < 2) {
    res.status(400).json({ error: 'Search keyword too short' });
    return;
  }

  const targetUrl = `https://public-api.birdeye.so/defi/v3/search?keyword=${encodeURIComponent(keyword)}&chain=solana`;
  const headers = PROVIDER_BIRDEYE_KEY ? { 'X-API-KEY': PROVIDER_BIRDEYE_KEY } : {};
  try {
    const upstream = await providerFetchJson(targetUrl, { method: 'GET', headers });
    if (!upstream.ok || !upstream.json) {
      res.status(502).json({ error: 'Upstream search provider failed' });
      return;
    }
    const items = upstream.json?.data?.items || upstream.json?.data?.tokens || upstream.json?.data || [];
    res.json({ ok: true, items: Array.isArray(items) ? items : [] });
  } catch (_error) {
    res.status(502).json({ error: 'Provider request failed' });
  }
});

app.get('/api/mainnet/provider/token-meta', providerRateLimit, async (req, res) => {
  const address = String(req.query?.address || '').trim();
  if (!isLikelySolanaAddress(address)) {
    res.status(400).json({ error: 'Invalid token address' });
    return;
  }

  const targetUrl = `https://public-api.birdeye.so/defi/token_meta?address=${encodeURIComponent(address)}`;
  const headers = PROVIDER_BIRDEYE_KEY ? { 'X-API-KEY': PROVIDER_BIRDEYE_KEY } : {};
  try {
    const upstream = await providerFetchJson(targetUrl, { method: 'GET', headers });
    if (!upstream.ok || !upstream.json) {
      res.status(502).json({ error: 'Upstream token metadata provider failed' });
      return;
    }
    res.json({ ok: true, data: upstream.json?.data || null });
  } catch (_error) {
    res.status(502).json({ error: 'Provider request failed' });
  }
});

app.post('/api/mainnet/provider/rpc', providerRateLimit, async (req, res) => {
  if (!PROVIDER_RPC_URL) {
    res.status(503).json({ error: 'RPC provider is not configured' });
    return;
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : null;
  const method = String(payload?.method || '').trim();
  if (!payload || !method || typeof payload.id === 'undefined') {
    res.status(400).json({ error: 'Invalid JSON-RPC payload' });
    return;
  }

  try {
    const upstream = await providerFetchJson(PROVIDER_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!upstream.json) {
      res.status(502).json({ error: 'Invalid RPC provider response' });
      return;
    }
    res.status(upstream.status || 200).json(upstream.json);
  } catch (_error) {
    res.status(502).json({ error: 'RPC provider request failed' });
  }
});

app.post('/api/testnet/auth/nonce', authRateLimit, (req, res) => {
  const walletAddress = String(req.body?.walletAddress || '').trim();
  if (!isValidWalletAddress(walletAddress)) {
    res.status(400).json({ error: 'Invalid wallet address' });
    return;
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = nowIso();
  const message = buildNonceMessage(walletAddress, nonce, issuedAt);
  nonces.set(walletKey(walletAddress), { nonce, issuedAt, message, expiresAt: Date.now() + NONCE_TTL_MS });
  res.json({ walletAddress: walletKey(walletAddress), nonce, issuedAt, message });
});

app.post('/api/testnet/auth/verify', authRateLimit, (req, res) => {
  const walletAddress = String(req.body?.walletAddress || '').trim();
  const message = String(req.body?.message || '');
  const signature = String(req.body?.signature || '');
  const key = walletKey(walletAddress);
  const pending = nonces.get(key);
  if (!pending || pending.expiresAt <= Date.now()) {
    nonces.delete(key);
    res.status(400).json({ error: 'Nonce expired or missing' });
    return;
  }
  if (message !== pending.message) {
    res.status(400).json({ error: 'Message mismatch' });
    return;
  }
  if (!verifyWalletSignature(walletAddress, message, signature)) {
    res.status(401).json({ error: 'Signature verification failed' });
    return;
  }
  nonces.delete(key);
  const sessionToken = crypto.randomBytes(24).toString('hex');
  sessions.set(sessionToken, { walletAddress: key, expiresAt: Date.now() + SESSION_TTL_MS });
  const account = getWalletRecord(key);
  persistRecord(account);
  res.json({ sessionToken, accountState: getAccountState(key) });
});

app.post('/api/testnet/auth/logout', requireAuth, (req, res) => {
  sessions.delete(req.sessionToken);
  res.json({ ok: true });
});

// Save TP/SL settings for a position
app.post('/api/testnet/position/tpsl', requireAuth, tradingRateLimit, (req, res) => {
  const { positionId, tp, tpRoi, sl, slRoi, tpQty, tpQtyPct, slQty, slQtyPct } = req.body || {};
  const auditSig = req.body?.auditSig ? String(req.body.auditSig) : '—';
  const wantedId = String(positionId || '').trim();
  if (!wantedId) {
    res.status(400).json({ error: 'Missing positionId' });
    return;
  }
  if (!auditSig || auditSig === '—') {
    res.status(400).json({ error: 'Wallet signature is required to update TP/SL', code: 'SIGNATURE_REQUIRED' });
    return;
  }

  const account = getWalletRecord(req.walletAddress);
  const posIdx = account.positions.findIndex((position) => String(position?.id || '') === wantedId);
  if (posIdx === -1) {
    res.status(404).json({ error: 'Position not found' });
    return;
  }

  const nextTpSl = sanitizeTpSlPayload({ tp, tpRoi, sl, slRoi, tpQty, tpQtyPct, slQty, slQtyPct });
  const validation = validateTpSlForExecution({
    side: account.positions[posIdx]?.side,
    entryPrice: account.positions[posIdx]?.entry,
    leverage: account.positions[posIdx]?.lev,
    quantity: account.positions[posIdx]?.qty,
    tpSl: nextTpSl,
  });
  if (!validation.ok) {
    res.status(400).json({ error: validation.error, code: validation.code });
    return;
  }
  account.positions[posIdx].tpSl = validation.tpSl;
  const sym = String(account.positions[posIdx]?.sym || 'TOKEN');
  appendHistory(account, 'TP/SL', `TP/SL updated for ${sym}`, auditSig);
  persistRecord(account);
  res.json({ ok: true, position: sanitizePosition(account.positions[posIdx], req.walletAddress), accountState: getAccountState(req.walletAddress) });
});

app.post('/api/testnet/account/migrate', requireAuth, (req, res) => {
  const snapshot = req.body?.snapshot || {};
  const account = getWalletRecord(req.walletAddress);
  const isEmpty = account.balanceSol === 0 && account.realizedPnlUsd === 0 && account.realizedBasisUsd === 0 && account.positions.length === 0 && account.history.length === 0;
  if (!isEmpty) {
    res.json({ ok: true, migrated: false, accountState: getAccountState(req.walletAddress) });
    return;
  }

  account.balanceSol = Math.max(0, clampNumber(snapshot.balanceSol, 0));
  account.realizedPnlUsd = clampNumber(snapshot.realizedPnl, 0);
  account.realizedBasisUsd = Math.max(0, clampNumber(snapshot.realizedBasis, 0));
  account.positions = Array.isArray(snapshot.positions)
    ? snapshot.positions.map((position) => sanitizePosition(position, req.walletAddress)).filter((position) => position.walletOwner === req.walletAddress)
    : [];
  account.openOrders = Array.isArray(snapshot.openOrders)
    ? snapshot.openOrders.map((order) => sanitizeOpenOrder(order, req.walletAddress)).filter((order) => order.walletOwner === req.walletAddress)
    : [];
  account.history = Array.isArray(snapshot.history)
    ? sortHistoryDesc(snapshot.history.map((entry) => sanitizeHistoryEntry(entry, req.walletAddress)).filter((entry) => entry.walletOwner === req.walletAddress)).slice(0, 500)
    : [];
  persistRecord(account);
  res.json({ ok: true, migrated: true, accountState: getAccountState(req.walletAddress) });
});

app.get('/api/testnet/account/state', requireAuth, (req, res) => {
  res.json({ accountState: getAccountState(req.walletAddress) });
});

app.get('/api/testnet/account/history', requireAuth, (req, res) => {
  res.json({ history: getAccountState(req.walletAddress).history });
});

app.post('/api/testnet/account/event', requireAuth, (req, res) => {
  const type = String(req.body?.type || '').trim().toUpperCase();
  const msg = String(req.body?.msg || '').trim();
  const auditSig = req.body?.auditSig ? String(req.body.auditSig) : '—';
  if (!type) {
    res.status(400).json({ error: 'Event type is required' });
    return;
  }
  if (!msg) {
    res.status(400).json({ error: 'Event message is required' });
    return;
  }
  const account = getWalletRecord(req.walletAddress);
  appendHistory(account, type, msg, auditSig);
  persistRecord(account);
  res.json({ ok: true });
});

app.post('/api/testnet/account/reset', requireAuth, (req, res) => {
  const account = getWalletRecord(req.walletAddress);
  account.balanceSol = 0;
  account.realizedPnlUsd = 0;
  account.realizedBasisUsd = 0;
  account.positions = [];
  account.openOrders = [];
  account.history = [];
  account.balanceGrants = [];
  persistRecord(account);
  res.json({ ok: true, accountState: getAccountState(req.walletAddress) });
});

// SECURITY: This endpoint previously allowed clients to push arbitrary prices and is now disabled for security reasons.
app.post('/api/testnet/markets/sync', requireAuth, (req, res) => {
  res.status(410).json({
    error: 'ENDPOINT_DISABLED',
    message: 'Price sync is now handled server-side. This endpoint is deprecated.'
  });
});

app.post('/api/testnet/trade/quote', requireAuth, (req, res) => {
  const account = getWalletRecord(req.walletAddress);
  const marketInput = req.body?.market || {};
  const market = getMarketRecord(marketInput);
  const pool = getPoolRecord(marketInput);
  const marginSol = Math.max(0, clampNumber(req.body?.marginSol, 0));
  const leverage = Math.max(1, clampNumber(req.body?.leverage, 1));
  const side = req.body?.side === 'short' ? 'short' : 'long';
  const marginMode = req.body?.marginMode === 'cross' ? 'cross' : 'isolated';
  if (!market?.sym || !market?.px) {
    res.status(400).json({ error: 'Market price unavailable. Sync market data first.' });
    return;
  }
  if (!marginSol) {
    res.status(400).json({ error: 'Invalid margin' });
    return;
  }
  const quote = buildTradeQuote({ market, pool, side, marginSol, leverage, mode: 'open' });
  if (quote.error) {
    res.status(400).json({ error: quote.error });
    return;
  }
  if (quote.utilizationAfterPct > quote.maxUtilizationPct + 1e-9) {
    res.status(400).json({
      error: `Liquidity limit exceeded. Pool utilization would reach ${quote.utilizationAfterPct.toFixed(2)}% (max ${quote.maxUtilizationPct.toFixed(2)}%).`,
      code: 'POOL_UTILIZATION_LIMIT',
      quote,
    });
    return;
  }
  applyMarginModeToQuote({ account, quote, marginMode, side, marginSol });
  res.json({ ok: true, quote, pool });
});

app.post('/api/testnet/balance/add', requireAuth, (req, res) => {
  const amountSol = Math.max(0, clampNumber(req.body?.amountSol, 0));
  if (!amountSol) {
    res.status(400).json({ error: 'Invalid amount' });
    return;
  }
  const account = getWalletRecord(req.walletAddress);
  const usage = currentGrantUsage(account);
  if (amountSol > usage.remaining + 1e-9) {
    res.status(400).json({
      error: `Add balance limit reached. Remaining: ${usage.remaining.toFixed(4)} SOL.`,
      code: 'ADD_BALANCE_LIMIT_REACHED',
      remaining: Number(usage.remaining.toFixed(6)),
      retryInMs: usage.retryInMs,
      retryAt: usage.retryAt,
      windowMs: ADD_BALANCE_WINDOW_MS,
      windowMaxSol: ADD_BALANCE_MAX_SOL,
    });
    return;
  }
  account.balanceSol += amountSol;
  account.balanceGrants.push({ amountSol, grantedAt: nowIso() });
  appendHistory(account, 'BALANCE', `Added in-app balance +${amountSol.toFixed(2)} SOL`, '—');
  persistRecord(account);
  res.json({ ok: true, accountState: getAccountState(req.walletAddress) });
});

app.post('/api/testnet/positions/open', requireAuth, tradingRateLimit, (req, res) => {
      log('INFO', 'TRADE', 'Position open attempt', { wallet: req.walletAddress, market: req.body?.market, marginSol: req.body?.marginSol, leverage: req.body?.leverage });
    // --- Max positions per user check ---
    if ((account.positions?.length || 0) >= MAX_POSITIONS_PER_USER) {
      log('WARN', 'TRADE', 'Max positions per user reached', { wallet: req.walletAddress, currentPositions: account.positions.length });
      res.status(409).json({
        error: 'MAX_POSITIONS_REACHED',
        message: 'You can only have 10 open positions at once',
        currentPositions: account.positions.length
      });
      return;
    }
    // --- Platform OI check ---
    let totalOI = 0;
    for (const acc of Object.values(db.wallets || {})) {
      for (const pos of acc.positions || []) {
        totalOI += Number(pos.notional) || 0;
      }
    }
    if (totalOI > MAX_TOTAL_OI) {
      log('CRITICAL', 'SYSTEM', 'Platform OI limit reached', { totalOI });
      res.status(409).json({
        error: 'PLATFORM_CAPACITY_REACHED',
        message: 'Platform is at maximum capacity. Please try again later.',
        totalOI
      });
      return;
    }
  const account = getWalletRecord(req.walletAddress);
  const market = req.body?.market || {};
  const marginSol = Math.max(0, clampNumber(req.body?.marginSol, 0));
  const leverage = Math.max(1, clampNumber(req.body?.leverage, 1));
  const side = req.body?.side === 'short' ? 'short' : 'long';
  const marginMode = req.body?.marginMode === 'cross' ? 'cross' : 'isolated';
  const orderType = req.body?.orderType === 'limit' ? 'limit' : 'market';
  const auditSig = req.body?.auditSig ? String(req.body.auditSig) : '—';
  const limitPrice = req.body?.limitPrice == null ? null : clampNumber(req.body.limitPrice, 0);
  const tpSl = sanitizeTpSlPayload(req.body?.tpSl || {});
  const observedMarket = getMarketRecord(market);
  const pool = getPoolRecord(observedMarket);
  // --- Price staleness validation ---
  if (observedMarket?.updatedAt) {
    const updatedAtMs = new Date(observedMarket.updatedAt).getTime();
    const nowMs = Date.now();
    const priceAgeMs = nowMs - updatedAtMs;
    if (priceAgeMs > 30000) {
      const priceAgeSec = Math.floor(priceAgeMs / 1000);
      console.warn(`[${new Date().toISOString()}] [STALE_PRICE] Reject open position: ${observedMarket.sym} price age ${priceAgeSec}s`);
      res.status(409).json({ error: 'STALE_PRICE', message: 'Price data is too old. Cannot execute trade.', priceAge: priceAgeSec });
      return;
    }
  }
  // --- End staleness validation ---
  if (!observedMarket?.sym || !marginSol) {
    log('ERROR', 'TRADE', 'Missing position fields', { wallet: req.walletAddress, market: observedMarket });
    res.status(400).json({ error: 'Missing position fields' });
    return;
  }
  if (!auditSig || auditSig === '—') {
    log('ERROR', 'TRADE', 'Signature required to open position', { wallet: req.walletAddress });
    res.status(400).json({ error: 'Wallet signature is required to open a position', code: 'SIGNATURE_REQUIRED' });
    return;
  }
  const quote = buildTradeQuote({ market: observedMarket, pool, side, marginSol, leverage, mode: 'open' });
  if (quote.error) {
    log('ERROR', 'TRADE', 'Trade quote error', { wallet: req.walletAddress, error: quote.error });
    res.status(400).json({ error: quote.error });
    return;
  }
  applyMarginModeToQuote({ account, quote, marginMode, side, marginSol });
  const tpSlValidation = validateTpSlForExecution({
    side,
    entryPrice: quote.executionPrice,
    leverage,
    quantity: quote.quantity,
    tpSl,
  });
  if (!tpSlValidation.ok) {
    log('ERROR', 'TRADE', 'TP/SL validation failed', { wallet: req.walletAddress, error: tpSlValidation.error });
    res.status(400).json({ error: tpSlValidation.error, code: tpSlValidation.code });
    return;
  }
  if (quote.utilizationAfterPct > quote.maxUtilizationPct + 1e-9) {
    log('WARN', 'TRADE', 'Pool utilization limit exceeded', { wallet: req.walletAddress, utilization: quote.utilizationAfterPct, max: quote.maxUtilizationPct });
    res.status(400).json({
      error: `Liquidity limit exceeded. Pool utilization would reach ${quote.utilizationAfterPct.toFixed(2)}% (max ${quote.maxUtilizationPct.toFixed(2)}%).`,
      code: 'POOL_UTILIZATION_LIMIT',
      quote,
    });
    return;
  }
  if (orderType === 'limit') {
    if (!(limitPrice > 0)) {
      log('ERROR', 'TRADE', 'Limit price required for limit order', { wallet: req.walletAddress });
      res.status(400).json({ error: 'Limit price required for limit orders' });
      return;
    }
    const isMarketableNow = isLimitOrderTriggerable(side, observedMarket.px, limitPrice);
    if (!isMarketableNow) {
      log('INFO', 'TRADE', 'Limit order queued', { wallet: req.walletAddress, market: observedMarket.sym, side, limitPrice });
      account.openOrders.push(sanitizeOpenOrder({
        id: makeId(),
        walletOwner: req.walletAddress,
        sym: observedMarket.sym,
        name: observedMarket.name || observedMarket.sym,
        addr: observedMarket.addr || '',
        side,
        marginMode,
        marginSol,
        leverage,
        limitPrice,
        orderType: 'limit',
        status: 'open',
        auditSig,
        createdAt: nowIso(),
      }, req.walletAddress));
      appendHistory(account, 'ORDER', `Limit ${side.toUpperCase()} ${observedMarket.sym} queued @ ${limitPrice.toFixed(6)}`, auditSig);
      persistRecord(account);
      res.json({ ok: true, queued: true, quote, orderType: 'limit', accountState: getAccountState(req.walletAddress) });
      return;
    }
  }

  const opened = applyOpenPositionToAccount({
    account,
    observedMarket,
    pool,
    side,
    marginMode,
    marginSol,
    leverage,
    limitPrice,
    tpSl: tpSlValidation.tpSl,
    auditSig,
    quote,
  });
  if (!opened.ok) {
    updateLedgerStats(db);
    log('ERROR', 'TRADE', 'Failed to open position', { wallet: req.walletAddress, error: opened.error });
    res.status(opened.status || 400).json({ error: opened.error || 'Unable to open position', code: opened.code });
    return;
  }
  updateLedgerStats(db);
  log('INFO', 'TRADE', 'Position opened', { wallet: req.walletAddress, market: observedMarket.sym, side, marginSol, leverage, notional: quote.notionalUsd });
  res.json({ ok: true, quote, orderType, positionAction: opened.positionAction, accountState: getAccountState(req.walletAddress) });
});

app.post('/api/testnet/orders/:id/cancel', requireAuth, (req, res) => {
  const account = getWalletRecord(req.walletAddress);
  const orderId = String(req.params.id || '');
  const index = (Array.isArray(account.openOrders) ? account.openOrders : []).findIndex((order) => String(order?.id || '') === orderId && walletKey(order?.walletOwner) === req.walletAddress);
  if (index < 0) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  const order = account.openOrders[index];
  account.openOrders.splice(index, 1);
  appendHistory(account, 'ORDER', `Cancelled limit ${String(order?.side || 'long').toUpperCase()} ${String(order?.sym || 'TOKEN')} @ ${Number(order?.limitPrice || 0).toFixed(6)}`, '—');
  persistRecord(account);
  res.json({ ok: true, accountState: getAccountState(req.walletAddress) });
});

app.post('/api/testnet/positions/:id/close', requireAuth, tradingRateLimit, (req, res) => {
  const account = getWalletRecord(req.walletAddress);
  const positionId = String(req.params.id || '');
  const index = account.positions.findIndex((position) => String(position.id) === positionId && walletKey(position.walletOwner) === req.walletAddress);
  if (index < 0) {
    updateLedgerStats(db);
    res.status(404).json({ error: 'Position not found' });
    return;
  }
  const position = account.positions[index];
  const auditSig = req.body?.auditSig ? String(req.body.auditSig) : '—';
  if (!auditSig || auditSig === '—') {
    updateLedgerStats(db);
    res.status(400).json({ error: 'Wallet signature is required to close a position', code: 'SIGNATURE_REQUIRED' });
    return;
  }
  const closePct = Math.min(100, Math.max(0, clampNumber(req.body?.closePct, 100)));
  if (!closePct || closePct > 100) {
    updateLedgerStats(db);
    res.status(400).json({ error: 'Invalid close percentage' });
    return;
  }
  const closeRatio = closePct / 100;
  const positionQty = Math.max(0, clampNumber(position.qty, 0));
  const positionNotional = Math.max(0, clampNumber(position.notional, 0));
  const positionMarginSol = Math.max(0, clampNumber(position.margin, 0));
  const positionMarginUsd = Math.max(0, clampNumber(position.marginUsd, 0));
  const closeQty = positionQty * closeRatio;
  const closeNotionalUsd = positionNotional * closeRatio;
  const releasedMarginSol = positionMarginSol * closeRatio;
  const releasedMarginUsd = positionMarginUsd * closeRatio;
  if (closeQty <= 0 || closeNotionalUsd <= 0) {
    updateLedgerStats(db);
    res.status(400).json({ error: 'Close size too small' });
    return;
  }
  const market = getMarketRecord({ sym: position.sym, name: position.name, addr: position.addr });
  const pool = getPoolRecord(market);
  // --- Price staleness validation ---
  if (market?.updatedAt) {
    const updatedAtMs = new Date(market.updatedAt).getTime();
    const nowMs = Date.now();
    const priceAgeMs = nowMs - updatedAtMs;
    if (priceAgeMs > 30000) {
      const priceAgeSec = Math.floor(priceAgeMs / 1000);
      console.warn(`[${new Date().toISOString()}] [STALE_PRICE] Reject close position: ${market.sym} price age ${priceAgeSec}s`);
      res.status(409).json({ error: 'STALE_PRICE', message: 'Price data is too old. Cannot execute trade.', priceAge: priceAgeSec });
      return;
    }
  }
  // --- End staleness validation ---
  const quote = buildTradeQuote({
    market,
    pool,
    side: position.side,
    marginSol: releasedMarginSol,
    leverage: Math.max(1, clampNumber(position.lev, 1)),
    mode: 'close',
    quantity: closeQty,
    positionNotionalUsd: closeNotionalUsd,
  });
  if (quote.error) {
    res.status(400).json({ error: quote.error });
    return;
  }
  const markPrice = quote.executionPrice;
  const solUsd = quote.solUsd;
  const pnlUsd = position.side === 'long'
    ? (markPrice - position.entry) * closeQty
    : (position.entry - markPrice) * closeQty;
  const pnlSol = pnlUsd / solUsd;
  const payoutSol = Math.max(0, releasedMarginSol + pnlSol - quote.feeSol);
  account.balanceSol = Math.max(0, account.balanceSol + payoutSol);
  account.realizedPnlUsd += (pnlUsd - quote.feeUsd);
  account.realizedBasisUsd += releasedMarginUsd;
  applyPoolRelease(pool, position.side, closeNotionalUsd);
  pool.feeAccruedUsd = Math.max(0, clampNumber(pool.feeAccruedUsd, 0) + quote.feeUsd);
  pool.liquidityUsd = Math.max(MIN_POOL_LIQUIDITY_USD, clampNumber(pool.liquidityUsd, MIN_POOL_LIQUIDITY_USD) - pnlUsd + quote.feeUsd);
  if (closePct >= 100 - 1e-9) {
    account.positions.splice(index, 1);
    appendHistory(account, 'CLOSE', `Closed ${position.sym} @ ${markPrice.toFixed(6)} · PnL ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} · fee $${quote.feeUsd.toFixed(2)} · ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`, auditSig);
  } else {
    const remainingQty = Math.max(0, positionQty - closeQty);
    const remainingNotional = Math.max(0, positionNotional - closeNotionalUsd);
    const remainingMarginSol = Math.max(0, positionMarginSol - releasedMarginSol);
    const remainingMarginUsd = Math.max(0, positionMarginUsd - releasedMarginUsd);
    const mmr = Math.max(0.005, clampNumber(position.maintenanceMarginRatio, 0.06));
    const remainingLiq = computeLiquidationPrice({
      entryPrice: Math.max(0, clampNumber(position.entry, 0)),
      quantity: remainingQty,
      marginUsd: remainingMarginUsd,
      side: position.side,
      maintenanceMarginRatio: mmr,
    });
    const remainingLev = remainingMarginUsd > 0
      ? remainingNotional / remainingMarginUsd
      : Math.max(1, clampNumber(position.lev, 1));

    account.positions[index] = sanitizePosition({
      ...position,
      qty: remainingQty,
      notional: remainingNotional,
      margin: remainingMarginSol,
      marginUsd: remainingMarginUsd,
      effectiveMarginUsd: remainingMarginUsd,
      lev: remainingLev,
      liq: remainingLiq,
      maintenanceMarginRatio: mmr,
      status: 'open',
    }, req.walletAddress);
    appendHistory(account, 'CLOSE', `Reduced ${position.sym} by ${closePct.toFixed(2)}% @ ${markPrice.toFixed(6)} · PnL ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} · fee $${quote.feeUsd.toFixed(2)} · ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`, auditSig);
  }
  recalcAccountRiskMetrics(account);
  persistRecord(account);
  updateLedgerStats(db);
  res.json({ ok: true, quote, closePct, accountState: getAccountState(req.walletAddress) });
});

app.post('/api/testnet/positions/:id/liquidate', requireAuth, (req, res) => {
  const account = getWalletRecord(req.walletAddress);
  const positionId = String(req.params.id || '');
  const index = account.positions.findIndex((position) => String(position.id) === positionId && walletKey(position.walletOwner) === req.walletAddress);
  if (index < 0) {
    res.status(404).json({ error: 'Position not found' });
    return;
  }
  const position = account.positions[index];
  const auditSig = req.body?.auditSig ? String(req.body.auditSig) : '—';
  const market = getMarketRecord({ sym: position.sym, name: position.name, addr: position.addr });
  const pool = getPoolRecord(market);
  // --- Price staleness validation ---
  if (market?.updatedAt) {
    const updatedAtMs = new Date(market.updatedAt).getTime();
    const nowMs = Date.now();
    const priceAgeMs = nowMs - updatedAtMs;
    if (priceAgeMs > 30000) {
      const priceAgeSec = Math.floor(priceAgeMs / 1000);
      console.warn(`[${new Date().toISOString()}] [STALE_PRICE] Reject liquidate position: ${market.sym} price age ${priceAgeSec}s`);
      res.status(409).json({ error: 'STALE_PRICE', message: 'Price data is too old. Cannot execute trade.', priceAge: priceAgeSec });
      return;
    }
  }
  // --- End staleness validation ---
  const quote = buildTradeQuote({
    market,
    pool,
    side: position.side,
    marginSol: Math.max(0, clampNumber(position.margin, 0)),
    leverage: Math.max(1, clampNumber(position.lev, 1)),
    mode: 'close',
    quantity: Math.max(0, clampNumber(position.qty, 0)),
    positionNotionalUsd: Math.max(0, clampNumber(position.notional, 0)),
  });
  if (quote.error) {
    res.status(400).json({ error: quote.error });
    return;
  }
  const markPrice = quote.executionPrice;
  const solUsd = quote.solUsd;
  const pnlUsd = position.side === 'long'
    ? (markPrice - position.entry) * position.qty
    : (position.entry - markPrice) * position.qty;
  const pnlSol = pnlUsd / solUsd;
  const penaltySol = Math.max(0, position.margin * 0.05);
  const penaltyUsd = penaltySol * solUsd;
  const recovered = Math.max(0, position.margin + pnlSol - penaltySol - quote.feeSol);
  account.balanceSol = Math.max(0, account.balanceSol + recovered);
  account.realizedPnlUsd += (pnlUsd - penaltyUsd - quote.feeUsd);
  account.realizedBasisUsd += Math.max(0, clampNumber(position.marginUsd, 0));
  applyPoolRelease(pool, position.side, Math.max(0, clampNumber(position.notional, 0)));
  pool.insuranceUsd = Math.max(0, clampNumber(pool.insuranceUsd, 0) + penaltyUsd);
  pool.feeAccruedUsd = Math.max(0, clampNumber(pool.feeAccruedUsd, 0) + quote.feeUsd);
  pool.liquidityUsd = Math.max(MIN_POOL_LIQUIDITY_USD, clampNumber(pool.liquidityUsd, MIN_POOL_LIQUIDITY_USD) - pnlUsd + quote.feeUsd);
  account.positions.splice(index, 1);
  recalcAccountRiskMetrics(account);
  appendHistory(account, 'LIQ', `${position.sym} ${position.side.toUpperCase()} liquidated @ ${markPrice.toFixed(6)} · recovery ${recovered.toFixed(4)} SOL · penalty $${penaltyUsd.toFixed(2)} · fee $${quote.feeUsd.toFixed(2)}`, auditSig);
  persistRecord(account);
  res.json({ ok: true, quote, accountState: getAccountState(req.walletAddress) });
});


// Serve home.html as the default homepage
app.get('/', (_req, res) => {
  res.sendFile(path.join(WORKSPACE_ROOT, 'home.html'));
});

// Optional: keep /trade and /mainnet redirects if needed, or remove if not used
app.get('/trade', (_req, res) => {
  res.redirect('/testnet.html');
});
app.get('/mainnet', (_req, res) => {
  res.redirect('/index.html?mainnet=1');
});

const PUBLIC_FILE_ALLOWLIST = new Set([
  '/home.html',
  '/index.html',
  '/testnet.html',
  '/setup.html',
  '/manifest.json',
  '/service-worker.js',
  '/favicon.ico',
  '/faq.html',
]);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }

  const reqPath = String(req.path || '/');
  // Try both posix and win32 normalization for allowlist
  const normalizedPosix = path.posix.normalize(reqPath);
  const normalizedWin = path.win32.normalize(reqPath).replace(/\\/g, '/');
  const isAllowed = PUBLIC_FILE_ALLOWLIST.has(normalizedPosix) || PUBLIC_FILE_ALLOWLIST.has(normalizedWin);
  if (!normalizedPosix.startsWith('/') && !normalizedWin.startsWith('/')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!isAllowed) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  // Always use path.join with the file name only (strip leading slash)
  const fileName = normalizedPosix.startsWith('/') ? normalizedPosix.slice(1) : normalizedPosix;
  res.sendFile(path.join(WORKSPACE_ROOT, fileName));
});

app.listen(PORT, () => {
  console.log(`MemePerp shared testnet backend listening on http://localhost:${PORT}`);
});