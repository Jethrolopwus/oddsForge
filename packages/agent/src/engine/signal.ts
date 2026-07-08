/**
 * engine/signal.ts
 *
 * Odds Signal Detection Engine.
 *
 * Ingests TxLINE `OddsEvent` objects and detects statistically significant
 * odds movements.  For each (fixtureId, selectionName, bookmaker) triple the
 * engine maintains a rolling 60-second history.  When a ≥5% movement is
 * detected it computes a confidence score 0–100 and emits a `Signal` event.
 *
 * Scoring breakdown (total 100 pts):
 *   Speed       (30 pts) — how quickly did the move happen? (full 30 at ≤10 s)
 *   Magnitude   (40 pts) — % size of the move (5% → 0 pts, ≥25% → 40 pts)
 *   Consistency (30 pts) — fraction of per-tick changes aligned with net direction
 *
 * Signals scoring ≥ MIN_SCORE_TO_EMIT (default 60) are emitted.
 *
 * The key insight in the TxLINE schema:
 *   - `fixtureId` is a string representation of an i64
 *   - Prices are i32 integer millionths already converted to decimal by TxLineConnector
 *   - `selections` is a normalised array of { name, decimalOdds }
 */

import { EventEmitter } from "events";
import type { OddsEvent, TxLineSelection } from "../feeds/txline";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface OddsDataPoint {
  /** Decimal odds value */
  odds: number;
  /** Unix milliseconds when this was observed */
  ts: number;
}

export interface Signal {
  /** Unique key: "fixtureId|selectionName|bookmaker" */
  key: string;
  /** String representation of the TxLINE i64 fixture ID */
  fixtureId: string;
  /** Selection label e.g. "home", "draw", "away" */
  selectionName: string;
  /** Market type e.g. "1X2", "ou", "ah" */
  marketType: string;
  /** Bookmaker slug */
  bookmaker: string;
  /** Current (latest) decimal odds */
  currentOdds: number;
  /** Odds value at the start of the detection window */
  previousOdds: number;
  /** Percentage change: positive = drift up, negative = drift down */
  pctChange: number;
  /** Confidence score 0–100 */
  score: number;
  /** Direction of movement */
  direction: "up" | "down";
  /** Unix milliseconds when signal was detected */
  detectedAt: number;
  /** Match state at time of detection */
  gameState: string | null;
  /** Whether market was in-play */
  inRunning: boolean;
  /** Market period e.g. "FT", "1H" */
  marketPeriod: string | null;
  /** Market line parameter e.g. "2.5" */
  marketParameters: string | null;
}

export interface SignalEngineEvents {
  signal: (s: Signal) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_MS = 60_000;         // Rolling detection window
const MIN_PCT_CHANGE = 0.05;      // ≥5% movement required
const MIN_SCORE_TO_EMIT = 60;     // Score gate before emitting
const MAX_HISTORY_PER_KEY = 200;  // Hard cap per tracked key

// ─────────────────────────────────────────────────────────────────────────────
// SignalEngine
// ─────────────────────────────────────────────────────────────────────────────

export class SignalEngine extends EventEmitter {
  /**
   * Per-key rolling history (oldest first).
   * Key = "fixtureId|selectionName|bookmaker"
   */
  private history: Map<string, OddsDataPoint[]> = new Map();

  /**
   * Ingest a TxLINE OddsEvent.
   * Each selection in the event is processed independently.
   */
  ingest(event: OddsEvent): void {
    const now = Date.now();

    for (const selection of event.selections) {
      if (selection.decimalOdds <= 1.0) continue;

      const key = this._key(event.fixtureId, selection.name, event.bookmaker);
      this._record(key, { odds: selection.decimalOdds, ts: now });
      this._detect(key, event, selection);
    }
  }

  /**
   * Return the current history for a given key (useful for testing).
   */
  getHistory(
    fixtureId: string,
    selectionName: string,
    bookmaker: string
  ): OddsDataPoint[] {
    return this.history.get(this._key(fixtureId, selectionName, bookmaker)) ?? [];
  }

