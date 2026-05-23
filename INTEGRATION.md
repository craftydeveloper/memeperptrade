# MemePerp — Drift Protocol Integration Guide

## Architecture Overview

```
Frontend (index.html / React)
    ↓
@drift-labs/sdk  ←→  Solana RPC (Helius / Triton)
    ↓
Drift Protocol (Mainnet)
    ├── Perp Markets (BONK-PERP, WIF-PERP, etc.)
    ├── Oracles (Pyth + Switchboard)
    └── Clearing House (on-chain settlement)
```

---

## 1. Install Dependencies

```bash
npm install @drift-labs/sdk @solana/web3.js @solana/wallet-adapter-react \
  @solana/wallet-adapter-phantom @solana/wallet-adapter-solflare \
  @solana/wallet-adapter-backpack bn.js
```

---

## 2. Drift Client Setup (`src/lib/driftClient.ts`)

```typescript
import {
  DriftClient,
  BulkAccountLoader,
  PerpMarkets,
  BASE_PRECISION,
  QUOTE_PRECISION,
  PositionDirection,
  OrderType,
  convertToNumber,
  calculateEntryPrice,
  calculateLiquidationPrice,
} from '@drift-labs/sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';

const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY';

export async function initDriftClient(wallet: any) {
  const connection = new Connection(RPC_URL, 'confirmed');
  const provider = new AnchorProvider(connection, wallet, {});

  const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1000);

  const driftClient = new DriftClient({
    connection,
    wallet: provider.wallet,
    programID: new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH'),
    accountSubscription: {
      type: 'polling',
      accountLoader: bulkAccountLoader,
    },
  });

  await driftClient.subscribe();
  return driftClient;
}
```

---

## 3. Fetch Available Memecoin Markets (`src/lib/markets.ts`)

```typescript
import { DriftClient, PerpMarkets, MainnetPerpMarkets } from '@drift-labs/sdk';

// Drift currently supports these memecoin perps on mainnet:
// Market indices may change — always fetch dynamically
export const MEMECOIN_MARKET_IDS: Record<string, number> = {
  'BONK': 4,   // BONK-PERP
  'WIF':  21,  // WIF-PERP  
  'BOME': 37,  // BOME-PERP
  'POPCAT': 51, // POPCAT-PERP (if listed)
};

export async function fetchMarketData(driftClient: DriftClient, marketIndex: number) {
  const perpMarket = driftClient.getPerpMarketAccount(marketIndex);
  if (!perpMarket) throw new Error(`Market ${marketIndex} not found`);

  const oraclePrice = driftClient.getOracleDataForPerpMarket(marketIndex);

  return {
    symbol: perpMarket.name,
    price: convertToNumber(oraclePrice.price, QUOTE_PRECISION),
    openInterest: convertToNumber(perpMarket.amm.baseAssetAmountWithAmm, BASE_PRECISION),
    fundingRate: convertToNumber(perpMarket.amm.lastFundingRate, QUOTE_PRECISION) * 100,
    volume24h: convertToNumber(perpMarket.amm.volume24H, QUOTE_PRECISION),
  };
}
```

---

## 4. Open a Long / Short Position (`src/lib/trading.ts`)

