/**
 * feeds/txline-scores.ts
 *
 * TxLINE Scores SSE Stream Connector.
 *
 * Streams live soccer score events from the TxLINE scores stream endpoint:
 *   GET /api/scores/stream
 *
 * Authentication headers (both required on every request):
 *   Authorization: Bearer <guest_jwt>
 *   X-Api-Token:   <activated_api_token>
 *
 * ─── Soccer Game Phase IDs (from TxLINE Soccer Feed docs) ───────────────────
 *   1  NS     Not started
 *   2  H1     First half in play
 *   3  HT     Halftime
 *   4  H2     Second half in play
 *   5  F      Ended (finished)
 *   6  WET    Waiting for Extra Time
 *   7  ET1    Extra Time first half in play
 *   8  HTET   Extra Time halftime
 *   9  ET2    Extra Time second half in play
 *   10 FET    Ended after Extra Time
 *   11 WPE    Waiting for Penalty Shootout
 *   12 PE     Penalty Shootout in progress
 *   13 FPE    Ended after Penalty Shootout
 *   14 I      Interrupted
 *   15 A      Abandoned
 *   16 C      Cancelled
 *   17 TXCC   TX Coverage Cancelled
 *   18 TXCS   TX Coverage Suspended
 *   19 P      Postponed
 *
 * ─── Stat Period Encoding (stat key = period_prefix + base_key) ─────────────
 *   Base keys 1-8:
 *     1 Participant 1 Total Goals
 *     2 Participant 2 Total Goals
 *     3 Participant 1 Total Yellow Cards
 *     4 Participant 2 Total Yellow Cards
 *     5 Participant 1 Total Red Cards
 *     6 Participant 2 Total Red Cards
 *     7 Participant 1 Total Corners
 *     8 Participant 2 Total Corners
 *   Period prefixes:
 *     0     Total  (key 8 → Participant 2 total corners)
 *     1000  H1     (key 1001 → Participant 1 H1 goals)
 *     2000  HT     (key 2001 → Participant 1 halftime goals)
 *     3000  H2     (key 3001 → Participant 1 H2 goals)
 *     4000  ET1    (key 4001 → Participant 1 ET1 goals)
 *     5000  ET2    (key 5001 → Participant 1 ET2 goals)
 *     6000  PE     (key 6001 → Participant 1 penalty shootout goals)
 *     7000  ETTotal(key 7008 → Participant 2 ETTotal corners)
 *
 * ─── Integrator Notes ────────────────────────────────────────────────────────
 *   - Hydration breaks: action=comment, Data.Text="Water-drinking break"
 *   - Fouls: use action=free_kick with Data.FreeKickType != "Offside"
 *   - game_finalised: statusId=100, period=100 — the definitive match-end marker
 *     regardless of whether the match ended in regulation, ET, penalties, or
 *     abandonment. Use this to trigger settle_position.
 *
 * ─── Action types ─────────────────────────────────────────────────────────────
 *   shot          Data.Outcome: OnTarget | OffTarget | Woodwork | Blocked
 *   free_kick     Data.FreeKickType: Safe | Attack | Danger | HighDanger | Offside
 *   var           Data.Type: Goal | Penalty | RedCard | SecondYellowCard |
 *                            CornerKick | MistakenIdentity | Other
 *   var_end       Data.Outcome: Stands | Overturned
 *   penalty       outcome: Scored | Missed | Retake
 *   goal
 *   yellow_card
 *   red_card
 *   corner
 *   substitution  may include FollowsAction (links to originating unconfirmed action)
 *   action_amend  may include Participant (team related to original action)
 *   halftime_finalised  may be sent more than once for the same halftime period
 *   game_finalised      statusId=100, period=100
 *   comment
 */

import { EventEmitter } from "events";
import { gunzipSync } from "zlib";

// ─────────────────────────────────────────────────────────────────────────────
// Game Phase Encoding
// ─────────────────────────────────────────────────────────────────────────────