  /**
   * Purge all data-points older than WINDOW_MS.
   * Call this periodically (e.g. every 30 s) to bound memory usage.
   */
  pruneHistory(): void {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, points] of this.history) {
      const trimmed = points.filter((p) => p.ts >= cutoff);
      if (trimmed.length === 0) {
        this.history.delete(key);
      } else {
        this.history.set(key, trimmed);
      }
    }
  }

  // ── typed EventEmitter overloads ───────────────────────────────────────────

  on<K extends keyof SignalEngineEvents>(
    event: K,
    listener: SignalEngineEvents[K]
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof SignalEngineEvents>(
    event: K,
    ...args: Parameters<SignalEngineEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  private _key(
    fixtureId: string,
    selectionName: string,
    bookmaker: string
  ): string {
    return `${fixtureId}|${selectionName}|${bookmaker}`;
  }

  private _record(key: string, point: OddsDataPoint): void {
    const arr = this.history.get(key) ?? [];
    arr.push(point);

    // Trim to rolling window
    const cutoff = Date.now() - WINDOW_MS;
    const startIdx = Math.max(0, arr.findIndex((p) => p.ts >= cutoff));
    let trimmed = arr.slice(startIdx);

    // Hard cap
    if (trimmed.length > MAX_HISTORY_PER_KEY) {
      trimmed = trimmed.slice(trimmed.length - MAX_HISTORY_PER_KEY);
    }

    this.history.set(key, trimmed);
  }

  private _detect(
    key: string,
    event: OddsEvent,
    selection: TxLineSelection
  ): void {
    const points = this.history.get(key);
    if (!points || points.length < 2) return;

    const current = points[points.length - 1];
    const windowStart = current.ts - WINDOW_MS;

    // Oldest point within the window
    const baseline = points.find((p) => p.ts >= windowStart);
    if (!baseline) return;

    const windowPoints = points.filter((p) => p.ts >= windowStart);
    if (windowPoints.length < 2) return;

    const pctChange = (current.odds - baseline.odds) / baseline.odds;
    const absPct = Math.abs(pctChange);

    if (absPct < MIN_PCT_CHANGE) return;

    const score = this._score(windowPoints, current.ts, baseline.ts, absPct);
    if (score < MIN_SCORE_TO_EMIT) return;

    const signal: Signal = {
      key,
      fixtureId: event.fixtureId,
      selectionName: selection.name,
      marketType: event.marketType,
      bookmaker: event.bookmaker,
      currentOdds: current.odds,
      previousOdds: baseline.odds,
      pctChange,
      score,
      direction: pctChange > 0 ? "up" : "down",
      detectedAt: current.ts,
      gameState: event.gameState,
      inRunning: event.inRunning,
      marketPeriod: event.marketPeriod,
      marketParameters: event.marketParameters,
    };

    this.emit("signal", signal);
  }

  /**
   * Compute a 0–100 confidence score for a detected movement.
   *
   * Speed (30 pts):
   *   Full 30 at ≤10 s; decays linearly to 0 at WINDOW_MS.
   *
   * Magnitude (40 pts):
   *   Linear from 5% (0 pts) to ≥25% (40 pts).
   *
   * Consistency (30 pts):
   *   Fraction of directionally aligned inter-tick changes × 30.
   */
  private _score(
    points: OddsDataPoint[],
    latestTs: number,
    baselineTs: number,
    absPct: number
  ): number {
    // Speed
    const elapsed = latestTs - baselineTs;
    const speedScore = Math.max(0, 1 - elapsed / WINDOW_MS) * 30;

    // Magnitude
    const magNorm = Math.max(0, Math.min(absPct, 0.25) - 0.05) / 0.20;
    const magScore = magNorm * 40;

    // Consistency
    const netDir =
      points[points.length - 1].odds >= points[0].odds ? 1 : -1;
    let aligned = 0;
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const diff = points[i].odds - points[i - 1].odds;
      if (diff !== 0) {
        total++;
        if (Math.sign(diff) === netDir) aligned++;
      }
    }
    const consistencyScore = total > 0 ? (aligned / total) * 30 : 0;

    return Math.round(Math.min(100, speedScore + magScore + consistencyScore));
  }
}
