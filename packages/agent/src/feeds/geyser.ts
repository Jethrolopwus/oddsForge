/**
 * feeds/geyser.ts
 *
 * Yellowstone gRPC (Triton One) Geyser Listener.
 *
 * Subscribes to account-update notifications for specific Position PDAs.
 * When an account changes on-chain, the listener decodes the change and emits
 * a typed `AccountUpdate` event so the agent can confirm placement and detect
 * settlement without polling.
 *
 * Usage:
 * ```ts
 * const geyser = new GeyserListener({ endpoint, token });
 * geyser.on("account", (update) => { ... });
 * geyser.watchAccount(pdaAddress);
 * await geyser.connect();
 * ```
 */

import { EventEmitter } from "events";
import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeUpdate,
} from "@triton-one/yellowstone-grpc";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountUpdate {
  /** Base58 account pubkey */
  pubkey: string;
  /** Raw account data bytes (program-specific encoding) */
  data: Buffer;
  /** Lamports in the account */
  lamports: bigint;
  /** Whether the account still exists (false = closed) */
  exists: boolean;
  /** Slot at which this update was confirmed */
  slot: bigint;
  /** Update sequence number from the geyser */
  seq: bigint;
}

export interface GeyserListenerEvents {
  account: (update: AccountUpdate) => void;
  connected: () => void;
  error: (err: Error) => void;
  disconnected: () => void;
}

export interface GeyserListenerConfig {
  /** Triton One / Yellowstone gRPC endpoint (e.g. https://…rpcpool.com) */
  endpoint: string;
  /** Access token */
  token: string;
  /** Commitment level (default: confirmed) */
  commitment?: CommitmentLevel;
}

// ─────────────────────────────────────────────────────────────────────────────
// GeyserListener
// ─────────────────────────────────────────────────────────────────────────────

export class GeyserListener extends EventEmitter {
  private client: Client | null = null;
  private stream: ReturnType<Client["subscribe"]> extends Promise<infer S> ? S : never | null = null as never;
  private readonly watchList: Set<string> = new Set();
  private readonly config: Required<GeyserListenerConfig>;
  private stopped = false;

  constructor(config: GeyserListenerConfig) {
    super();
    this.config = {
      commitment: CommitmentLevel.CONFIRMED,
      ...config,
    };
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Add an account to the watch list.
   * If already connected, the subscription is updated immediately.
   */
  watchAccount(pubkey: string): void {
    this.watchList.add(pubkey);
    if (this.stream) {
      this._sendSubscription().catch((err) => {
        this.emit("error", new Error(`[Geyser] Subscription update error: ${String(err)}`));
      });
    }
  }

  /** Remove an account from the watch list. */
  unwatchAccount(pubkey: string): void {
    this.watchList.delete(pubkey);
  }

  /** Establish the gRPC stream and start listening. */
  async connect(): Promise<void> {
    if (this.stopped) return;

    try {
      this.client = new Client(this.config.endpoint, this.config.token, {
        // gRPC channel options
        "grpc.max_receive_message_length": 128 * 1024 * 1024, // 128 MB
      });

      const stream = await this.client.subscribe();
      // Store the stream — the type is inferred from the promise resolution.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).stream = stream;

      // Handle incoming messages
      stream.on("data", (update: SubscribeUpdate) => {
        this._handleUpdate(update);
      });

      stream.on("error", (err: Error) => {
        this.emit("error", new Error(`[Geyser] Stream error: ${err.message}`));
        this._scheduleReconnect();
      });

      stream.on("end", () => {
        console.log("[Geyser] Stream ended");
        this.emit("disconnected");
        this._scheduleReconnect();
      });

      // Send the initial subscription
      await this._sendSubscription();

      console.log(
        `[Geyser] Connected to ${this.config.endpoint} | watching ${this.watchList.size} account(s)`
      );
      this.emit("connected");
    } catch (err) {
      this.emit("error", new Error(`[Geyser] Connection error: ${String(err)}`));
      this._scheduleReconnect();
    }
  }

  /** Stop the geyser listener permanently. */
  stop(): void {
    this.stopped = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (this as any).stream;
    if (s) {
      try { s.end(); } catch (_) { /* ignore */ }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).stream = null;
    }
  }

  // ── typed EventEmitter overloads ───────────────────────────────────────────

  on<K extends keyof GeyserListenerEvents>(
    event: K,
    listener: GeyserListenerEvents[K]
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof GeyserListenerEvents>(
    event: K,
    ...args: Parameters<GeyserListenerEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  private async _sendSubscription(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (this as any).stream;
    if (!stream) return;

    // Build account filter map: one entry per watched pubkey
    const accountsFilter: Record<string, { account: string[]; filters: unknown[] }> = {};

    for (const pubkey of this.watchList) {
      accountsFilter[pubkey] = {
        account: [pubkey],
        filters: [],
      };
    }

    const request: SubscribeRequest = {
      accounts: accountsFilter,
      slots: {},
      transactions: {},
      transactionsStatus: {},
      entry: {},
      blocks: {},
      blocksMeta: {},
      commitment: this.config.commitment,
      accountsDataSlice: [],
      ping: undefined,
    };

    await new Promise<void>((resolve, reject) => {
      stream.write(request, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private _handleUpdate(update: SubscribeUpdate): void {
    if (!update.account) return;

    const accountInfo = update.account.account;
    const pubkey = update.account.account?.pubkey;

    if (!pubkey || !accountInfo) return;

    // Convert pubkey bytes to base58
    const pubkeyBase58 = Buffer.from(pubkey).toString("base58");

    const accountUpdate: AccountUpdate = {
      pubkey: pubkeyBase58,
      data: Buffer.from(accountInfo.data ?? []),
      lamports: BigInt(accountInfo.lamports ?? 0),
      exists: (accountInfo.lamports ?? 0) > 0,
      slot: BigInt(update.account.slot ?? 0),
      seq: BigInt(update.account.seq ?? 0),
    };

    this.emit("account", accountUpdate);
  }

  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private _scheduleReconnect(delayMs = 5_000): void {
    if (this.stopped) return;
    if (this._reconnectTimer) return; // already scheduled

    console.log(`[Geyser] Reconnecting in ${delayMs}ms …`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      await this.connect();
    }, delayMs);
  }
}
