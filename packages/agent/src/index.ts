/**
 * index.ts — OddsForge Autonomous Agent
 *
 * Wires together:
 *   TxLineAuth              → bootstrap on-chain subscription + API token
 *   TxLineConnector         → SSE stream of live odds
 *   TxLineScoresConnector   → SSE stream of live scores
 *   SignalEngine            → detects ≥5% odds movements, scores 0–100
 *   StrategyEngine          → gates, deduplicates, and sizes positions
 *   JitoExecutor            → bundles + submits transactions (optional)
 *   AnchorExecutor          → calls place_stake / settle_position / close_position
 *   GeyserListener          → watches Position PDAs for on-chain confirmation (optional)
 *
 * Startup sequence:
 *  1. Load config from .env
 *  2. Bootstrap TxLINE auth (subscribe on-chain + activate API token)
 *  3. Connect Geyser listener (skipped when GEYSER_ENDPOINT is blank)
 *  4. Connect TxLINE odds SSE stream
 *  5. Connect TxLINE scores SSE stream
 *  6. Schedule periodic token refresh, history prune, and settlement check
 *
 * Settlement:
 *  - Live settle: scores stream emits game_finalised (statusId=100).
 *    The agent resolves the outcome from the final score and calls
 *    settle_position immediately.
 *  - Fallback: if a fixture hasn't produced odds for 2 hours the agent
 *    settles the position as "voided".
 *
 * Geyser / Jito are fully optional:
 *  - Leave GEYSER_ENDPOINT blank → NoopGeyserListener is used (no-op).
 *  - Leave JITO_BLOCK_ENGINE_URL blank → plain RPC submission is used.
 */

