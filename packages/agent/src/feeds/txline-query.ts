/**
 * feeds/txline-query.ts
 *
 * TxLINE HTTP Query Client.
 *
 * Endpoints (mainnet: https://txline.txodds.com, devnet: https://txline-dev.txodds.com):
 *
 *   GET /api/fixtures/snapshot                          → all/filtered fixtures
 *   GET /api/odds/snapshot/<fixtureId>                  → odds snapshot
 *   GET /api/odds/updates/<epochDay>/<hour>/<interval>  → time-period odds
 *   GET /api/scores/snapshot/<fixtureId>                → scores snapshot
 *   GET /api/scores/updates/<fixtureId>                 → live scores updates
 *   GET /api/scores/updates/<epochDay>/<hour>/<interval>→ time-period scores
 *   GET /api/scores/historical/<fixtureId>              → full replay (2w–6h ago)
 *
 * Auth headers on every request:
 *   Authorization: Bearer <guest_jwt>
 *   X-Api-Token:   <activated_api_token>
 *
 * Notes from docs:
 *  - Participant1IsHome is the feed home/away tag, NOT a venue guarantee.
 *  - Fixture GameState: 1 = scheduled, 6 = cancelled.
 *  - Historical scores: start times between 2 weeks and 6 hours in the past.
 *  - Always use the observed `seq` from historical records for validation
 *    proofs — never substitute 0 or a synthetic value.
 */

import axios, { AxiosError } from "axios";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture types
// ─────────────────────────────────────────────────────────────────────────────

