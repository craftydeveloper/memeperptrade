# MemePerp — Data Persistence & State Management Guide

## Overview

MemePerp uses **browser localStorage** to persist all critical trading data and UI state across page reloads. Everything you configure, trade, and track survives browser refresh and remains available.

---

## What Gets Saved & Loaded

### ✅ **Automatically Persisted Data**

#### 1. **Positions & Open Trades**
```javascript
localStorage key: 'mp_positions'
Content: Array of open positions with:
  - Position ID, entry price, size, leverageused
  - Current PnL, liquidation price, unrealized gains/losses
Saved: Every trade execution, position close, PnL update
Loaded: On page init
Impact: ⭐⭐⭐⭐⭐ CRITICAL - Your money stays tracked
```

#### 2. **Trade History**
```javascript
localStorage key: 'mp_history'
Content: Complete audit trail with:
  - Trade ID, timestamp, coin, side (long/short)
  - Size, leverage, entry price, order type
  - Execution status (pending/filled/cancelled)
  - On-chain signature for verification
Saved: Every order placement, cancellation, fill
Loaded: On page init
Impact: ⭐⭐⭐⭐ Essential - Full P&L reconciliation
```

#### 3. **UI Preferences & Settings**
```javascript
localStorage keys:
  'mp_apiKeys'      → RPC endpoint, Birdeye API key
  'mp_slippage'     → Slippage tolerance (bps)
  'mp_chart_enabled'→ Chart on/off state

Saved: When you change settings
Loaded: On page init
Impact: ⭐⭐⭐ Quality of life - No reconfiguration needed
```

#### 4. **Trading Preferences (NEW)**
```javascript
localStorage keys:
  'mp_side'        → Last used side (long or short)
  'mp_leverage'    → Last used leverage amount
  'mp_orderType'   → Last order type (market or limit)
  'mp_timeframe'   → Last chart timeframe (1m, 5m, 1h, etc.)

Saved: Every time you change these settings
Loaded: On page init
Impact: ⭐⭐⭐ Convenience - Hot preferences recalled
```

#### 5. **Auto-Save Backup (NEW)**
```javascript
localStorage key: 'mp_backup'
Content: Complete state snapshot:
  - All positions
  - Full trade history
  - Current UI settings
  - Timestamp of backup
Saved: Every 5 seconds automatically
Loaded: If corrupted data detected
Impact: ⭐⭐⭐⭐ Safety net - Recovers from data corruption
```

---

## How Persistence Works

### **On Page Load (DOMContentLoaded)**

```javascript
1. Validate all stored data (corruption check)
   → If JSON parse fails → clear corrupted key

2. Load API Keys → apiKeysLocal object
   → Restore RPC endpoint, Birdeye key

3. Load UI Preferences
   → side, lev, orderType, currentTf
   → Update button states, slider positions

4. Load Trade History → tradeHistory array
   → Restore complete audit trail

5. Load Open Positions → positions array
   → Restore all active trades

6. Start auto-save interval
   → Creates backup every 5 seconds
   → Background process, no impact on trading
```

### **During Trading (Continuous)**

```javascript
Every action triggers targeted saves:

Trade Execution:
  → Save to mp_history (new trade entry)
  → Save to mp_positions (if position created)
  → Auto-save backup

Position Change:
  → Save to mp_positions (updated PnL)
  → Auto-save backup (every 5s)

Settings Change:
  → Save to mp_slippage, mp_apiKeys, etc.
  → Immediate save (not deferred)

UI State Change:
  → setSide()        → Save to mp_side
  → setLev()         → Save to mp_leverage
  → setOT()          → Save to mp_orderType
  → setTF()          → Save to mp_timeframe
```

### **Backup Strategy**

```javascript
Primary Save Points (immediate):
  - Trade execution
  - Position updates
  - Settings changes

Secondary Backup (5-second interval):
  - Auto-save captures all state
  - Acts as recovery point
  - Prevents data loss from browser crash

Recovery:
  - On init, validateStoredData() checks all keys
  - If JSON parse fails → remove corrupted data
  - Falls back to auto-save if primary corrupted
```