export enum GamePhaseId {
  NS   = 1,   // Not started
  H1   = 2,   // First half in play
  HT   = 3,   // Halftime
  H2   = 4,   // Second half in play
  F    = 5,   // Ended (finished)
  WET  = 6,   // Waiting for Extra Time
  ET1  = 7,   // Extra Time first half in play
  HTET = 8,   // Extra Time halftime
  ET2  = 9,   // Extra Time second half in play
  FET  = 10,  // Ended after Extra Time
  WPE  = 11,  // Waiting for Penalty Shootout
  PE   = 12,  // Penalty Shootout in progress
  FPE  = 13,  // Ended after Penalty Shootout
  I    = 14,  // Interrupted
  A    = 15,  // Abandoned
  C    = 16,  // Cancelled
  TXCC = 17,  // TX Coverage Cancelled
  TXCS = 18,  // TX Coverage Suspended
  P    = 19,  // Postponed
}

export type GamePhaseName =
  | "NS" | "H1" | "HT" | "H2" | "F"
  | "WET" | "ET1" | "HTET" | "ET2" | "FET"
  | "WPE" | "PE" | "FPE"
  | "I" | "A" | "C" | "TXCC" | "TXCS" | "P";

/** Map GamePhaseId → human-readable name */
export const GAME_PHASE_NAMES: Record<GamePhaseId, GamePhaseName> = {
  [GamePhaseId.NS]:   "NS",
  [GamePhaseId.H1]:   "H1",
  [GamePhaseId.HT]:   "HT",
  [GamePhaseId.H2]:   "H2",
  [GamePhaseId.F]:    "F",
  [GamePhaseId.WET]:  "WET",
  [GamePhaseId.ET1]:  "ET1",
  [GamePhaseId.HTET]: "HTET",
  [GamePhaseId.ET2]:  "ET2",
  [GamePhaseId.FET]:  "FET",
  [GamePhaseId.WPE]:  "WPE",
  [GamePhaseId.PE]:   "PE",
  [GamePhaseId.FPE]:  "FPE",
  [GamePhaseId.I]:    "I",
  [GamePhaseId.A]:    "A",
  [GamePhaseId.C]:    "C",
  [GamePhaseId.TXCC]: "TXCC",
  [GamePhaseId.TXCS]: "TXCS",
  [GamePhaseId.P]:    "P",
};

/** True when a statusId indicates the match has concluded (all results finalised). */
export function isMatchFinalised(statusId: number): boolean {
  return statusId === 100;
}