export interface TxLineFixture {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  /** Feed home/away tag — not a venue guarantee for neutral tournaments */
  Participant1IsHome: boolean;
  StartTime: string;
  /** 1 = scheduled, 6 = cancelled */
  GameState?: number;
  CompetitionId?: number;
  CompetitionName?: string;
  SportId?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Odds types
// ─────────────────────────────────────────────────────────────────────────────

export interface TxLineOddsSnapshot {
  fixtureId?: number | string;
  FixtureId?: number | string;
  messageId?: string;
  ts?: number;
  bookmaker?: string;
  bookmakerId?: number;
  superOddsType?: string;
  gameState?: string | null;
  inRunning?: boolean;
  marketParameters?: string | null;
  marketPeriod?: string | null;
  priceNames?: string[];
  prices?: number[];
  [key: string]: unknown;
}

export interface TxLineOddsUpdate {
  fixtureId?: number | string;
  FixtureId?: number | string;
  ts?: number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scores types
// ─────────────────────────────────────────────────────────────────────────────

export interface TxLineScoreSnapshot {
  fixtureId?: number | string;
  action?: string;
  seq?: number;
  ts?: number;
  gameState?: string | null;
  gamePhase?: number;
  statusId?: number;
  period?: number;
  minute?: number;
  stats?: Record<string, number>;
  score1?: number;
  score2?: number;
  [key: string]: unknown;
}

export interface TxLineHistoricalScore {
  fixtureId?: number | string;
  action?: string;
  /** Use the observed seq when requesting stat-validation proofs. Never replace with 0. */
  seq: number;
  ts?: number;
  gameState?: string | null;
  gamePhase?: number;
  statusId?: number;
  period?: number;
  minute?: number;
  stats?: Record<string, number>;
  score1?: number;
  score2?: number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface TxLineQueryConfig {
  /** API origin e.g. https://txline.txodds.com */
  apiOrigin: string;
  /** Called on every request so credential refreshes take effect immediately */
  getCredentials: () => { jwt: string; apiToken: string };
  /** Request timeout in ms (default 30 000) */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// TxLineQueryClient
// ─────────────────────────────────────────────────────────────────────────────

export class TxLineQueryClient {
  private readonly cfg: Required<TxLineQueryConfig>;

  constructor(config: TxLineQueryConfig) {
    this.cfg = { timeoutMs: 30_000, ...config };
  }

  // ── Fixtures ───────────────────────────────────────────────────────────────

  /**
   * GET /api/fixtures/snapshot
   * Returns all fixtures covered by the subscription, optionally filtered by
   * competitionId. GameState: 1=scheduled, 6=cancelled.
   */
  async getFixtures(competitionId?: number): Promise<TxLineFixture[]> {
    const params: Record<string, unknown> = {};
    if (competitionId != null) params.competitionId = competitionId;
    const data = await this._get<TxLineFixture[]>("/api/fixtures/snapshot", params);
    return Array.isArray(data) ? data : [];
  }

  // ── Odds ──────────────────────────────────────────────────────────────────

  /**
   * GET /api/odds/snapshot/<fixtureId>
   * Current odds snapshot for a specific fixture.
   */
  async getOddsSnapshot(fixtureId: string | number): Promise<TxLineOddsSnapshot[]> {
    const data = await this._get<TxLineOddsSnapshot[]>(`/api/odds/snapshot/${fixtureId}`);
    return Array.isArray(data) ? data : [];
  }

  /**
   * GET /api/odds/updates/<epochDay>/<hourOfDay>/<interval>
   * Odds updates for a specific hour bucket.
   * Use TxLineQueryClient.currentTimeSlot() to get epochDay and hourOfDay.
   */
  async getOddsUpdates(epochDay: number, hourOfDay: number, interval = 0): Promise<TxLineOddsUpdate[]> {
    const data = await this._get<TxLineOddsUpdate[]>(
      `/api/odds/updates/${epochDay}/${hourOfDay}/${interval}`
    );
    return Array.isArray(data) ? data : [];
  }

  // ── Scores ────────────────────────────────────────────────────────────────

  /**
   * GET /api/scores/snapshot/<fixtureId>
   * Current scores snapshot for a specific fixture.
   */
  async getScoresSnapshot(fixtureId: string | number): Promise<TxLineScoreSnapshot[]> {
    const data = await this._get<TxLineScoreSnapshot[]>(`/api/scores/snapshot/${fixtureId}`);
    return Array.isArray(data) ? data : [];
  }

  /**
   * GET /api/scores/updates/<fixtureId>
   * Live scores updates for a specific fixture.
   */
  async getLiveScores(fixtureId: string | number): Promise<TxLineScoreSnapshot[]> {
    const data = await this._get<TxLineScoreSnapshot[]>(`/api/scores/updates/${fixtureId}`);
    return Array.isArray(data) ? data : [];
  }

  /**
   * GET /api/scores/updates/<epochDay>/<hourOfDay>/<interval>
   * Scores updates for a specific hour bucket.
   */
  async getScoreUpdates(epochDay: number, hourOfDay: number, interval = 0): Promise<TxLineScoreSnapshot[]> {
    const data = await this._get<TxLineScoreSnapshot[]>(
      `/api/scores/updates/${epochDay}/${hourOfDay}/${interval}`
    );
    return Array.isArray(data) ? data : [];
  }

  /**
   * GET /api/scores/historical/<fixtureId>
   *
   * Full replay of score updates for a fixture whose start time was between
   * 2 weeks and 6 hours in the past from now. Throws outside that window.
   *
   * CRITICAL: Use the observed `seq` field when requesting stat-validation
   * proofs. Never replace it with 0 or a synthetic sequence number.
   */
  async getHistoricalScores(fixtureId: string | number): Promise<TxLineHistoricalScore[]> {
    const data = await this._get<TxLineHistoricalScore[]>(
      `/api/scores/historical/${fixtureId}`
    );
    return Array.isArray(data) ? data : [];
  }

  // ── Static helpers ────────────────────────────────────────────────────────

  /**
   * Returns the epochDay and hourOfDay values for the current UTC moment.
   * Use these with getOddsUpdates / getScoreUpdates.
   *
   * @example
   *   const { epochDay, hourOfDay } = TxLineQueryClient.currentTimeSlot();
   */
  static currentTimeSlot(): { epochDay: number; hourOfDay: number } {
    const now = Date.now();
    return {
      epochDay:  Math.floor(now / 86_400_000),
      hourOfDay: new Date(now).getUTCHours(),
    };
  }

  /**
   * Map a raw fixture to a display-friendly { home, away } pair.
   * Respects Participant1IsHome correctly.
   */
  static participantNames(f: TxLineFixture): { home: string; away: string } {
    return f.Participant1IsHome
      ? { home: f.Participant1, away: f.Participant2 }
      : { home: f.Participant2, away: f.Participant1 };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  private async _get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const { jwt, apiToken } = this.cfg.getCredentials();

    const client = axios.create({
      baseURL: this.cfg.apiOrigin,
      timeout: this.cfg.timeoutMs,
      headers: {
        "Content-Type":    "application/json",
        "Authorization":   `Bearer ${jwt}`,
        "X-Api-Token":     apiToken,
        "Accept-Encoding": "gzip",
      },
    });

    try {
      const response = await client.get<T>(path, { params });
      return response.data;
    } catch (err: unknown) {
      if (err instanceof AxiosError) {
        const status = err.response?.status;
        const body   = JSON.stringify(err.response?.data ?? "").slice(0, 300);
        throw new Error(`[TxLINE Query] HTTP ${status ?? "?"} on ${path}: ${body}`);
      }
      throw err;
    }
  }
}
