/**
 * engine/strategy.ts
 *
 * Decision Engine — converts raw signals into executable trade decisions.
 *
 * Responsibilities:
 *  1. Gate signals: only act on score ≥ MIN_SCORE (configurable, default 60).
 *  2. Deduplication: one open on-chain position per (matchId, selection) pair.
 *  3. Stake sizing: maps signal score (60–100) to a lamport stake within the
 *     configured min/max range using a linear scale.
 *  4. Selection normalisation: ensures the selection passed to the Anchor
 *     program fits within the 32-byte on-chain limit.
 *  5. Pending-execution guard: prevents firing duplicate transactions while
 *     one is in-flight for the same key.
 */

import type { Signal } from "../engine/signal";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeDecision {
  /** Unique key: "fixtureId|selectionName" (bookmaker-agnostic at execution time) */
  key: string;
  /**
   * String representation of the TxLINE i64 fixture ID.
   * Used as the on-chain `match_id` field in the Position PDA.
   * Limited to 64 bytes — i64 string is at most 20 chars, so this is safe.
   */
  fixtureId: string;
  /** Normalised selection label (≤ 32 bytes UTF-8) */
  selectionName: string;
  /** Decimal odds at signal detection time */
  oddsSnapshot: number;
  /** Stake in lamports */
  stakeLamports: number;
  /** Signal confidence 0–100 */
  signalScore: number;
  /** Movement direction */
  direction: "up" | "down";
  /** Market type e.g. "1X2" */
  marketType: string;
  /** Unix ms when decision was made */
  decidedAt: number;
}

export interface PositionRecord {
  key: string;
  fixtureId: string;
  selectionName: string;
  /** On-chain PDA address (base58) — set after successful placement */
  pdaAddress: string;
  status: "open" | "won" | "lost" | "voided";
  placedAt: number;
}

export interface StrategyConfig {
  /** Minimum signal score to act on (default 60) */
  minScore?: number;
  /** Minimum stake in lamports (default 0.01 SOL = 10_000_000) */
  minStakeLamports?: number;
  /** Maximum stake in lamports (default 0.1 SOL = 100_000_000) */
  maxStakeLamports?: number;
  /**
   * Only take positions on odds-shortenings (price drifting down = bookmaker
   * cutting odds = smart-money backing).  Set false to act on any direction.
   */
  onlyDriftDown?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS: Required<StrategyConfig> = {
  minScore: 60,
  minStakeLamports: 10_000_000,  // 0.01 SOL
  maxStakeLamports: 100_000_000, // 0.10 SOL
  onlyDriftDown: false,
};

const MAX_SELECTION_BYTES = 32;

// ─────────────────────────────────────────────────────────────────────────────
// StrategyEngine
// ─────────────────────────────────────────────────────────────────────────────

export class StrategyEngine {
  private readonly cfg: Required<StrategyConfig>;

  /** Active positions: key → PositionRecord */
  private positions: Map<string, PositionRecord> = new Map();

  /** Keys currently being executed (in-flight tx guard) */
  private pending: Set<string> = new Set();

  constructor(config: StrategyConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Evaluate a signal and return a TradeDecision if it should be acted on,
   * or null if it should be skipped.
   */
  evaluate(signal: Signal): TradeDecision | null {
    // 1. Score gate
    if (signal.score < this.cfg.minScore) {
      return null;
    }

    // 2. Direction filter
    if (this.cfg.onlyDriftDown && signal.direction !== "down") {
      return null;
    }

    // 3. Odds sanity check — require > 1.0
    if (signal.currentOdds <= 1.0) {
      return null;
    }

    const key = `${signal.fixtureId}|${signal.selectionName}`;

    // 4. Deduplication — skip if an open position already exists for this key
    const existing = this.positions.get(key);
    if (existing && existing.status === "open") {
      return null;
    }

    // 5. In-flight guard
    if (this.pending.has(key)) {
      return null;
    }

    // 6. Normalise selection to fit on-chain 32-byte limit
    const selectionName = this._truncateSelection(signal.selectionName);

    // 7. Stake sizing — linear scale mapped to score range 60–100
    const stakeLamports = this._sizeStake(signal.score);

    return {
      key,
      fixtureId: signal.fixtureId,
      selectionName,
      oddsSnapshot: signal.currentOdds,
      stakeLamports,
      signalScore: signal.score,
      direction: signal.direction,
      marketType: signal.marketType,
      decidedAt: Date.now(),
    };
  }

  /**
   * Mark a decision as in-flight (call before sending the transaction).
   */
  markPending(key: string): void {
    this.pending.add(key);
  }

  /**
   * Record a successfully placed on-chain position.
   * Clears the pending flag.
   */
  recordOpen(decision: TradeDecision, pdaAddress: string): void {
    this.pending.delete(decision.key);
    this.positions.set(decision.key, {
      key: decision.key,
      fixtureId: decision.fixtureId,
      selectionName: decision.selectionName,
      pdaAddress,
      status: "open",
      placedAt: decision.decidedAt,
    });
    console.log(
      `[Strategy] Position opened | fixture=${decision.fixtureId} sel=${decision.selectionName}` +
        ` odds=${decision.oddsSnapshot.toFixed(4)} stake=${decision.stakeLamports} score=${decision.signalScore}` +
        ` pda=${pdaAddress}`
    );
  }

  /**
   * Mark an execution as failed (clears pending so it can be retried).
   */
  markFailed(key: string): void {
    this.pending.delete(key);
    console.warn(`[Strategy] Execution failed for key=${key} — cleared from pending`);
  }

  /**
   * Update an open position with its settlement outcome.
   */
  recordSettlement(
    fixtureId: string,
    selectionName: string,
    outcome: "won" | "lost" | "voided"
  ): void {
    const key = `${fixtureId}|${selectionName}`;
    const pos = this.positions.get(key);
    if (!pos) {
      console.warn(`[Strategy] recordSettlement: unknown key ${key}`);
      return;
    }
    pos.status = outcome;
    console.log(`[Strategy] Position settled | ${key} → ${outcome}`);
  }

  /** Return all tracked positions (snapshot). */
  getPositions(): PositionRecord[] {
    return Array.from(this.positions.values());
  }

  /** Return all currently open positions. */
  getOpenPositions(): PositionRecord[] {
    return this.getPositions().filter((p) => p.status === "open");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Linear stake sizing:
   *   score = 60  →  minStakeLamports
   *   score = 100 →  maxStakeLamports
   */
  private _sizeStake(score: number): number {
    const { minScore, minStakeLamports, maxStakeLamports } = this.cfg;
    const norm = Math.min(1, Math.max(0, (score - minScore) / (100 - minScore)));
    const stake = minStakeLamports + norm * (maxStakeLamports - minStakeLamports);
    return Math.floor(stake);
  }

  /**
   * Truncate a UTF-8 selection string to MAX_SELECTION_BYTES bytes.
   * Safely splits on character boundary (ASCII selections are always safe).
   */
  private _truncateSelection(sel: string): string {
    if (Buffer.byteLength(sel, "utf8") <= MAX_SELECTION_BYTES) return sel;
    let truncated = sel;
    while (Buffer.byteLength(truncated, "utf8") > MAX_SELECTION_BYTES) {
      truncated = truncated.slice(0, -1);
    }
    return truncated;
  }
}
