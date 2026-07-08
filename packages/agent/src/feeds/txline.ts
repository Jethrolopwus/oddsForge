/**
 * feeds/txline.ts
 *
 * TxLINE SSE (Server-Sent Events) Connector.
 *
 * Streams live odds from the TxLINE odds stream endpoint:
 *   GET /api/odds/stream
 *
 * Authentication headers (both required on every request):
 *   Authorization: Bearer <guest_jwt>
 *   X-Api-Token:   <activated_api_token>
 *
 * The real TxLINE Odds schema (from the published IDL):
 * ─────────────────────────────────────────────────────
 *   fixture_id       i64       — TxLINE canonical fixture identifier
 *   message_id       string    — dedup key for this update
 *   ts               i64       — unix seconds timestamp
 *   bookmaker        string    — e.g. "Pinnacle"
 *   bookmaker_id     i32
 *   super_odds_type  string    — market type e.g. "1X2", "ou", "ah"
 *   game_state       string?   — e.g. "1H", "2H", "FT" (null pre-match)
 *   in_running       bool      — true while match is live
 *   market_parameters string?  — e.g. "2.5" for over/under line
 *   market_period    string?   — e.g. "FT", "1H"
 *   price_names      string[]  — e.g. ["home", "draw", "away"]
 *   prices           i32[]     — millionths of decimal odds
 *                               e.g. [2150000, 3200000, 3800000]
 *                               → 2.150, 3.200, 3.800
 *
 * Prices are integer millionths (divide by 1_000_000 to get decimal).
 * price_names and prices are parallel arrays with the same length.
 *
 * Features:
 *  - Auto-reconnect with exponential backoff (native fetch SSE)
 *  - Dedup by message_id — skips already-seen updates
 *  - EventEmitter interface matching the rest of the codebase
 */

import { EventEmitter } from "events";
import { gunzipSync } from "zlib";

// ─────────────────────────────────────────────────────────────────────────────
// Types — matching the real TxLINE IDL Odds struct exactly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw Odds message from the TxLINE SSE stream.
 * Field names are camelCase as returned by the API.
 */
export interface TxLineOdds {
  /** TxLINE canonical fixture ID (i64 — use string to avoid JS precision loss) */
  fixtureId: string;
  /** Dedup key for this specific update */
  messageId: string;
  /** Unix seconds timestamp */
  ts: number;
  /** Bookmaker name e.g. "Pinnacle" */
  bookmaker: string;
  /** Numeric bookmaker ID */
  bookmakerId: number;
  /** Market type e.g. "1X2", "ou", "ah" */
  superOddsType: string;
  /** Match state e.g. "1H", "2H", "FT" — null if pre-match */
  gameState: string | null;
  /** True while the match is live (in-play) */
  inRunning: boolean;
  /** Market line parameter e.g. "2.5" for over/under */
  marketParameters: string | null;
  /** Market period e.g. "FT", "1H" */
  marketPeriod: string | null;
  /** Selection labels — parallel array with prices */
  priceNames: string[];
  /** Prices in integer millionths (divide by 1_000_000 for decimal odds) */
  prices: number[];
}

/** A normalised, decimal-converted selection ready for the signal engine. */
export interface TxLineSelection {
  /** Selection label e.g. "home", "draw", "away" */
  name: string;
  /** Decimal odds e.g. 2.15 */
  decimalOdds: number;
}

/** Normalised odds event emitted by TxLineConnector. */
export interface OddsEvent {
  /** String representation of the i64 fixtureId */
  fixtureId: string;
  messageId: string;
  /** Unix milliseconds (ts * 1000) */
  timestamp: number;
  bookmaker: string;
  bookmakerId: number;
  /** Market type e.g. "1X2" */
  marketType: string;
  gameState: string | null;
  inRunning: boolean;
  marketParameters: string | null;
  marketPeriod: string | null;
  /** Normalised selections with decimal odds */
  selections: TxLineSelection[];
  /** Raw parsed Odds object */
  raw: TxLineOdds;
}

export interface TxLineConnectorEvents {
  odds: (event: OddsEvent) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (err: Error) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PRICE_DIVISOR = 1_000_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// TxLineConnector
// ─────────────────────────────────────────────────────────────────────────────

export class TxLineConnector extends EventEmitter {
  private stopped = false;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;

  /** Set of seen message_ids for dedup (cleared after 10 000 entries) */
  private seenIds: Set<string> = new Set();

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

