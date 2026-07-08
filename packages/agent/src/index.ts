/**
 * index.ts — OddsForge Autonomous Agent
 *
 * Main entry point.  Wires together:
 *
 *   TxLineAuth         → bootstrap on-chain subscription + API token
 *   TxLineConnector    → SSE stream of live odds (real TxLINE schema)
 *   SignalEngine       → detects ≥5% odds movements, scores 0–100
 *   StrategyEngine     → gates, deduplicates, and sizes positions
 *   JitoExecutor       → bundles + submits Jito transactions
 *   AnchorExecutor     → calls place_stake / settle_position / close_position
 *   GeyserListener     → watches Position PDAs for on-chain confirmation
 *
 * Startup sequence:
 *  1. Load config from .env
 *  2. Bootstrap TxLINE auth (subscribe on-chain + activate API token)
 *  3. Connect Geyser listener
 *  4. Connect TxLINE SSE stream
 *  5. Schedule periodic token refresh, history prune, and settlement check
 *
 * Environment variables (see .env.example):
 *   SOLANA_RPC_URL, SOLANA_PRIVATE_KEY, TXLINE_NETWORK,
 *   GEYSER_ENDPOINT, GEYSER_TOKEN,
 *   JITO_BLOCK_ENGINE_URL, PROGRAM_ID
 *
 * Optional tuning:
 *   TXLINE_SERVICE_LEVEL_ID, TXLINE_DURATION_WEEKS,
 *   JITO_TIP_LAMPORTS, MIN_SIGNAL_SCORE,
 *   MIN_STAKE_LAMPORTS, MAX_STAKE_LAMPORTS
 */

import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { TxLineAuth, TxLineCredentials, REFRESH_INTERVAL_MS } from "./feeds/txline-auth";
import { TxLineConnector, OddsEvent } from "./feeds/txline";
import { GeyserListener, AccountUpdate } from "./feeds/geyser";
import { SignalEngine, Signal } from "./engine/signal";
import { StrategyEngine, TradeDecision } from "./engine/strategy";
import { AnchorExecutor } from "./executor/anchor";
import { JitoExecutor } from "./executor/jito";

