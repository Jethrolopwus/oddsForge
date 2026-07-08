# OddsForge — Technical Documentation

> **Hackathon**: TxODDS World Cup Hackathon 2026 — Trading Tools & Agents Track  
> **Author**: Jethro Lopwus — Blockfuse Labs, Jos, Nigeria  
> **GitHub**: [github.com/Jethrolopwus/oddsforge](https://github.com/Jethrolopwus/oddsforge)  
> **Stack**: Solana · Anchor · TypeScript · TxLINE · Jito · Yellowstone gRPC

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [Data Flow](#3-data-flow)
4. [TxLINE Integration](#4-txline-integration)
5. [Signal Detection Engine](#5-signal-detection-engine)
6. [Decision & Strategy Engine](#6-decision--strategy-engine)
7. [On-Chain Program (Anchor)](#7-on-chain-program-anchor)
8. [Jito Bundle Execution](#8-jito-bundle-execution)
9. [Yellowstone Geyser Monitoring](#9-yellowstone-geyser-monitoring)
10. [Agent Lifecycle & Autonomous Loop](#10-agent-lifecycle--autonomous-loop)
11. [Repository Structure](#11-repository-structure)
12. [Configuration Reference](#12-configuration-reference)
13. [Getting Started](#13-getting-started)
14. [Testing](#14-testing)
15. [Security Considerations](#15-security-considerations)

---

## 1. Project Overview

OddsForge is a **fully autonomous on-chain trading agent** built on Solana. It ingests live World Cup odds from the TxLINE data feed, detects statistically significant odds movements using a proprietary signal engine, and records cryptographically verifiable on-chain positions via a custom Anchor smart contract — all without any manual intervention after startup.

### Key Properties

| Property | Detail |
|---|---|
| **Data source** | TxLINE SSE stream (`/api/odds/stream`) |
| **Data feed type** | Server-Sent Events (real-time, free tier) |
| **Chain** | Solana Mainnet / Devnet |
| **Smart contract** | Anchor 0.31.1, Program ID `7NeF1c8RMvLzM7qDgcroJ3PmmTbQpWCCaAw2dWHYfAwL` |
| **Execution** | Jito MEV bundles |
| **State confirmation** | Yellowstone gRPC (Triton One) |
| **Signal threshold** | ≥ 5% odds movement in 60 seconds, score ≥ 60/100 |
| **Autonomy** | Zero manual input after `npm run start` |

---

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        ODDSFORGE AGENT (Node.js)                     │
│                                                                      │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐ │
│  │  TxLineAuth     │───▶│  TxLineConnector │───▶│  SignalEngine   │ │
│  │  (bootstrap)    │    │  (SSE stream)    │    │  (score 0-100)  │ │
│  └─────────────────┘    └──────────────────┘    └────────┬────────┘ │
│                                                           │          │
│                                                    score ≥ 60        │
│                                                           ▼          │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐ │
│  │  GeyserListener │◀───│  AnchorExecutor  │◀───│  StrategyEngine │ │
│  │  (confirm PDA)  │    │  (place_stake)   │    │  (size + gate)  │ │
│  └─────────────────┘    └──────────────────┘    └─────────────────┘ │
│                                  │                                   │
│                                  ▼                                   │
│                         ┌──────────────────┐                        │
│                         │   JitoExecutor   │                        │
│                         │  (bundle + tip)  │                        │
│                         └────────┬─────────┘                        │
└──────────────────────────────────│───────────────────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │       SOLANA MAINNET         │
                    │                             │
                    │  oddsforge-executor (Anchor) │
                    │  Position PDA accounts       │
                    │  TxOracle (TxLINE program)   │
                    └─────────────────────────────┘
```

### Component Responsibilities

| Component | File | Role |
|---|---|---|
| `TxLineAuth` | `feeds/txline-auth.ts` | Bootstraps TxLINE subscription and API token |
| `TxLineConnector` | `feeds/txline.ts` | Streams live odds via SSE |
| `SignalEngine` | `engine/signal.ts` | Detects and scores odds movements |
| `StrategyEngine` | `engine/strategy.ts` | Gates, deduplicates, and sizes positions |
| `AnchorExecutor` | `executor/anchor.ts` | Calls on-chain program instructions |
| `JitoExecutor` | `executor/jito.ts` | Packages and submits Jito bundles |
| `GeyserListener` | `feeds/geyser.ts` | Streams account updates from Yellowstone gRPC |
| `OddsForgeAgent` | `index.ts` | Wires all components, manages lifecycle |

---

## 3. Data Flow

The complete data path from a live odds tick to an on-chain position:

```
1. TxLINE SSE tick arrives
   └─ OddsEvent { fixtureId, bookmaker, superOddsType,
                  priceNames[], prices[] (i32 millionths) }

2. SignalEngine.ingest(event)
   └─ Per key (fixtureId|selectionName|bookmaker):
      - Record decimal odds in rolling 60s history
      - If Δodds ≥ 5%: compute score(speed, magnitude, consistency)
      - If score ≥ 60: emit Signal

3. StrategyEngine.evaluate(signal)
   └─ Gate: score ≥ minScore (default 60)
   └─ Dedup: no open position for this fixtureId|selectionName
   └─ Guard: no in-flight execution for this key
   └─ Size stake: linear(score 60→100, lamports 0.01→0.10 SOL)
   └─ Return TradeDecision

4. JitoExecutor.executeDecision(decision)
   └─ Build place_stake instruction (via AnchorExecutor)
   └─ Build tip transfer to random Jito tip account (0.0001 SOL)
   └─ Sign transaction
   └─ POST /api/v1/bundles to Jito Block Engine
   └─ Poll getBundleStatuses until finalized

5. AnchorExecutor.place_stake(fixtureId, selectionName, odds, stake, score)
   └─ On-chain: initialise Position PDA
      seeds = [b"position", authority, fixtureId.as_bytes()]

6. GeyserListener receives account update for Position PDA
   └─ Confirms state change on-chain
   └─ Agent logs confirmation

7. [Later] settle_position("won"|"lost"|"voided")
   └─ close_position → rent reclaimed to agent wallet
```

</content>
</invoke>

---

## 4. TxLINE Integration

OddsForge integrates with **TxLINE** — the TxODDS high-performance sports data layer — as its sole data source for live World Cup odds.

### 4.1 Authentication Flow

TxLINE uses a 3-step auth flow. The agent runs this automatically on startup and refreshes every 6 hours.

```
Step 1: POST /auth/guest/start
        ← { token: "<guest_jwt>" }

Step 2: On-chain subscription (Solana)
        program.methods.subscribe(serviceLevelId=12, weeks=4)
        accounts: {
          user, pricingMatrix, tokenMint (TxL),
          userTokenAccount, tokenTreasuryVault,
          tokenTreasuryPda, TOKEN_2022_PROGRAM,
          systemProgram, associatedTokenProgram
        }
        ← txSig (transaction signature)

Step 3: POST /api/token/activate
        headers: { Authorization: Bearer <jwt> }
        body: {
          txSig,
          walletSignature: nacl.sign(txSig + "::" + jwt),
          leagues: []
        }
        ← { token: "<api_token>" }
```

Both credentials are sent on every subsequent data request:

```
Authorization: Bearer <guest_jwt>
X-Api-Token:   <api_token>
```

**Free Tier**: Service level `12` provides **real-time World Cup data at zero cost** during the hackathon (through July 19, 2026). No TxL token purchase required.

### 4.2 TxLINE Program Addresses

| Network | Program ID | API Origin |
|---|---|---|
| Mainnet | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` | `https://txline.txodds.com` |
| Devnet | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` | `https://txline-dev.txodds.com` |

### 4.3 Odds Stream (SSE)

The agent connects to the TxLINE odds stream endpoint:

```
GET /api/odds/stream
Accept: text/event-stream
Accept-Encoding: gzip
Authorization: Bearer <jwt>
X-Api-Token: <api_token>
```

The stream delivers a continuous sequence of SSE messages. Each message payload is a JSON object matching the TxLINE `Odds` IDL type:

```typescript
interface TxLineOdds {
  fixtureId:        string;    // i64 fixture ID (string to avoid JS precision loss)
  messageId:        string;    // dedup key
  ts:               number;    // unix seconds
  bookmaker:        string;    // e.g. "Pinnacle"
  bookmakerId:      number;
  superOddsType:    string;    // market type: "1X2", "ou", "ah", etc.
  gameState:        string | null;  // "1H", "2H", "FT", null (pre-match)
  inRunning:        boolean;   // true during live play
  marketParameters: string | null;  // e.g. "2.5" for over/under
  marketPeriod:     string | null;  // "FT", "1H"
  priceNames:       string[];  // ["home", "draw", "away"]
  prices:           number[];  // integer millionths: 2150000 = odds 2.150
}
```

**Critical detail**: `prices` are **i32 integer millionths**. The agent divides by `1,000,000` to get decimal odds:

```
prices[0] = 2150000  →  2.150 decimal odds
prices[1] = 3200000  →  3.200 decimal odds
prices[2] = 3800000  →  3.800 decimal odds
```

### 4.4 Stream Resilience

- **Gzip decompression**: applied per-chunk using Node.js `zlib.gunzipSync`; falls back to raw decode if chunk is already plain text
- **Auto-reconnect**: exponential backoff from 1s to 30s on any stream error or unexpected close
- **Message dedup**: `messageId` set is maintained per session; purged at 10,000 entries to bound memory
- **Token refresh**: credentials are resolved lazily at stream time so a 6-hour background refresh takes effect without restarting the stream

---

## 5. Signal Detection Engine

**File**: `packages/agent/src/engine/signal.ts`

The signal engine is the analytical core of OddsForge. It maintains a rolling per-market odds history and detects significant movements.

### 5.1 Tracking Key

Each market position is tracked independently by a composite key:

```
key = "{fixtureId}|{selectionName}|{bookmaker}"
```

Example: `"17952170|home|Pinnacle"`

### 5.2 Detection Algorithm

For each incoming `OddsEvent`:

1. Convert prices (millionths → decimal) — done upstream by `TxLineConnector`
2. Record each selection's decimal odds with a millisecond timestamp
3. Maintain a rolling window of the last **60 seconds** of data points
4. Compute percentage change from the oldest point in the window to the latest:

```
pctChange = (currentOdds - baselineOdds) / baselineOdds
```

5. If `|pctChange| < 5%`, skip — below threshold
6. Compute confidence score (see §5.3)
7. If score ≥ 60, emit a `Signal` event

### 5.3 Confidence Scoring (0–100)

The score is the weighted sum of three independent components:

```
score = speedScore + magnitudeScore + consistencyScore
```

#### Speed (30 points)

Measures how rapidly the move happened. A fast move is more likely to reflect genuine information.

```
speedScore = max(0, 1 - elapsedMs / 60000) × 30

elapsedMs = latestTimestamp - baselineTimestamp

Full 30 pts at ≤ 0 ms, 0 pts at 60 s
```

#### Magnitude (40 points)

Measures the size of the percentage move. Larger moves carry more conviction.

```
magnitudeScore = max(0, (min(|pctChange|, 0.25) - 0.05) / 0.20) × 40

5%  move → 0 pts
25% move → 40 pts (capped)
```

#### Consistency (30 points)

Measures whether all individual ticks point in the same direction as the net move. A consistent drift is more reliable than a noisy oscillation that happens to net positive.

```
alignedFraction = (ticks in net direction) / (total non-zero ticks)
consistencyScore = alignedFraction × 30

All ticks aligned  → 30 pts
50% aligned        → 15 pts
No alignment       → 0 pts
```

### 5.4 Signal Type

```typescript
interface Signal {
  key:              string;   // "fixtureId|selectionName|bookmaker"
  fixtureId:        string;
  selectionName:    string;   // e.g. "home", "draw", "away"
  marketType:       string;   // e.g. "1X2"
  bookmaker:        string;
  currentOdds:      number;   // decimal odds at detection time
  previousOdds:     number;   // baseline odds at window start
  pctChange:        number;   // signed: + = drift up, - = drift down
  score:            number;   // 0–100
  direction:        "up" | "down";
  detectedAt:       number;   // unix ms
  gameState:        string | null;
  inRunning:        boolean;
  marketPeriod:     string | null;
  marketParameters: string | null;
}
```

### 5.5 Memory Management

- History is trimmed to the 60-second window on every write
- Hard cap of 200 data points per key prevents unbounded accumulation
- `pruneHistory()` is called every 30 seconds to sweep all keys and delete entries with no points in the current window

</content>
</invoke>