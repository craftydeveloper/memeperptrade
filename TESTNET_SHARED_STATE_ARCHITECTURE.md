# MemePerp Testnet Shared State Architecture

## Goal

Make testnet state canonical across browsers, devices, and sessions for the same wallet.

That means the following must be identical anywhere the user opens the page and connects the same wallet:

- in-app testnet balance
- open positions
- unrealized and realized PnL
- activity history
- liquidation state

## Recommended Model

Use a hybrid model:

1. Backend-synced ledger as the primary source of truth for simulated testnet trading state.
2. Onchain wallet signatures and optional onchain audit records for trust, verification, and future migration.

Do not make simulated balance purely browser-local.
Do not make simulated balance purely onchain at the start.

## Why This Model

### Backend-synced solves

- same wallet sees same data in any browser
- same wallet sees same data on any device
- server can enforce ownership and risk limits
- in-app balance button still works
- easier to ship than a full Solana program

### Onchain layer adds

- wallet-proven identity
- signed intent for all state-changing actions
- optional immutable audit trail
- cleaner upgrade path toward real onchain execution later

## Canonical Sources of Truth

### Source of truth by data type

- simulated balance: backend ledger
- positions: backend ledger
- realized PnL: backend ledger
- open PnL: derived from backend positions + live market prices
- history: backend event log
- wallet identity: wallet signature verification
- optional proof of user action: signed message and optional onchain memo/audit tx

## User Experience

### Connect flow

1. User connects wallet.
2. Frontend requests a nonce from backend.
3. Wallet signs a login message.
4. Backend verifies signature.
5. Backend issues a session token.
6. Frontend fetches canonical account state from backend.

Result:

- same wallet gets same account state anywhere
- no reliance on browser localStorage for trading truth

### Add balance flow

1. User clicks `ADD BALANCE`.
2. Frontend requests quote or limit info from backend.
3. User confirms the action with signed message if required.
4. Backend validates rate limits and abuse rules.
5. Backend credits the wallet's simulated ledger balance.
6. Backend stores a history event.
7. Frontend refreshes account state.

Result:

- yes, user can still trade with in-app balance
- balance becomes universal for that wallet across browsers

### Open position flow

1. Frontend sends wallet-authenticated request to open position.
2. Backend validates:
   - wallet session
   - sufficient simulated balance
   - leverage limits
   - market availability
   - OI and liquidation rules
3. Backend debits balance and creates the position in the database.
4. Backend appends a history event.
5. Frontend refetches canonical state.

### Close position flow

1. Frontend requests close for a position ID.
2. Backend verifies the position belongs to the authenticated wallet.
3. Backend computes realized PnL, credits balance, closes the position.
4. Backend appends a history event.
5. Frontend refetches canonical state.

## Security Model

### Required controls

- wallet-based authentication by signed nonce
- short-lived backend session token
- server-side ownership enforcement on every action
- server-side risk checks on every action
- rate limiting for add-balance and action endpoints
- append-only history log
- idempotency keys for write actions

### Important rule

The frontend must never be allowed to decide ownership, balance truth, or position truth.

Frontend can display cached state.
Backend must decide what is valid.

## Backend Components

### API endpoints

Recommended minimum API:

- `POST /auth/nonce`
- `POST /auth/verify`
- `POST /auth/logout`
- `GET /account/state`
- `GET /account/history`
- `POST /balance/add`
- `POST /positions/open`
- `POST /positions/:id/close`
- `GET /markets`
- `GET /prices`

Optional:

- `POST /positions/:id/liquidate`
- `GET /account/audit`
- `POST /audit/intent`

### Database tables

Recommended minimum schema:

#### wallets

- `wallet_address` primary key
- `created_at`
- `last_seen_at`

#### account_ledgers

- `wallet_address`
- `balance_sol`
- `realized_pnl_usd`
- `realized_basis_usd`
- `updated_at`

#### positions

- `id`
- `wallet_address`
- `symbol`
- `market_address`
- `side`
- `margin_sol`
- `leverage`
- `entry_price`
- `quantity`
- `liquidation_price`
- `notional_usd`
- `status`
- `opened_at`
- `closed_at`

#### history_events

- `id`
- `wallet_address`
- `type`
- `message`
- `payload_json`
- `signature`
- `audit_tx`
- `created_at`

#### sessions

- `session_id`
- `wallet_address`
- `expires_at`
- `created_at`

#### balance_grants

- `id`
- `wallet_address`
- `amount_sol`
- `granted_at`
- `window_key`
- `reason`

## Frontend Changes

### Remove as canonical state

These should stop being the source of truth:

- localStorage positions
- localStorage testnet balance
- localStorage realized PnL
- localStorage history

### Keep only as cache or convenience

- selected token
- chart toggle state
- last search token
- viewport mode
- non-critical UI preferences

### New frontend behavior

- after login, fetch `/account/state`
- after every write action, refetch `/account/state`
- poll or subscribe for updates
- render state from backend response only

## Onchain Layer

### Minimum onchain use now

Use onchain for:

- wallet authentication signatures
- optional signed order intent messages
- optional memo/audit transaction for important actions

### Do not use onchain yet for

- simulated balance ledger
- simulated positions ledger
- simulated history as the only storage layer

That would make the system much slower and much harder to operate.

## Cross-Browser Behavior After Migration

Once backend-synced is implemented:

- same wallet + Chrome: same state
- same wallet + Firefox: same state
- same wallet + another device: same state
- different wallet: different state

That is the exact behavior you want.

## Trading With In-App Balance

Yes, still possible.

The difference is:

- today: in-app balance is browser-local
- after migration: in-app balance is backend ledger balance for that wallet

So when user adds balance on one browser, they can open another browser, connect the same wallet, and see the same balance and same positions.

## Migration Strategy

### Phase 1

- stand up backend auth
- add wallet signature login
- add account state endpoint
- stop trusting localStorage for positions/history/balance

### Phase 2

- move add-balance logic to backend ledger
- move open/close/liquidation logic to backend
- add server-side history and audit log

### Phase 3

- add optional onchain audit transactions
- add websocket or SSE state updates
- add admin and abuse controls

### Phase 4

- optionally replace parts of backend ledger with real onchain settlement or protocol integration

## Recommended Stack

### Backend

- Node.js + TypeScript
- Express or Fastify
- PostgreSQL
- Redis for nonce/session/rate-limit support

### Auth

- wallet signature verification using `@solana/web3.js` or `tweetnacl`

### Deployment

- API on Railway, Fly.io, Render, or Azure
- Postgres managed service

## Non-Negotiable Rules

- position ownership must be enforced server-side
- balance debits and credits must happen server-side
- history must be append-only and wallet-scoped
- every state-changing action must require authenticated wallet session
- frontend local state is cache, never source of truth

## Recommended Next Implementation Order

1. Add backend wallet auth.
2. Add canonical `/account/state` response.
3. Replace frontend local balance/positions/history writes with API calls.
4. Move add-balance endpoint to backend.
5. Move open/close/liquidation logic to backend.
6. Add optional signed intents and audit records.

## Summary

If you want the same wallet to see the same testnet state anywhere, the right near-term architecture is:

- backend-synced simulated ledger
- wallet-signature auth
- optional onchain audit proofs

That preserves the current in-app-balance product behavior while making state universal across browsers and devices.