```typescript
import {
  DriftClient,
  OrderType,
  PositionDirection,
  BASE_PRECISION,
  QUOTE_PRECISION,
  BN,
  convertToNumber,
  getLimitOrderParams,
  getMarketOrderParams,
  PostOnlyParams,
} from '@drift-labs/sdk';

export interface OrderParams {
  marketIndex: number;        // e.g. 4 for BONK-PERP
  direction: 'long' | 'short';
  sizeUSDC: number;           // collateral in USDC
  leverage: number;           // 1–10x
  orderType: 'market' | 'limit';
  limitPrice?: number;        // only for limit orders
}

export async function placeOrder(driftClient: DriftClient, params: OrderParams) {
  const { marketIndex, direction, sizeUSDC, leverage, orderType, limitPrice } = params;

  // Calculate base asset amount from USDC + leverage
  const oraclePrice = convertToNumber(
    driftClient.getOracleDataForPerpMarket(marketIndex).price,
    QUOTE_PRECISION
  );
  const notionalValue = sizeUSDC * leverage;
  const baseAssetAmount = new BN((notionalValue / oraclePrice) * BASE_PRECISION.toNumber());

  const positionDirection = direction === 'long'
    ? PositionDirection.LONG
    : PositionDirection.SHORT;

  if (orderType === 'market') {
    const orderParams = getMarketOrderParams({
      marketIndex,
      direction: positionDirection,
      baseAssetAmount,
    });
    const txSig = await driftClient.placePerpOrder(orderParams);
    return txSig;
  } else {
    // Limit order
    if (!limitPrice) throw new Error('Limit price required');
    const price = new BN(limitPrice * QUOTE_PRECISION.toNumber());
    const orderParams = getLimitOrderParams({
      marketIndex,
      direction: positionDirection,
      baseAssetAmount,
      price,
    });
    const txSig = await driftClient.placePerpOrder(orderParams);
    return txSig;
  }
}

export async function closePosition(driftClient: DriftClient, marketIndex: number) {
  const position = driftClient.getPerpPosition(marketIndex);
  if (!position) throw new Error('No open position for this market');

  const txSig = await driftClient.closePosition(marketIndex);
  return txSig;
}
```

---

## 5. Deposit Collateral (USDC) (`src/lib/collateral.ts`)

```typescript
import { DriftClient, BN, QUOTE_PRECISION } from '@drift-labs/sdk';
import { getAssociatedTokenAddress } from '@solana/spl-token';

// USDC mint on mainnet
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export async function depositUSDC(driftClient: DriftClient, amountUSDC: number) {
  const amount = new BN(amountUSDC * QUOTE_PRECISION.toNumber());
  const userTokenAccount = await getAssociatedTokenAddress(
    new PublicKey(USDC_MINT),
    driftClient.wallet.publicKey
  );
  const txSig = await driftClient.deposit(amount, 0, userTokenAccount); // 0 = USDC market index
  return txSig;
}

export async function withdrawUSDC(driftClient: DriftClient, amountUSDC: number) {
  const amount = new BN(amountUSDC * QUOTE_PRECISION.toNumber());
  const userTokenAccount = await getAssociatedTokenAddress(
    new PublicKey(USDC_MINT),
    driftClient.wallet.publicKey
  );
  const txSig = await driftClient.withdraw(amount, 0, userTokenAccount);
  return txSig;
}
```

---

## 6. Live Price Feed — Birdeye API (`src/lib/prices.ts`)

```typescript
const BIRDEYE_API = 'https://public-api.birdeye.so';
const BIRDEYE_KEY = 'YOUR_BIRDEYE_API_KEY'; // get free key at birdeye.so

export const MEMECOIN_ADDRESSES: Record<string, string> = {
  BONK:   'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF:    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  POPCAT: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  BOME:   'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
  MYRO:   'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4',
};

export async function getTokenPrice(symbol: string): Promise<number> {
  const address = MEMECOIN_ADDRESSES[symbol];
  if (!address) throw new Error(`Unknown token: ${symbol}`);

  const res = await fetch(
    `${BIRDEYE_API}/defi/price?address=${address}`,
    { headers: { 'X-API-KEY': BIRDEYE_KEY } }
  );
  const data = await res.json();
  return data.data.value;
}

export async function getOHLCV(
  symbol: string,
  resolution: '1' | '5' | '60' | '240' | '1D',
  limit = 100
): Promise<{ time: number; open: number; high: number; low: number; close: number; volume: number }[]> {
  const address = MEMECOIN_ADDRESSES[symbol];
  const res = await fetch(
    `${BIRDEYE_API}/defi/ohlcv?address=${address}&type=${resolution}&limit=${limit}`,
    { headers: { 'X-API-KEY': BIRDEYE_KEY } }
  );
  const data = await res.json();
  return data.data.items;
}

// WebSocket for real-time price updates
export function subscribeToPrices(symbols: string[], onUpdate: (symbol: string, price: number) => void) {
  const ws = new WebSocket('wss://public-api.birdeye.so/socket/solana');
  ws.onopen = () => {
    symbols.forEach(sym => {
      ws.send(JSON.stringify({
        type: 'SUBSCRIBE_PRICE',
        data: { chartType: '1m', address: MEMECOIN_ADDRESSES[sym], currency: 'usd' }
      }));
    });
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'PRICE_DATA') {
      const sym = Object.entries(MEMECOIN_ADDRESSES).find(([_, addr]) => addr === msg.data.address)?.[0];
      if (sym) onUpdate(sym, msg.data.value);
    }
  };
  return ws;
}
```