---

## localStorage Keys Reference

| Key | Type | Max Size | Contains | Frequency |
|-----|------|----------|----------|-----------|
| `mp_positions` | JSON Array | ~500KB | Open trades | On trade update |
| `mp_history` | JSON Array | ~2MB | Trade audit trail | On trade action |
| `mp_apiKeys` | JSON | ~1KB | API credentials | On settings save |
| `mp_slippage` | String | <1KB | Slippage bps | On settings save |
| `mp_chart_enabled` | String | <1KB | Chart toggle | On toggle |
| `mp_side` | String | <1KB | Last side (long/short) | On side change |
| `mp_leverage` | String | <1KB | Last leverage | On lever change |
| `mp_orderType` | String | <1KB | Last order type | On type change |
| `mp_timeframe` | String | <1KB | Last timeframe | On TF change |
| `mp_backup` | JSON | ~2.5MB | Complete state | Every 5 seconds |

**Total localStorage usage:** ~5-6 MB (browser allows 5-50MB typically)

---

## Verification: What Persists Across Reload

### ✅ **Test Persistence** (Developer Console)

```javascript
// Before reload:
console.log('Side:', localStorage.getItem('mp_side'));
console.log('Leverage:', localStorage.getItem('mp_leverage'));
console.log('Positions:', JSON.parse(localStorage.getItem('mp_positions')));
console.log('Trade History:', JSON.parse(localStorage.getItem('mp_history')).length);

// Reload page (Ctrl+R or F5)

// After reload:
console.log('Side persisted:', side); // Should show 'long' or 'short'
console.log('Leverage persisted:', lev); // Should show last value
console.log('Positions restored:', positions.length); // Should show count
console.log('History restored:', tradeHistory.length); // Should show count
```

### 📊 **What You'll See After Reload**

| Item | Before Reload | After Reload | Status |
|------|---------------|--------------|--------|
| Open positions | ✓ Listed | ✓ Same | ✅ Persisted |
| Position PnL | ✓ $5,432.10 | ✓ Same value | ✅ Persisted |
| Trade history | ✓ 47 trades | ✓ 47 trades | ✅ Persisted |
| LONG/SHORT button state | ✓ SHORT highlighted | ✓ SHORT highlighted | ✅ Persisted |
| Leverage slider | ✓ 5× | ✓ 5× | ✅ Persisted |
| Chart timeframe | ✓ 1h selected | ✓ 1h selected | ✅ Persisted |
| API keys | ✓ Configured | ✓ Still configured | ✅ Persisted |
| Slippage setting | ✓ 100 bps | ✓ 100 bps | ✅ Persisted |

---

## Data Accuracy & Consistency

### **On-Chain vs Local State**

```
┌──────────────────────────────────────────────────┐
│ YOUR WALLET (On Solana Blockchain)               │
│ ├─ Actual SOL/USDC balance (ground truth)       │
│ ├─ Actual Drift positions (ground truth)         │
│ └─ Transaction history (immutable)               │
└──────────────────────────────────────────────────┘
         ↓ Synced every 5 seconds
┌──────────────────────────────────────────────────┐
│ MemePerp (localStorage)                          │
│ ├─ Cached balances (synced from RPC)            │
│ ├─ Position list (synced from Drift account)    │
│ └─ Trade history (local journal)                 │
└──────────────────────────────────────────────────┘
```

### **How Accuracy is Maintained**

1. **Balance Sync**
   - Queries wallet balance every 5 seconds via RPC
   - Updates displayed SOL/USDC amounts
   - Reflects on-chain reality

2. **Position Sync** (NEW in this update)
   ```javascript
   syncDriftPositions() {
     → Calls driftClient.getUser()
     → Queries actual Drift account state
     → Updates positions array
     → Saves to localStorage
   }
   Set to run every 5 seconds in startBalanceRefresh()
   ```

3. **Trade Verification**
   - Each trade capture stores:
     - On-chain signature (tx hash)
     - Timestamp
     - Execution details (size, price, etc.)
   - Can be verified at any time via Solscan