  on<K extends keyof TxLineConnectorEvents>(
    event: K,
    listener: TxLineConnectorEvents[K]
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof TxLineConnectorEvents>(
    event: K,
    ...args: Parameters<TxLineConnectorEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — SSE streaming
  // ─────────────────────────────────────────────────────────────────────────

  private async _stream(): Promise<void> {
    if (this.stopped) return;

    const { jwt, apiToken } = this.getCredentials();
    const url = `${this.apiOrigin}/api/odds/stream`;

    this.abortController = new AbortController();

    try {
      const response = await fetch(url, {
        signal: this.abortController.signal,
        headers: {
          Authorization: `Bearer ${jwt}`,
          "X-Api-Token": apiToken,
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          // Request gzip to cut bandwidth by 70-80% (docs recommendation)
          "Accept-Encoding": "gzip",
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `TxLINE stream HTTP ${response.status}: ${body.slice(0, 200)}`
        );
      }

      if (!response.body) {
        throw new Error("TxLINE stream response has no body");
      }

      console.log("[TxLINE] SSE stream connected");
      this.reconnectDelay = INITIAL_RECONNECT_MS;
      this.emit("connected");

      // Parse SSE using Node.js ReadableStream reader
      for await (const msg of this._readSse(response)) {
        if (msg.data) {
          this._handleMessage(msg.data);
        }
      }

      // Stream ended cleanly
      if (!this.stopped) {
        this.emit("disconnected", "stream ended");
        this._scheduleReconnect();
      }
    } catch (err: unknown) {
      if (this.stopped) return;
      const message = err instanceof Error ? err.message : String(err);
      // AbortError is expected on stop() — don't treat as failure
      if (message.includes("abort") || message.includes("Abort")) return;
      this.emit("error", new Error(`[TxLINE] Stream error: ${message}`));
      this.emit("disconnected", message);
      this._scheduleReconnect();
    }
  }

  /**
   * Parse a native fetch Response body as SSE messages.
   * Handles gzip-encoded chunks (Node 18+ decompresses automatically via fetch,
   * but we also handle the manual case).
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

        // Attempt gzip decompression (Node fetch may not auto-decompress)
        let chunk: string;
        try {
          const decompressed = gunzipSync(value);
          chunk = decoder.decode(decompressed, { stream: true });
        } catch {
          // Not gzip or already decompressed by fetch
          chunk = decoder.decode(value, { stream: true });
        }

        buffer += chunk;

        // Split on double-newline (SSE message boundary)
        let boundaryIndex: number;
        while ((boundaryIndex = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const block = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex).replace(/^\r?\n\r?\n/, "");

          const msg = this._parseSseBlock(block);
          if (msg) yield msg;
        }
      }

      // Flush remaining buffer
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
      const val = sep === -1 ? "" : rawLine.slice(sep + 1).replace(/^ /, "");

      if (field === "data") data += val + "\n";
      else if (field === "event") event = val;
      else if (field === "id") id = val;
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
      // Non-JSON heartbeat or comment — ignore
      return;
    }

    if (!parsed || typeof parsed !== "object") return;
    const raw = parsed as Record<string, unknown>;

    // Normalise field names — TxLINE returns camelCase from the API
    const odds: TxLineOdds = {
      fixtureId: String(raw.fixtureId ?? raw.fixture_id ?? ""),
      messageId: String(raw.messageId ?? raw.message_id ?? ""),
      ts: Number(raw.ts ?? 0),
      bookmaker: String(raw.bookmaker ?? ""),
      bookmakerId: Number(raw.bookmakerId ?? raw.bookmaker_id ?? 0),
      superOddsType: String(raw.superOddsType ?? raw.super_odds_type ?? ""),
      gameState: raw.gameState != null ? String(raw.gameState) :
                 raw.game_state != null ? String(raw.game_state) : null,
      inRunning: Boolean(raw.inRunning ?? raw.in_running ?? false),
      marketParameters: raw.marketParameters != null ? String(raw.marketParameters) :
                        raw.market_parameters != null ? String(raw.market_parameters) : null,
      marketPeriod: raw.marketPeriod != null ? String(raw.marketPeriod) :
                    raw.market_period != null ? String(raw.market_period) : null,
      priceNames: Array.isArray(raw.priceNames) ? raw.priceNames.map(String) :
                  Array.isArray(raw.price_names) ? raw.price_names.map(String) : [],
      prices: Array.isArray(raw.prices) ? raw.prices.map(Number) : [],
    };

    if (!odds.fixtureId || !odds.messageId) return;

    // Dedup by messageId
    if (this.seenIds.has(odds.messageId)) return;
    this.seenIds.add(odds.messageId);
    if (this.seenIds.size > 10_000) {
      // Keep memory bounded — purge the oldest half
      const entries = Array.from(this.seenIds);
      this.seenIds = new Set(entries.slice(entries.length / 2));
    }

    // Validate parallel arrays
    if (odds.priceNames.length !== odds.prices.length) {
      this.emit(
        "error",
        new Error(
          `[TxLINE] price_names/prices length mismatch on fixture ${odds.fixtureId}`
        )
      );
      return;
    }

    // Convert i32 millionths → decimal odds, skipping inactive prices (0)
    const selections: TxLineSelection[] = odds.priceNames
      .map((name, i) => ({
        name,
        decimalOdds: odds.prices[i] / PRICE_DIVISOR,
      }))
      .filter((s) => s.decimalOdds > 1.0);

    if (selections.length === 0) return;

    const event: OddsEvent = {
      fixtureId: odds.fixtureId,
      messageId: odds.messageId,
      timestamp: odds.ts * 1000, // convert seconds → milliseconds
      bookmaker: odds.bookmaker,
      bookmakerId: odds.bookmakerId,
      marketType: odds.superOddsType,
      gameState: odds.gameState,
      inRunning: odds.inRunning,
      marketParameters: odds.marketParameters,
      marketPeriod: odds.marketPeriod,
      selections,
      raw: odds,
    };

    this.emit("odds", event);
  }

  private _scheduleReconnect(): void {
    if (this.stopped) return;

    const delay = this.reconnectDelay;
    console.log(`[TxLINE] Reconnecting in ${delay}ms …`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._stream();
    }, delay);

    this.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_MS);
  }
}