---

## 7. Fetch Positions & PnL (`src/lib/positions.ts`)

```typescript
import {
  DriftClient,
  calculatePositionPNL,
  calculateEntryPrice,
  calculateLiquidationPrice,
  convertToNumber,
  QUOTE_PRECISION,
  BASE_PRECISION,
} from '@drift-labs/sdk';

export async function getUserPositions(driftClient: DriftClient) {
  const user = driftClient.getUser();
  const positions = user.getActivePerpPositions();

  return positions.map(pos => {
    const marketIndex = pos.marketIndex;
    const perpMarket = driftClient.getPerpMarketAccount(marketIndex)!;
    const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);

    const pnl = calculatePositionPNL(perpMarket, pos, true, oracleData);
    const entryPrice = calculateEntryPrice(pos);
    const liqPrice = calculateLiquidationPrice(pos, driftClient.getUser().getTotalCollateral(), perpMarket, oracleData);

    return {
      marketIndex,
      side: pos.baseAssetAmount.gt(new BN(0)) ? 'long' : 'short',
      baseAmount: convertToNumber(pos.baseAssetAmount.abs(), BASE_PRECISION),
      entryPrice: convertToNumber(entryPrice, QUOTE_PRECISION),
      markPrice: convertToNumber(oracleData.price, QUOTE_PRECISION),
      liqPrice: liqPrice ? convertToNumber(liqPrice, QUOTE_PRECISION) : null,
      unrealizedPnl: convertToNumber(pnl, QUOTE_PRECISION),
    };
  });
}

export async function getAccountStats(driftClient: DriftClient) {
  const user = driftClient.getUser();
  return {
    totalCollateral: convertToNumber(user.getTotalCollateral(), QUOTE_PRECISION),
    freeCollateral: convertToNumber(user.getFreeCollateral(), QUOTE_PRECISION),
    unrealizedPnl: convertToNumber(user.getUnrealizedPNL(true), QUOTE_PRECISION),
    leverage: convertToNumber(user.getLeverage(), new BN(10000)), // 4 decimal places
  };
}
```

---

## 8. Wallet Adapter (React) (`src/providers/WalletProvider.tsx`)

```tsx
import { FC, ReactNode, useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { BackpackWalletAdapter } from '@solana/wallet-adapter-backpack';

const RPC_ENDPOINT = 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY';

export const SolanaWalletProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const wallets = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
    new BackpackWalletAdapter(),
  ], []);

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
```

---

## 9. Environment Variables (`.env`)

```env
VITE_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
VITE_BIRDEYE_API_KEY=your_birdeye_key_here
VITE_DRIFT_PROGRAM_ID=dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH

# For analytics/leaderboard (optional)
VITE_SUPABASE_URL=https://yourproject.supabase.co
VITE_SUPABASE_KEY=your_anon_key
```

---

## 10. Recommended RPC Providers

| Provider | Free Tier | Notes |
|---|---|---|
| [Helius](https://helius.dev) | 50k req/day | Best for Solana, websocket support |
| [Triton](https://triton.one) | Paid only | Ultra-low latency, used by Drift |
| [QuickNode](https://quicknode.com) | Limited free | Easy setup |

---

## Deploy Checklist

- [ ] RPC endpoint configured (Helius recommended)
- [ ] Birdeye API key for price feeds
- [ ] Drift SDK initialized and subscribing
- [ ] USDC token account handling
- [ ] Error handling for failed transactions
- [ ] Transaction confirmation with retry logic
- [ ] Mobile wallet deep-link support
- [ ] Liquidation warning notifications
- [ ] Rate limiting on price feed calls

---

## Drift Protocol Resources

- Docs: https://docs.drift.trade
- SDK: https://github.com/drift-labs/protocol-v2/tree/master/sdk
- Mainnet Markets: https://app.drift.trade
- Discord: https://discord.gg/drift-protocol
