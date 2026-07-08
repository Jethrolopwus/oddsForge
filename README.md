# OddsForge

> **Forging on-chain decisions from live odds signals**
>
> Built on Solana · Powered by TxODDS · TxODDS World Cup Hackathon 2026

![Solana](https://img.shields.io/badge/Solana-9945FF?style=flat&logo=solana&logoColor=white)
![Anchor](https://img.shields.io/badge/Anchor-0.31.1-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue?logo=typescript)
![Jito](https://img.shields.io/badge/Jito-MEV-orange)

---

## What is OddsForge?

OddsForge is an **autonomous on-chain trading agent** built on Solana for the
**TxODDS World Cup Hackathon** (Trading Tools & Agents track). It watches live
World Cup odds from the TxODDS API, detects statistically significant value
signals, and executes on-chain positions automatically via Jito-powered
transactions — all without any manual input.

| | |
|---|---|
| **Hackathon Track** | Trading Tools & Agents |
| **Prize Pool** | $16,000 |
| **Built for** | 2026 FIFA World Cup |

---

## Features

- **Real-time odds ingestion** — Connects to TxODDS WebSocket for live match
  odds and scores across all World Cup games.

- **Autonomous signal detection** — Proprietary engine detects odds movements
  ≥5% within a 60-second window and scores each signal 0–100 for confidence
  using speed, magnitude, and directional consistency.

- **On-chain position tracking** — Every position is stored in a PDA-backed
  Anchor account — fully transparent and verifiable on Solana.

- **Jito-powered execution** — Transactions are submitted as Jito bundles for
  priority landing — minimising latency and failed transactions.

- **Yellowstone Geyser monitoring** — Real-time gRPC streaming watches on-chain
  accounts and confirms position state without polling.

- **Fully autonomous loop** — Agent runs continuously, auto-reconnects on
  disconnection, and requires zero manual input after startup.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ODDSFORGE AGENT                          │
│                                                             │
│  TxODDS WebSocket ──► Signal Engine ──► Score ≥ 60?        │
│                                              │              │
│                                              ▼              │
│                                     Jito Bundle Builder     │
│                                              │              │
│                                              ▼              │
│                            Anchor Program (oddsforge-executor) │
│                                              │              │
│                                              ▼              │
│                            Yellowstone Geyser ── Confirm State │
└─────────────────────────────────────────────────────────────┘
```

### Signal Scoring

Each odds movement is scored 0–100:

| Component | Weight | Description |
|---|---|---|
| Speed | 30 pts | How quickly did the move happen? (full 30 at ≤10 s) |
| Magnitude | 40 pts | Size of the % move (5% → 0, ≥25% → 40) |
| Consistency | 30 pts | Is every tick directionally aligned? |

Signals scoring **≥ 60** trigger a position.

### Stake Sizing

Stakes are scaled linearly with signal score:

```
score = 60  →  MIN_STAKE_LAMPORTS  (0.01 SOL)
score = 100 →  MAX_STAKE_LAMPORTS  (0.10 SOL)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Smart Contract | Anchor 0.31.1 / Rust |
| Agent Runtime | TypeScript / Node.js 18+ |
| Solana Client | `@solana/web3.js` 1.98 |
| MEV Execution | Jito Block Engine REST API |
| Account Streaming | Yellowstone gRPC (`@triton-one/yellowstone-grpc`) |
| Odds Feed | TxODDS WebSocket API |
| Wallet | `@coral-xyz/anchor` NodeWallet |

---

## Project Structure

```
oddsforge/
├── packages/
│   ├── agent/                        # TypeScript autonomous agent
│   │   ├── src/
│   │   │   ├── index.ts              # Entry point & agent loop
│   │   │   ├── feeds/
│   │   │   │   ├── txodds.ts         # TxODDS WebSocket connector
│   │   │   │   └── geyser.ts         # Yellowstone gRPC listener
│   │   │   ├── engine/
│   │   │   │   ├── signal.ts         # Odds signal detection
│   │   │   │   └── strategy.ts       # Decision engine
│   │   │   └── executor/
│   │   │       ├── jito.ts           # Jito bundle builder
│   │   │       └── anchor.ts         # Anchor program caller
│   │   ├── .env.example
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── program/                      # Anchor smart contract
│       └── oddsforge-executor/
│           ├── programs/src/lib.rs   # place_stake, settle_position, close_position
│           └── tests/
│               └── oddsforge-executor.ts
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js v18+
- Rust 1.85+ (`rustup update stable`)
- Solana CLI 1.18+ (`sh -c "$(curl -sSfL https://release.solana.com/stable/install)"`)
- Anchor CLI 0.31.1 (`avm install 0.31.1 && avm use 0.31.1`)
- TxODDS API key
- Triton One Geyser endpoint + token

### Installation

```bash
# Clone the repository
git clone https://github.com/Jethrolopwus/oddsforge
cd oddsforge

# Install agent dependencies
cd packages/agent && npm install

# Build the Anchor program
cd ../program/oddsforge-executor && anchor build
```

### Environment Setup

```bash
cd packages/agent
cp .env.example .env
# Edit .env and fill in your keys
```

Required variables:

| Variable | Description |
|---|---|
| `SOLANA_RPC_URL` | Solana RPC endpoint |
| `SOLANA_PRIVATE_KEY` | Agent wallet (JSON array or base58) |
| `PROGRAM_ID` | Deployed program ID |
| `TXODDS_API_KEY` | TxODDS API key |
| `TXODDS_WS_URL` | TxODDS WebSocket URL |
| `GEYSER_ENDPOINT` | Triton One gRPC endpoint |
| `GEYSER_TOKEN` | Triton One access token |
| `JITO_BLOCK_ENGINE_URL` | Jito Block Engine URL |

Optional tuning variables:

| Variable | Default | Description |
|---|---|---|
| `JITO_TIP_LAMPORTS` | `100000` | Jito tip per bundle (lamports) |
| `MIN_SIGNAL_SCORE` | `60` | Minimum score to place a position |
| `MIN_STAKE_LAMPORTS` | `10000000` | Min stake (0.01 SOL) |
| `MAX_STAKE_LAMPORTS` | `100000000` | Max stake (0.10 SOL) |

### Deploy & Run

```bash
# Deploy Anchor program to devnet
cd packages/program/oddsforge-executor
anchor deploy

# Update PROGRAM_ID in .env with the deployed address

# Build and start the agent
cd ../../agent
npm run build
npm run start
```

The agent will:
1. Connect to TxODDS and start streaming live odds
2. Detect value signals and score them
3. Submit Jito bundles for qualifying signals
4. Watch position PDAs via Geyser for on-chain confirmation
5. Periodically check for settled matches and close positions

---

## How It Works

1. The agent connects to the **TxODDS WebSocket** and streams live odds for all
   active World Cup matches.

2. The **Signal Engine** tracks odds history per match. When it detects a
   movement ≥5% within a 60-second window, it calculates a signal score (0–100)
   based on speed, magnitude, and consistency of the movement.

3. Signals scoring ≥60 are passed to the **Jito Executor**. A Jito bundle is
   built with a tip instruction for priority landing, and the Anchor program's
   `place_stake` instruction is called with the match ID, stake amount, odds
   snapshot, and signal score.

4. The **Yellowstone Geyser** monitor watches the position PDA account for state
   changes and confirms when the transaction is finalized on-chain.

5. After the match concludes, the `settle_position` instruction marks the
   position as Won, Lost, or Voided based on the final TxODDS score data.

6. The `close_position` instruction reclaims the rent lamports from the settled
   position account.

---

## On-Chain Program

### Instructions

| Instruction | Description |
|---|---|
| `place_stake` | Opens a new Position PDA for a match |
| `settle_position` | Marks a position Won / Lost / Voided |
| `close_position` | Closes a settled position and reclaims rent |

### Position Account

```
PDA seeds: ["position", authority, match_id]
```

| Field | Type | Description |
|---|---|---|
| `authority` | `Pubkey` | Wallet that placed the position |
| `match_id` | `String` | TxODDS match identifier (≤ 64 bytes) |
| `selection` | `String` | Outcome placed (≤ 32 bytes) |
| `odds_snapshot` | `u64` | Decimal odds stored as raw f64 bits |
| `stake_lamports` | `u64` | Stake amount in lamports |
| `signal_score` | `u8` | Confidence score at time of placement |
| `status` | `PositionStatus` | Open / Won / Lost / Voided |
| `placed_at` | `i64` | Unix timestamp (placement) |
| `settled_at` | `i64` | Unix timestamp (settlement, 0 if open) |
| `bump` | `u8` | PDA bump seed |

---

## Running Tests

```bash
# Anchor program tests (requires local validator)
cd packages/program/oddsforge-executor
anchor test
```

Tests cover all instructions and error paths:
- `place_stake` — happy path, low score, empty match_id, bad odds, zero stake
- `settle_position` — Won/Lost/Voided, double-settle, invalid outcome, unauthorized
- `close_position` — after settlement, rejected when still open

---

## Key Resources

- [TxODDS API Docs](https://txodds.com/docs)
- [Jito Block Engine Docs](https://jito-labs.gitbook.io/mev)
- [Yellowstone gRPC Docs](https://docs.triton.one/project-yellowstone/whats-yellowstone)
- [Anchor Framework](https://www.anchor-lang.com/)
- [Solana Docs](https://docs.solana.com/)

---

## Author

**Jethro Lopwus** — Solana Developer & Multichain Blockchain Researcher

- GitHub: [@Jethrolopwus](https://github.com/Jethrolopwus)
- X (Twitter): [@Jethrosmitt](https://twitter.com/Jethrosmitt)
- Built at **Blockfuse Labs**, Jos, Nigeria

---

*Built with ♥ for the TxODDS World Cup Hackathon 2026 — Trading Tools & Agents Track*