/** True when the game phase represents a terminal (finished) state. */
export function isTerminalPhase(phaseId: number): boolean {
  return [
    GamePhaseId.F,
    GamePhaseId.FET,
    GamePhaseId.FPE,
    GamePhaseId.A,
    GamePhaseId.C,
    GamePhaseId.TXCC,
    GamePhaseId.P,
  ].includes(phaseId as GamePhaseId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat Period helpers
// ─────────────────────────────────────────────────────────────────────────────

export const STAT_PERIOD_PREFIX = {
  TOTAL:    0,
  H1:    1000,
  HT:    2000,
  H2:    3000,
  ET1:   4000,
  ET2:   5000,
  PE:    6000,
  ET_TOTAL: 7000,
} as const;

export const STAT_BASE_KEY = {
  P1_GOALS:   1,
  P2_GOALS:   2,
  P1_YELLOWS: 3,
  P2_YELLOWS: 4,
  P1_REDS:    5,
  P2_REDS:    6,
  P1_CORNERS: 7,
  P2_CORNERS: 8,
} as const;

/** Build a compound stat key from period prefix + base key. */
export function buildStatKey(
  prefix: number,
  baseKey: number
): number {
  return prefix + baseKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — Score event payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw score message from the TxLINE scores SSE stream.
 *
 * The stream delivers JSON-encoded action objects.  Field names vary by action
 * type — the intersection of all documented action types is captured here.
 * All fields are optional except action and fixtureId.
 */
export interface TxLineScoreMessage {
  /** Action type label e.g. "goal", "yellow_card", "game_finalised" */
  action: string;
  /** TxLINE canonical fixture ID (i64 — treat as string) */
  fixtureId: string | number;
  /** Sequence number — use the observed value when requesting validation proofs */
  seq?: number;
  /** Unix seconds timestamp */
  ts?: number;
  /** Game phase ID (see GamePhaseId enum) */
  gamePhase?: number;
  /** Alternate field name for game phase */
  gamePhaseId?: number;
  /**
   * Status ID — 100 = game_finalised.
   * All scores records with action=game_finalised use statusId=100 and period=100.
   */
  statusId?: number;
  /** Period — 100 on game_finalised records */
  period?: number;
  /** Current match state e.g. "1H", "2H", "FT" */
  gameState?: string | null;
  /** Match minute */
  minute?: number;
  /** Match minute additional seconds */
  minuteExtra?: number;
  /** Stat updates: map of stat key → value */
  stats?: Record<string, number>;
  /** Action-specific detail data */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: Record<string, any>;
  /** Score for participant 1 */
  score1?: number;
  /** Score for participant 2 */
  score2?: number;
  /** Participant index (1 or 2) related to this action */
  participant?: number;
  /** Ref to originating unconfirmed action (substitution with FollowsAction v1.1) */
  followsAction?: string | number;
  /** Source fixture identifier from upstream provider */
  sourceFixtureId?: string;
}

/** A fully normalised score event emitted by TxLineScoresConnector. */
export interface ScoreEvent {
  /** String representation of the i64 fixtureId */
  fixtureId: string;
  /** Action type label */
  action: string;
  /** Observed sequence number — required for stat-validation proofs */
  seq: number;
  /** Unix milliseconds */
  timestamp: number;
  /** Current game phase ID (see GamePhaseId) */
  gamePhaseId: number | null;
  /** Human-readable phase name */
  gamePhase: string | null;
  /** Status ID — 100 means game_finalised */
  statusId: number | null;
  /** True when statusId === 100 (game_finalised — definitive match-end marker) */
  isGameFinalised: boolean;
  /** True when the phase is a terminal game phase */
  isTerminalPhase: boolean;
  /** Current match state string e.g. "1H" */
  gameState: string | null;
  /** Match minute */
  minute: number | null;
  /** Stat values for this event (key → value) */
  stats: Record<string, number>;
  /** Home/participant-1 score */
  score1: number | null;
  /** Away/participant-2 score */
  score2: number | null;
  /** Full raw message */
  raw: TxLineScoreMessage;
}

export interface TxLineScoresConnectorEvents {
  score: (event: ScoreEvent) => void;
  /** Emitted specifically when a game_finalised event (statusId=100) arrives */
  game_finalised: (event: ScoreEvent) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (err: Error) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS     = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// TxLineScoresConnector
// ─────────────────────────────────────────────────────────────────────────────

export class TxLineScoresConnector extends EventEmitter {
  private stopped        = false;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;

  constructor(
    private readonly apiOrigin: string,
    private getCredentials: () => { jwt: string; apiToken: string }
  ) {
    super();
  }

  // ── public API ─────────────────────────────────────────────────────────────

  connect(): void {
    this.stopped = false;
    this._stream();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
  }

  // ── typed overloads ────────────────────────────────────────────────────────

  on<K extends keyof TxLineScoresConnectorEvents>(
    event: K,
    listener: TxLineScoresConnectorEvents[K]
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof TxLineScoresConnectorEvents>(
    event: K,
    ...args: Parameters<TxLineScoresConnectorEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — SSE streaming
  // ─────────────────────────────────────────────────────────────────────────

  private async _stream(): Promise<void> {
    if (this.stopped) return;

    const { jwt, apiToken } = this.getCredentials();
    const url = `${this.apiOrigin}/api/scores/stream`;

    this.abortController = new AbortController();

    try {
      const response = await fetch(url, {
        signal: this.abortController.signal,
        headers: {
          Authorization: `Bearer ${jwt}`,
          "X-Api-Token": apiToken,
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          // Reduce bandwidth by 70-80% (docs recommendation)
          "Accept-Encoding": "gzip",
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `TxLINE scores stream HTTP ${response.status}: ${body.slice(0, 200)}`
        );
      }

      if (!response.body) {
        throw new Error("TxLINE scores stream response has no body");
      }

      console.log("[TxLINE Scores] SSE stream connected");
      this.reconnectDelay = INITIAL_RECONNECT_MS;
      this.emit("connected");

      for await (const msg of this._readSse(response)) {
        if (msg.data) {
          this._handleMessage(msg.data);
        }
      }

      if (!this.stopped) {
        this.emit("disconnected", "stream ended");
        this._scheduleReconnect();
      }
    } catch (err: unknown) {
      if (this.stopped) return;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("abort") || message.includes("Abort")) return;
      this.emit("error", new Error(`[TxLINE Scores] Stream error: ${message}`));
      this.emit("disconnected", message);
      this._scheduleReconnect();
    }
  }

  /**
   * Parse a native fetch Response body as SSE messages.
   * Handles gzip-encoded chunks.
   */
  private async *_readSse(
    response: Response
  ): AsyncGenerator<{ event?: string; data: string; id?: string }> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        let chunk: string;
        try {
          const decompressed = gunzipSync(value);
          chunk = decoder.decode(decompressed, { stream: true });
        } catch {
          chunk = decoder.decode(value, { stream: true });
        }

        buffer += chunk;

        let boundaryIndex: number;
        while ((boundaryIndex = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const block = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex).replace(/^\r?\n\r?\n/, "");

          const msg = this._parseSseBlock(block);
          if (msg) yield msg;
        }
      }

      if (buffer.trim()) {
        const msg = this._parseSseBlock(buffer);
        if (msg) yield msg;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private _parseSseBlock(
    block: string
  ): { event?: string; data: string; id?: string } | null {
    let data = "";
    let event: string | undefined;
    let id: string | undefined;

    for (const rawLine of block.split(/\r?\n/)) {
      if (!rawLine || rawLine.startsWith(":")) continue;

      const sep = rawLine.indexOf(":");
      const field = sep === -1 ? rawLine : rawLine.slice(0, sep);
      const val   = sep === -1 ? "" : rawLine.slice(sep + 1).replace(/^ /, "");

      if (field === "data")  data  += val + "\n";
      else if (field === "event") event = val;
      else if (field === "id")    id    = val;
    }

    data = data.replace(/\n$/, "");
    return data || event || id ? { event, data, id } : null;
  }

  private _handleMessage(data: string): void {
    if (!data) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Non-JSON heartbeat / comment — ignore
      return;
    }

    if (!parsed || typeof parsed !== "object") return;
    const raw = parsed as TxLineScoreMessage;

    // Normalise fixtureId — may be number or string from the feed
    const fixtureId = String(raw.fixtureId ?? "");
    if (!fixtureId) return;

    const action = String(raw.action ?? "");
    if (!action) return;

    // Prefer gamePhaseId; fall back to gamePhase if it's numeric
    const gamePhaseId: number | null =
      raw.gamePhaseId != null ? Number(raw.gamePhaseId) :
      raw.gamePhase   != null && !isNaN(Number(raw.gamePhase)) ? Number(raw.gamePhase) :
      null;

    const phaseName = gamePhaseId != null
      ? (GAME_PHASE_NAMES[gamePhaseId as GamePhaseId] ?? String(gamePhaseId))
      : null;

    const statusId = raw.statusId != null ? Number(raw.statusId) : null;
    const gameFinalised = statusId === 100;
    const terminalPhase = gamePhaseId != null ? isTerminalPhase(gamePhaseId) : false;

    const event: ScoreEvent = {
      fixtureId,
      action,
      seq:             raw.seq     != null ? Number(raw.seq)  : 0,
      timestamp:       raw.ts      != null ? Number(raw.ts) * 1000 : Date.now(),
      gamePhaseId,
      gamePhase:       phaseName,
      statusId,
      isGameFinalised: gameFinalised,
      isTerminalPhase: terminalPhase,
      gameState:       raw.gameState != null ? String(raw.gameState) : null,
      minute:          raw.minute   != null ? Number(raw.minute) : null,
      stats:           raw.stats    != null && typeof raw.stats === "object"
                         ? (raw.stats as Record<string, number>)
                         : {},
      score1:          raw.score1   != null ? Number(raw.score1) : null,
      score2:          raw.score2   != null ? Number(raw.score2) : null,
      raw,
    };

    this.emit("score", event);

    // Emit the dedicated game_finalised event — this is the trigger for
    // settle_position. Docs: statusId=100, period=100 is the definitive
    // match-end marker regardless of regulation, ET, penalties, or abandonment.
    if (gameFinalised) {
      this.emit("game_finalised", event);
    }
  }

  private _scheduleReconnect(): void {
    if (this.stopped) return;

    const delay = this.reconnectDelay;
    console.log(`[TxLINE Scores] Reconnecting in ${delay}ms …`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._stream();
    }, delay);

    this.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_MS);
  }
}