---

## What If Something Goes Wrong?

### **Scenario 1: Page Crashes During Trade**
```
✓ Trade already executed on-chain (immutable)
✓ On next page load, syncDriftPositions() fetches account state
✓ Position recovers automatically
✓ Trade history shows the trade
Result: NO DATA LOSS (blockchain is source of truth)
```

### **Scenario 2: Corrupted localStorage**
```
✓ validateStoredData() detects bad JSON
✓ Removes corrupted key
✓ mp_backup contains recent snapshot
✓ Fall back to backup if needed
Result: RECOVERS GRACEFULLY
```

### **Scenario 3: localStorage Full (Rare)**
```
⚠️ localStorage quota exceeded (>5-50MB depending on browser)
Fix: Clear history (CTRL+SHIFT+DEL → browsing data → localStorage)
     or reduce trade history (export to CSV first)
     or try incognito mode (separate storage)
Result: MANUAL INTERVENTION NEEDED
```

### **Scenario 4: Lost Internet Connection**
```
✓ All cached state remains in localStorage
✓ Can view positions, history, settings offline
✗ Cannot execute trades (requires blockchain RPC)
✓ On reconnect, full sync occurs
Result: READ-ONLY MODE, full functionality on reconnect
```

---

## To Verify Everything is Saved

### **After Every Trade:**

1. **Check localStorage (DevTools)**
   ```javascript
   // Open DevTools (F12) → Console
   console.table(JSON.parse(localStorage.getItem('mp_positions')));
   console.table(JSON.parse(localStorage.getItem('mp_history')).slice(-5));
   ```

2. **Check UI State is Saved**
   - If you selected LONG → reload → should still show LONG
   - If you set leverage to 10× → reload → should show 10×
   - If you selected 5m chart → reload → should show 5m

3. **Check Backup System**
   ```javascript
   // Should be updated every 5 seconds
   const backup = JSON.parse(localStorage.getItem('mp_backup'));
   console.log('Backup timestamp:', new Date(backup.ts));
   console.log('Backup positions:', backup.positions.length);
   ```

4. **Check Position Syncing**
   - Position PnL updates in real-time
   - Saving every 5 seconds to backup
   - Compare browser PnL with Drift account (should match)

---

## Summary: Full Persistence Guarantee

| Layer | What's Saved | How Often | Recovers From |
|-------|--------------|-----------|---------------|
| **Trade Execution** | Position created, trade logged | Immediately | Page crash, network loss |
| **Settings** | API keys, slippage | On change | Browser reset, privat mode |
| **UI State** | Side, leverage, order type, timeframe | On change | Page reload |
| **Backup** | All state snapshot | Every 5s | Data corruption |
| **Sync** | Balance, position state from Drift | Every 5s | Drift account mismatch |

✅ **Result: Your trading state is bulletproof. Everything persists accurately across reloads, crashes, and network issues.**

---

## Advanced: Manual Data Export/Import

### **Export Trade History**
```javascript
// In DevTools console:
const hist = JSON.parse(localStorage.getItem('mp_history'));
const csv = hist.map(t => 
  `${t.ts},${t.coin},${t.side},${t.sz},${t.px},${t.status}`
).join('\n');
console.save(csv, 'trades.csv');
```

### **Export Positions**
```javascript
const pos = JSON.parse(localStorage.getItem('mp_positions'));
console.save(JSON.stringify(pos, null, 2), 'positions.json');
```

### **Clear All Data (Hard Reset)**
```javascript
localStorage.clear(); // Remove all MemePerp data
// Reload page — starts fresh
```

---

## Next Steps

1. ✅ **Reload your page now** — verify all your positions/trades persist
2. ✅ **Open DevTools (F12)** — check localStorage keys exist
3. ✅ **Change a setting** (side, leverage) — reload and verify it stayed
4. ✅ **Place a trade** — reload and verify it appears in trade history
5. ✅ **Monitor the backup** — check mp_backup updates every 5 seconds

**You're now fully set for persistent, accurate trading state! 🎯**