import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { TxLineAuth, TxLineCredentials, REFRESH_INTERVAL_MS } from "./feeds/txline-auth";
import { TxLineConnector, OddsEvent } from "./feeds/txline";
import { TxLineScoresConnector, ScoreEvent } from "./feeds/txline-scores";
import { GeyserListener, NoopGeyserListener, AccountUpdate } from "./feeds/geyser";
import { SignalEngine, Signal } from "./engine/signal";
import { StrategyEngine, TradeDecision } from "./engine/strategy";
import { AnchorExecutor } from "./executor/anchor";
import { JitoExecutor } from "./executor/jito";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig() {
  const required = ["SOLANA_RPC_URL", "SOLANA_PRIVATE_KEY", "PROGRAM_ID"] as const;
  const missing  = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}\nSee .env.example for reference.`
    );
  }

  // Geyser is optional — disabled when endpoint is absent or a placeholder
  const geyserEndpoint = process.env.GEYSER_ENDPOINT ?? "";
  const geyserToken    = process.env.GEYSER_TOKEN ?? "";
  const geyserEnabled  =
    geyserEndpoint.length > 0 &&
    !geyserEndpoint.includes("your-endpoint") &&
    geyserToken.length > 0 &&
    !geyserToken.includes("your-triton");

  // Jito is optional — disabled when URL is absent or a placeholder
  const jitoUrl     = process.env.JITO_BLOCK_ENGINE_URL ?? "";
  const jitoEnabled = jitoUrl.length > 0 && !jitoUrl.includes("your-jito");

  // Parse wallet — accepts JSON byte-array or base58 private key
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

  const rpcUrl = process.env.SOLANA_RPC_URL!;
  const rpcLooksDevnet = /devnet/i.test(rpcUrl);
  const rpcLooksMainnet = /mainnet/i.test(rpcUrl);
  if (network === "devnet" && rpcLooksMainnet) {
    throw new Error(
      "TXLINE_NETWORK=devnet but SOLANA_RPC_URL points at mainnet. " +
      "Use https://api.devnet.solana.com for devnet testing."
    );
  }
  if (network === "mainnet" && rpcLooksDevnet) {
    throw new Error(
      "TXLINE_NETWORK=mainnet but SOLANA_RPC_URL points at devnet. " +
      "Use a mainnet RPC endpoint for production."
    );
  }

  const defaultServiceLevel = network === "devnet" ? "1" : "12";

  return {
    rpcUrl,
    wallet,
    network,
    serviceLevelId:      parseInt(process.env.TXLINE_SERVICE_LEVEL_ID ?? defaultServiceLevel, 10),
    durationWeeks:       parseInt(process.env.TXLINE_DURATION_WEEKS ?? "4", 10),
    geyserEndpoint,
    geyserToken,
    geyserEnabled,
    jitoBlockEngineUrl:  jitoUrl,
    jitoEnabled,
    programId:           new PublicKey(process.env.PROGRAM_ID!),
    tipLamports:         parseInt(process.env.JITO_TIP_LAMPORTS ?? "100000", 10),
    minScore:            parseInt(process.env.MIN_SIGNAL_SCORE ?? "60", 10),
    minStakeLamports:    parseInt(process.env.MIN_STAKE_LAMPORTS ?? "10000000", 10),
    maxStakeLamports:    parseInt(process.env.MAX_STAKE_LAMPORTS ?? "100000000", 10),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OddsForgeAgent
// ─────────────────────────────────────────────────────────────────────────────

class OddsForgeAgent {
  private readonly auth:     TxLineAuth;
  private readonly signal:   SignalEngine;
  private readonly strategy: StrategyEngine;
  private readonly anchor:   AnchorExecutor;
  private readonly jito:     JitoExecutor;
  private readonly geyser:   GeyserListener | NoopGeyserListener;

  private credentials: TxLineCredentials | null = null;
  private oddsFeed:   TxLineConnector | null = null;
  private scoresFeed: TxLineScoresConnector | null = null;

  /** Per-fixture last-seen odds timestamp (for stale-match fallback settlement) */
  private readonly lastSeenTs: Map<string, number> = new Map();

  /**
   * Per-fixture final score from game_finalised events.
   * Key = fixtureId, value = { score1, score2 }.
   */
  private readonly finalScores: Map<string, { score1: number; score2: number }> = new Map();

  private pruneTimer?:        ReturnType<typeof setInterval>;
  private settlementTimer?:   ReturnType<typeof setInterval>;
  private tokenRefreshTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly cfg: ReturnType<typeof loadConfig>) {
    this.auth = new TxLineAuth({
      network:        cfg.network,
      wallet:         cfg.wallet,
      serviceLevelId: cfg.serviceLevelId,
      durationWeeks:  cfg.durationWeeks,
    });

    this.signal   = new SignalEngine();
    this.strategy = new StrategyEngine({
      minScore:        cfg.minScore,
      minStakeLamports: cfg.minStakeLamports,
      maxStakeLamports: cfg.maxStakeLamports,
    });

    this.anchor = new AnchorExecutor({
      rpcUrl:    cfg.rpcUrl,
      wallet:    cfg.wallet,
      programId: cfg.programId,
      commitment: "confirmed",
    });

    this.jito = new JitoExecutor({
      blockEngineUrl: cfg.jitoBlockEngineUrl,
      wallet:         cfg.wallet,
      connection:     this.anchor.connection,
      tipLamports:    cfg.tipLamports,
      enabled:        cfg.jitoEnabled,
    });

    this.geyser = cfg.geyserEnabled
      ? new GeyserListener({ endpoint: cfg.geyserEndpoint, token: cfg.geyserToken })
      : new NoopGeyserListener();
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
    console.log(`  Geyser   : ${this.cfg.geyserEnabled ? "enabled" : "disabled (no endpoint — set GEYSER_ENDPOINT to enable)"}`);
    console.log(`  Jito     : ${this.cfg.jitoEnabled ? "enabled" : "disabled (plain RPC fallback — set JITO_BLOCK_ENGINE_URL to enable)"}`);
    console.log("═══════════════════════════════════════════════════════════\n");

    console.log("[Agent] Bootstrapping TxLINE auth …");
    this.credentials = await this.auth.activate();
    console.log("[Agent] TxLINE auth complete\n");

    this._wireGeyser();
    await this.geyser.connect();

    this._createOddsFeed();
    this.oddsFeed!.connect();

    this._createScoresFeed();
    this.scoresFeed!.connect();

    this._startPeriodicTasks();

    console.log("[Agent] All systems running — waiting for signals …\n");
  }

  stop(): void {
    console.log("[Agent] Shutting down …");
    this.oddsFeed?.stop();
    this.scoresFeed?.stop();
    this.geyser.stop();
    if (this.pruneTimer)      clearInterval(this.pruneTimer);
    if (this.settlementTimer) clearInterval(this.settlementTimer);
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
  }

  // ── Odds feed ─────────────────────────────────────────────────────────────

  private _createOddsFeed(): void {
    this.oddsFeed = new TxLineConnector(
      this.auth.apiOrigin,
      () => {
        if (!this.credentials) throw new Error("[Agent] TxLINE credentials not yet available");
        return { jwt: this.credentials.jwt, apiToken: this.credentials.apiToken };
      }
    );

    this.oddsFeed.on("connected",    () => console.log("[Agent] TxLINE odds stream connected"));
    this.oddsFeed.on("disconnected", (r) => console.warn(`[Agent] Odds stream disconnected: ${r}`));
    this.oddsFeed.on("error",        (e) => console.error(`[Agent] Odds error: ${e.message}`));

    this.oddsFeed.on("odds", (event: OddsEvent) => {
      this.lastSeenTs.set(event.fixtureId, Date.now());
      this.signal.ingest(event);
    });

    this.signal.on("signal", (sig: Signal) => this._onSignal(sig));
  }

  // ── Scores feed ───────────────────────────────────────────────────────────

  private _createScoresFeed(): void {
    this.scoresFeed = new TxLineScoresConnector(
      this.auth.apiOrigin,
      () => {
        if (!this.credentials) throw new Error("[Agent] TxLINE credentials not yet available");
        return { jwt: this.credentials.jwt, apiToken: this.credentials.apiToken };
      }
    );

    this.scoresFeed.on("connected", () =>
      console.log("[Agent] TxLINE scores stream connected")
    );

    this.scoresFeed.on("disconnected", (r) =>
      console.warn(`[Agent] Scores stream disconnected: ${r}`)
    );

    this.scoresFeed.on("error", (e) =>
      console.error(`[Agent] Scores error: ${e.message}`)
    );

    this.scoresFeed.on("score", (event: ScoreEvent) => {
      const minute = event.minute != null ? `${event.minute}'` : "";
      const score  = event.score1 != null && event.score2 != null
        ? ` [${event.score1}–${event.score2}]`
        : "";
      const phase  = event.gamePhase ?? "";
      console.log(
        `[Scores] fixture=${event.fixtureId} action=${event.action}` +
        ` ${phase}${minute}${score}`
      );
    });

    // game_finalised (statusId=100) is the definitive match-end marker from
    // the TxLINE docs — use it to drive real settle_position calls.
    this.scoresFeed.on("game_finalised", (event: ScoreEvent) => {
      console.log(
        `[Scores] 🏁 game_finalised | fixture=${event.fixtureId}` +
        ` score=${event.score1 ?? "?"}–${event.score2 ?? "?"}`
      );

      // Cache the final score for outcome resolution
      if (event.score1 != null && event.score2 != null) {
        this.finalScores.set(event.fixtureId, {
          score1: event.score1,
          score2: event.score2,
        });
      }

      // Trigger live settlement for any open position on this fixture
      this._settleFromScores(event.fixtureId).catch((err) =>
        console.error(`[Agent] Live settlement error for fixture=${event.fixtureId}: ${String(err)}`)
      );
    });
  }

  // ── Geyser wiring ─────────────────────────────────────────────────────────

  private _wireGeyser(): void {
    this.geyser.on("connected",    () => console.log("[Agent] Yellowstone Geyser connected"));
    this.geyser.on("error",        (e) => console.error(`[Agent] Geyser error: ${e.message}`));
    this.geyser.on("disconnected", () => console.warn("[Agent] Geyser disconnected — reconnecting …"));
    this.geyser.on("account",      (u: AccountUpdate) => this._onAccountUpdate(u));
  }

  // ── Signal → Decision → Execution ─────────────────────────────────────────

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
      console.error(`[Agent] Execution error for ${decision.key}: ${String(err)}`);
      this.strategy.markFailed(decision.key);
    });
  }

  private async _executeDecision(decision: TradeDecision): Promise<void> {
    console.log(
      `[Agent] → Submitting bundle | fixture=${decision.fixtureId} sel=${decision.selectionName}`
    );

    const result = await this.jito.executeDecision(decision, this.anchor);

    if (result.status === "failed") {
      console.error(`[Agent] ✗ Bundle failed | ${decision.key} bundleId=${result.bundleId}`);
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

  // ── Geyser account update ──────────────────────────────────────────────────

  private _onAccountUpdate(update: AccountUpdate): void {
    if (!update.exists) {
      console.log(`[Agent] ⬡ Account closed | ${update.pubkey}`);
      return;
    }
    const pos = this.strategy.getOpenPositions().find((p) => p.pdaAddress === update.pubkey);
    if (!pos) return;
    console.log(
      `[Agent] ⬡ On-chain confirm | fixture=${pos.fixtureId} sel=${pos.selectionName}` +
      ` slot=${update.slot} lamports=${update.lamports}`
    );
  }

  // ── Live settlement from scores ────────────────────────────────────────────

  /**
   * Called when game_finalised fires.  For each open position on this fixture
   * determine the outcome from the final score and settle on-chain.
   *
   * Outcome logic:
   *  - selection "home"  → won if score1 > score2, lost if score1 < score2, voided on draw
   *  - selection "draw"  → won if score1 === score2
   *  - selection "away"  → won if score2 > score1
   *  - anything else     → voided (we can't determine outcome without market rules)
   */
  private async _settleFromScores(fixtureId: string): Promise<void> {
    const open = this.strategy.getOpenPositions().filter((p) => p.fixtureId === fixtureId);
    if (open.length === 0) return;

    const finalScore = this.finalScores.get(fixtureId);

    for (const pos of open) {
      let outcome: "won" | "lost" | "voided" = "voided";

      if (finalScore) {
        const { score1, score2 } = finalScore;
        const sel = pos.selectionName.toLowerCase();

        if (sel === "home") {
          outcome = score1 > score2 ? "won" : score1 < score2 ? "lost" : "voided";
        } else if (sel === "draw") {
          outcome = score1 === score2 ? "won" : "lost";
        } else if (sel === "away") {
          outcome = score2 > score1 ? "won" : score2 < score1 ? "lost" : "voided";
        }
        // All other selections (e.g. Asian handicap, over/under) → voided
        // because outcome resolution requires market-specific rules.
      }

      await this._settlePosition(fixtureId, pos.selectionName, outcome);
    }
  }

  // ── Periodic maintenance ──────────────────────────────────────────────────

  private _startPeriodicTasks(): void {
    this.pruneTimer = setInterval(() => {
      this.signal.pruneHistory();
    }, 30_000);

    // Fallback settlement — catches any fixture where game_finalised was
    // missed or the scores stream was down.
    this.settlementTimer = setInterval(() => {
      this._checkStaleSettlements().catch((err) =>
        console.error(`[Agent] Settlement check error: ${String(err)}`)
      );
    }, 60_000);

    this._scheduleTokenRefresh();
  }

  private _scheduleTokenRefresh(): void {
    this.tokenRefreshTimer = setTimeout(async () => {
      console.log("[Agent] Refreshing TxLINE API token …");
      try {
        if (this.credentials?.txSig) {
          this.credentials = await this.auth.refreshToken(this.credentials.txSig);
        } else {
          this.credentials = await this.auth.activate();
        }
        console.log("[Agent] TxLINE token refreshed");
      } catch (err) {
        console.error(`[Agent] Token refresh failed: ${String(err)}`);
      }
      this._scheduleTokenRefresh();
    }, REFRESH_INTERVAL_MS);
  }

  /**
   * Fallback: settle positions for fixtures that have been silent for > 2 hours.
   * The primary settlement path is game_finalised from the scores stream.
   */
  private async _checkStaleSettlements(): Promise<void> {
    const open  = this.strategy.getOpenPositions();
    if (open.length === 0) return;

    const now               = Date.now();
    const STALE_MS          = 2 * 60 * 60 * 1000; // 2 hours
    const seenFixtures      = new Set<string>();

    for (const pos of open) {
      if (seenFixtures.has(pos.fixtureId)) continue;

      const lastSeen = this.lastSeenTs.get(pos.fixtureId);
      if (!lastSeen) continue;

      if (now - lastSeen > STALE_MS) {
        seenFixtures.add(pos.fixtureId);
        console.log(
          `[Agent] fixture=${pos.fixtureId} stale (last odds ${Math.round((now - lastSeen) / 60000)}m ago)` +
          ` — settling open positions as voided`
        );
        // Try to use cached final score first, otherwise void
        await this._settleFromScores(pos.fixtureId);
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

      try {
        const closeSig = await this.anchor.closePosition(fixtureId);
        console.log(`[Agent] ✓ Position closed (rent reclaimed) tx=${closeSig}`);
      } catch (closeErr) {
        console.warn(`[Agent] Could not close position: ${String(closeErr)}`);
      }
    } catch (err) {
      console.error(`[Agent] Settlement error fixture=${fixtureId}: ${String(err)}`);
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

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    console.error("[Agent] Unhandled rejection:", reason);
  });

  await agent.start();
}

main();