// ─────────────────────────────────────────────────────────────────────────────
// Config — loaded from environment
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig() {
  const required = [
    "SOLANA_RPC_URL",
    "SOLANA_PRIVATE_KEY",
    "GEYSER_ENDPOINT",
    "GEYSER_TOKEN",
    "JITO_BLOCK_ENGINE_URL",
    "PROGRAM_ID",
  ] as const;

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}\nSee .env.example for reference.`
    );
  }

  // Parse wallet — accepts either a JSON byte-array or base58 private key
  const rawKey = process.env.SOLANA_PRIVATE_KEY!;
  let wallet: Keypair;
  try {
    wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey) as number[]));
  } catch {
    wallet = Keypair.fromSecretKey(bs58.decode(rawKey));
  }

  const network = (process.env.TXLINE_NETWORK ?? "mainnet") as "mainnet" | "devnet";
  if (network !== "mainnet" && network !== "devnet") {
    throw new Error(`TXLINE_NETWORK must be "mainnet" or "devnet", got "${network}"`);
  }

  return {
    rpcUrl: process.env.SOLANA_RPC_URL!,
    wallet,
    network,
    // TxLINE service level: 12 = real-time World Cup (free); 1 = 60s delay (free)
    serviceLevelId: parseInt(process.env.TXLINE_SERVICE_LEVEL_ID ?? "12", 10),
    durationWeeks: parseInt(process.env.TXLINE_DURATION_WEEKS ?? "4", 10),
    geyserEndpoint: process.env.GEYSER_ENDPOINT!,
    geyserToken: process.env.GEYSER_TOKEN!,
    jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL!,
    programId: new PublicKey(process.env.PROGRAM_ID!),
    tipLamports: parseInt(process.env.JITO_TIP_LAMPORTS ?? "100000", 10),
    minScore: parseInt(process.env.MIN_SIGNAL_SCORE ?? "60", 10),
    minStakeLamports: parseInt(process.env.MIN_STAKE_LAMPORTS ?? "10000000", 10),
    maxStakeLamports: parseInt(process.env.MAX_STAKE_LAMPORTS ?? "100000000", 10),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OddsForgeAgent
// ─────────────────────────────────────────────────────────────────────────────

class OddsForgeAgent {
  // Components
  private readonly auth: TxLineAuth;
  private readonly signal: SignalEngine;
  private readonly strategy: StrategyEngine;
  private readonly anchor: AnchorExecutor;
  private readonly jito: JitoExecutor;
  private readonly geyser: GeyserListener;

  // Live credentials — updated on every refresh
  private credentials: TxLineCredentials | null = null;

  // TxLINE SSE connector — created after auth
  private feed: TxLineConnector | null = null;

  // Last TxSig from on-chain subscription (used for token-only refresh)
  private lastSubscriptionTxSig: string | null = null;

  // Per-fixture last-seen timestamp (for settlement detection)
  private readonly lastSeenTs: Map<string, number> = new Map();

  // Timers
  private pruneTimer?: ReturnType<typeof setInterval>;
  private settlementTimer?: ReturnType<typeof setInterval>;
  private tokenRefreshTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly cfg: ReturnType<typeof loadConfig>) {
    this.auth = new TxLineAuth({
      network: cfg.network,
      wallet: cfg.wallet,
      serviceLevelId: cfg.serviceLevelId,
      durationWeeks: cfg.durationWeeks,
    });

    this.signal = new SignalEngine();

    this.strategy = new StrategyEngine({
      minScore: cfg.minScore,
      minStakeLamports: cfg.minStakeLamports,
      maxStakeLamports: cfg.maxStakeLamports,
    });

    this.anchor = new AnchorExecutor({
      rpcUrl: cfg.rpcUrl,
      wallet: cfg.wallet,
      programId: cfg.programId,
      commitment: "confirmed",
    });

    this.jito = new JitoExecutor({
      blockEngineUrl: cfg.jitoBlockEngineUrl,
      wallet: cfg.wallet,
      connection: this.anchor.connection,
      tipLamports: cfg.tipLamports,
    });

    this.geyser = new GeyserListener({
      endpoint: cfg.geyserEndpoint,
      token: cfg.geyserToken,
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  OddsForge — Autonomous On-Chain Trading Agent");
    console.log("  Built on Solana · TxLINE · TxODDS World Cup Hackathon 2026");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Wallet   : ${this.cfg.wallet.publicKey.toBase58()}`);
    console.log(`  Program  : ${this.cfg.programId.toBase58()}`);
    console.log(`  Network  : ${this.cfg.network}`);
    console.log(`  RPC      : ${this.cfg.rpcUrl}`);
    console.log(`  SvcLevel : ${this.cfg.serviceLevelId} (${this.cfg.serviceLevelId === 12 ? "real-time" : "60s delay"})`);
    console.log("═══════════════════════════════════════════════════════════\n");

    // Step 1 — Bootstrap TxLINE auth (on-chain subscribe + API token)
    console.log("[Agent] Bootstrapping TxLINE auth …");
    this.credentials = await this.auth.activate();
    // Record the subscription txSig for future token-only refreshes
    // (activate() emits the txSig to the console; we re-activate on schedule)
    console.log("[Agent] TxLINE auth complete\n");

    // Step 2 — Wire and connect Geyser
    this._wireGeyser();
    await this.geyser.connect();

    // Step 3 — Create and wire the TxLINE SSE feed
    this._createFeed();
    this.feed!.connect();

    // Step 4 — Periodic maintenance
    this._startPeriodicTasks();

    console.log("[Agent] All systems running — waiting for signals …\n");
  }

  stop(): void {
    console.log("[Agent] Shutting down …");
    this.feed?.stop();
    this.geyser.stop();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.settlementTimer) clearInterval(this.settlementTimer);
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
  }

  // ── TxLINE feed setup ─────────────────────────────────────────────────────

  private _createFeed(): void {
    this.feed = new TxLineConnector(
      this.auth.apiOrigin,
      // Credentials are resolved lazily so refreshes take effect immediately
      () => {
        if (!this.credentials) {
          throw new Error("[Agent] TxLINE credentials not yet available");
        }
        return {
          jwt: this.credentials.jwt,
          apiToken: this.credentials.apiToken,
        };
      }
    );

    this.feed.on("connected", () => {
      console.log("[Agent] TxLINE SSE stream connected");
    });

    this.feed.on("disconnected", (reason) => {
      console.warn(`[Agent] TxLINE stream disconnected: ${reason}`);
    });

    this.feed.on("error", (err) => {
      console.error(`[Agent] TxLINE error: ${err.message}`);
    });

    this.feed.on("odds", (event: OddsEvent) => {
      this.lastSeenTs.set(event.fixtureId, Date.now());
      this.signal.ingest(event);
    });

    this.signal.on("signal", (sig: Signal) => {
      this._onSignal(sig);
    });
  }

  // ── Geyser wiring ─────────────────────────────────────────────────────────

  private _wireGeyser(): void {
    this.geyser.on("connected", () => {
      console.log("[Agent] Yellowstone Geyser connected");
    });

    this.geyser.on("error", (err) => {
      console.error(`[Agent] Geyser error: ${err.message}`);
    });

    this.geyser.on("disconnected", () => {
      console.warn("[Agent] Geyser disconnected — reconnecting …");
    });

    this.geyser.on("account", (update: AccountUpdate) => {
      this._onAccountUpdate(update);
    });
  }

  // ── Signal → Decision → Execution pipeline ────────────────────────────────

  private _onSignal(signal: Signal): void {
    const decision = this.strategy.evaluate(signal);
    if (!decision) return;

    console.log(
      `[Agent] ✦ Signal! fixture=${signal.fixtureId} sel=${signal.selectionName}` +
        ` market=${signal.marketType} score=${signal.score}` +
        ` odds=${signal.currentOdds.toFixed(4)}` +
        ` ${signal.pctChange >= 0 ? "+" : ""}${(signal.pctChange * 100).toFixed(2)}%` +
        ` ${signal.inRunning ? "[LIVE]" : "[pre]"}` +
        ` stake=${(decision.stakeLamports / 1e9).toFixed(4)} SOL`
    );

    this.strategy.markPending(decision.key);

    this._executeDecision(decision).catch((err) => {
      console.error(
        `[Agent] Execution error for ${decision.key}: ${String(err)}`
      );
      this.strategy.markFailed(decision.key);
    });
  }

  private async _executeDecision(decision: TradeDecision): Promise<void> {
    console.log(
      `[Agent] → Submitting Jito bundle | fixture=${decision.fixtureId} sel=${decision.selectionName}`
    );

    const result = await this.jito.executeDecision(decision, this.anchor);

    if (result.status === "failed") {
      console.error(
        `[Agent] ✗ Bundle failed | ${decision.key} bundleId=${result.bundleId}`
      );
      this.strategy.markFailed(decision.key);
      return;
    }

    const pdaAddress = this.anchor.derivePositionPDA(decision.fixtureId).toBase58();

    console.log(
      `[Agent] ✓ Position placed | fixture=${decision.fixtureId} sel=${decision.selectionName}` +
        ` pda=${pdaAddress} bundleId=${result.bundleId} status=${result.status}`
    );

    this.strategy.recordOpen(decision, pdaAddress);
    this.geyser.watchAccount(pdaAddress);
  }

  // ── Geyser account update ─────────────────────────────────────────────────

  private _onAccountUpdate(update: AccountUpdate): void {
    if (!update.exists) {
      console.log(`[Agent] ⬡ Account closed | ${update.pubkey}`);
      return;
    }

    const pos = this.strategy
      .getOpenPositions()
      .find((p) => p.pdaAddress === update.pubkey);

    if (!pos) return;

    console.log(
      `[Agent] ⬡ On-chain confirm | fixture=${pos.fixtureId} sel=${pos.selectionName}` +
        ` slot=${update.slot} lamports=${update.lamports}`
    );
  }

  // ── Periodic maintenance ──────────────────────────────────────────────────

  private _startPeriodicTasks(): void {
    // Prune stale signal history every 30 seconds
    this.pruneTimer = setInterval(() => {
      this.signal.pruneHistory();
    }, 30_000);

    // Settlement check every 60 seconds
    this.settlementTimer = setInterval(() => {
      this._checkSettlements().catch((err) => {
        console.error(`[Agent] Settlement check error: ${String(err)}`);
      });
    }, 60_000);

    // Schedule token refresh before expiry (every REFRESH_INTERVAL_MS = 6 h)
    this._scheduleTokenRefresh();
  }

  private _scheduleTokenRefresh(): void {
    this.tokenRefreshTimer = setTimeout(async () => {
      console.log("[Agent] Refreshing TxLINE API token …");
      try {
        // Re-run the full activate flow rather than just token refresh,
        // since the free subscription is valid for the full tournament.
        this.credentials = await this.auth.activate();
        console.log("[Agent] TxLINE token refreshed");
      } catch (err) {
        console.error(`[Agent] Token refresh failed: ${String(err)}`);
      }
      // Schedule the next refresh
      this._scheduleTokenRefresh();
    }, REFRESH_INTERVAL_MS);
  }

  private async _checkSettlements(): Promise<void> {
    const open = this.strategy.getOpenPositions();
    if (open.length === 0) return;

    const now = Date.now();
    const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

    for (const pos of open) {
      const lastSeen = this.lastSeenTs.get(pos.fixtureId);
      if (!lastSeen) continue;

      const ageMs = now - lastSeen;
      if (ageMs > STALE_THRESHOLD_MS) {
        console.log(
          `[Agent] fixture=${pos.fixtureId} appears finished` +
            ` (last odds update ${Math.round(ageMs / 60000)}m ago) — settling as voided`
        );
        await this._settlePosition(pos.fixtureId, pos.selectionName, "voided");
      }
    }
  }

  private async _settlePosition(
    fixtureId: string,
    selectionName: string,
    outcome: "won" | "lost" | "voided"
  ): Promise<void> {
    try {
      const sig = await this.anchor.settlePosition(fixtureId, outcome);
      console.log(
        `[Agent] ✓ Settled | fixture=${fixtureId} sel=${selectionName} → ${outcome} tx=${sig}`
      );
      this.strategy.recordSettlement(fixtureId, selectionName, outcome);

      // Reclaim rent
      try {
        const closeSig = await this.anchor.closePosition(fixtureId);
        console.log(`[Agent] ✓ Position closed (rent reclaimed) tx=${closeSig}`);
      } catch (closeErr) {
        console.warn(`[Agent] Could not close position: ${String(closeErr)}`);
      }
    } catch (err) {
      console.error(
        `[Agent] Settlement error for fixture=${fixtureId}: ${String(err)}`
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let cfg: ReturnType<typeof loadConfig>;

  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`[Config] ${String(err)}`);
    process.exit(1);
  }

  const agent = new OddsForgeAgent(cfg);

  const shutdown = (sig: string) => {
    console.log(`\n[Agent] Received ${sig} — shutting down …`);
    agent.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    console.error("[Agent] Unhandled rejection:", reason);
  });

  await agent.start();
}

main();
