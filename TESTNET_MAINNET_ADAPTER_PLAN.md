# Testnet -> Mainnet Adapter Plan

## Goal
Build and validate full trading behavior in testnet now, then switch to mainnet with minimal UI changes by replacing only the execution adapter.

## Reality Check
- You can implement almost all UX, risk checks, and state transitions in current testnet mode.
- You cannot achieve trustless, production-grade shorting/liquidation/accounting without onchain state.

## Adapter Contract
Use one engine interface and two implementations:
- `SimEngine` (current testnet local/offchain behavior)
- `OnchainEngine` (future program-backed behavior)

```ts
export type TradeSide = 'long' | 'short';

export interface MarketRef {
  sym: string;
  addr: string;
  maxLev: number;
  oiCap: number;
  delisted?: boolean;
}

export interface OpenOrderInput {
  market: MarketRef;
  side: TradeSide;
  marginSol: number;
  leverage: number;
  limitPrice?: number | null;
}

export interface OpenOrderResult {
  positionId?: string;
  txSig?: string;
  chainStatus: 'simulated' | 'submitted' | 'confirmed' | 'finalized';
}

export interface CloseOrderInput {
  positionId: string;
}

export interface LiquidationInput {
  positionId: string;
  markPrice: number;
}

export interface HealthView {
  marginRatio: number;
  maintenanceRatio: number;
  liquidationPrice: number;
  status: 'healthy' | 'warning' | 'liquidatable';
}

export interface TradingEngine {
  openPosition(input: OpenOrderInput): Promise<OpenOrderResult>;
  closePosition(input: CloseOrderInput): Promise<{ txSig?: string; chainStatus: string }>;
  liquidate(input: LiquidationInput): Promise<{ txSig?: string; chainStatus: string }>;
  getHealth(positionId: string): Promise<HealthView>;
  reconcile(): Promise<void>;
}
```

## Mapping To Current Testnet Code
Current functions already align with this interface:
- `openPosition` -> `testnet.html:2044`
- `closePos` -> `testnet.html:2113`
- `processLiquidationQueue` -> `testnet.html:2206`
- `reconcileHistoryOnChain` -> `testnet.html:2252`
- `requireAudit` (audit gate) -> `testnet.html:1012`
- `marketRiskText` (risk checks) -> `testnet.html:1676`
- `renderKPIs`/`renderPositions` (derived state + PnL UI) -> `testnet.html:1600`, `testnet.html:2159`

## Phase Plan

### Phase 1: Introduce Engine Boundary (No Behavior Change)
1. Keep UI handlers, but call engine methods from:
- `openPosition` (`testnet.html:2044`)
- `closePos` (`testnet.html:2113`)
- `processLiquidationQueue` (`testnet.html:2206`)
2. Move local math/state mutation into `SimEngine`.
3. Keep `history`, `positions`, `balance` unchanged so UX is stable.

Outcome:
- Existing testnet behavior remains identical.
- Engine swap becomes possible later.

### Phase 2: Harden Simulation (Still Offchain)
1. Centralize risk formulas used by:
- `marketRiskText` (`testnet.html:1676`)
- liquidation trigger logic (`testnet.html:2290`)
2. Add deterministic replay mode for stress tests:
- fixed seed randomization for price/orderbook.
3. Add scenario tests:
- gap-down long liquidation,
- short squeeze,
- stale oracle/price feed fallback.

Outcome:
- You can validate logic and UX before touching contracts.

### Phase 3: Onchain Audit First
1. Keep `TESTNET_ONCHAIN_ONLY=false` initially, but require audit signatures in critical paths.
2. Turn on intent signatures for orders (`TESTNET_REQUIRE_ORDER_SIGNATURE`).
3. Use `reconcileHistoryOnChain` as control plane health monitor.

Outcome:
- Better operational confidence with current app structure.

### Phase 4: Onchain Engine Integration (Testnet)
1. Implement `OnchainEngine.openPosition/closePosition/liquidate`.
2. Replace local position source with chain-indexed position source.
3. Keep UI and risk display code; only data source/execution changes.

Outcome:
- True testnet onchain behavior using the same front-end flow.

### Phase 5: Promote To Mainnet
1. Feature flag by network:
- testnet -> `OnchainEngine` test deployment
- mainnet -> `OnchainEngine` production deployment
2. Rollout stages:
- shadow/read-only,
- small caps + allowlist,
- gradual expansion.

Outcome:
- Controlled mainnet launch without rewriting UI logic.

## What You Can Implement Right Now Without Onchain
- Complete UI and flow for long/short lifecycle
- Full risk pre-check pipeline
- Liquidation queue and keeper simulation
- Trade history and audit status UX
- Engine abstraction and deterministic testing harness

## What Must Wait For Onchain
- True borrow/lend debt accounting for shorts
- Trustless liquidation enforcement
- Canonical, tamper-resistant position ledger
- Provable collateral solvency

## Minimal Immediate TODOs
1. Add `TradingEngine` and `SimEngine` in a dedicated module.
2. Refactor `openPosition/closePos/processLiquidationQueue` to call engine methods.
3. Enable order-intent signatures in testnet for user action integrity.
4. Keep reconciliation loop and onchain audit stats visible by default.
5. Add one-click switch: `simulation` vs `onchain` mode in testnet UI.
