#!/usr/bin/env ts-node
/**
 * scripts/query.ts
 *
 * Standalone TxLINE Query CLI
 *
 * Queries live TxLINE data without running the full trading agent.
 * Runs the complete auth flow (guest JWT + on-chain subscribe + API token
 * activation), then calls the requested endpoint and pretty-prints the result.
 *
 * Usage:
 *   npx ts-node src/scripts/query.ts <command> [options]
 *
 * Commands:
 *   fixtures [--competition <id>]        List all fixtures (optionally filtered)
 *   odds     <fixtureId>                 Odds snapshot for a fixture
 *   scores   <fixtureId>                 Scores snapshot for a fixture
 *   live     <fixtureId>                 Live scores updates for a fixture
 *   history  <fixtureId>                 Full historical scores (2w–6h ago)
 *   stream   scores                      Stream live scores to stdout (Ctrl+C to stop)
 *   stream   odds                        Stream live odds to stdout (Ctrl+C to stop)
 *
 * Examples:
 *   npx ts-node src/scripts/query.ts fixtures
 *   npx ts-node src/scripts/query.ts fixtures --competition 500005
 *   npx ts-node src/scripts/query.ts odds 17952170
 *   npx ts-node src/scripts/query.ts scores 17952170
 *   npx ts-node src/scripts/query.ts live 17952170
 *   npx ts-node src/scripts/query.ts history 17952170
 *   npx ts-node src/scripts/query.ts stream scores
 *   npx ts-node src/scripts/query.ts stream odds
 *
 * Required environment (same .env as the main agent):
 *   SOLANA_RPC_URL, SOLANA_PRIVATE_KEY
 *   TXLINE_NETWORK (optional, default "mainnet")
 *   TXLINE_SERVICE_LEVEL_ID (optional, default 12 mainnet / 1 devnet)
 *   TXLINE_DURATION_WEEKS (optional, default 4)
 */

import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { TxLineAuth } from "../feeds/txline-auth";
import { TxLineQueryClient, TxLineFixture } from "../feeds/txline-query";
import { TxLineConnector, OddsEvent } from "../feeds/txline";
import { TxLineScoresConnector, ScoreEvent } from "../feeds/txline-scores";

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap auth
// ─────────────────────────────────────────────────────────────────────────────

async function bootstrap() {
  const rawKey = process.env.SOLANA_PRIVATE_KEY;
  if (!rawKey) {
    console.error("Error: SOLANA_PRIVATE_KEY is not set in .env");
    process.exit(1);
  }

  let wallet: Keypair;
  try {
    wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey) as number[]));
  } catch {
    wallet = Keypair.fromSecretKey(bs58.decode(rawKey));
  }

  const network = (process.env.TXLINE_NETWORK ?? "mainnet") as "mainnet" | "devnet";
  const defaultLevel = network === "devnet" ? 1 : 12;
  const serviceLevelId = parseInt(process.env.TXLINE_SERVICE_LEVEL_ID ?? String(defaultLevel), 10);
  const durationWeeks  = parseInt(process.env.TXLINE_DURATION_WEEKS ?? "4", 10);

  console.log(`[Query] Authenticating on ${network} (service level ${serviceLevelId}) …`);

  const auth = new TxLineAuth({ network, wallet, serviceLevelId, durationWeeks });
  const credentials = await auth.activate();

  console.log("[Query] Auth complete\n");

  const query = new TxLineQueryClient({
    apiOrigin:      auth.apiOrigin,
    getCredentials: () => ({ jwt: credentials.jwt, apiToken: credentials.apiToken }),
  });

  return { auth, credentials, query };
}

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers
// ─────────────────────────────────────────────────────────────────────────────

function printFixtures(fixtures: TxLineFixture[]): void {
  if (fixtures.length === 0) {
    console.log("(no fixtures returned)");
    return;
  }
  console.log(`Retrieved ${fixtures.length} fixture(s):\n`);
  for (const f of fixtures) {
    const { home, away } = TxLineQueryClient.participantNames(f);
    const start          = new Date(f.StartTime).toISOString();
    const state          = f.GameState === 6 ? " [CANCELLED]" : f.GameState === 1 ? " [scheduled]" : "";
    console.log(`  ${f.FixtureId}  ${home} vs ${away}  |  ${start}${state}`);
    if (f.CompetitionName) console.log(`            Competition: ${f.CompetitionName}`);
  }
}

function printJson(label: string, data: unknown[]): void {
  console.log(`${label} — ${data.length} record(s):\n`);
  console.log(JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

async function cmdFixtures(args: string[]): Promise<void> {
  const compIdx = args.indexOf("--competition");
  const competitionId = compIdx !== -1 ? parseInt(args[compIdx + 1], 10) : undefined;

  const { query } = await bootstrap();

  if (competitionId != null) {
    console.log(`[Query] Fetching fixtures for competition ${competitionId} …`);
  } else {
    console.log("[Query] Fetching all fixtures …");
  }

  const fixtures = await query.getFixtures(competitionId);
  printFixtures(fixtures);
}

async function cmdOdds(fixtureId: string): Promise<void> {
  const { query } = await bootstrap();
  console.log(`[Query] Fetching odds snapshot for fixture ${fixtureId} …`);
  const data = await query.getOddsSnapshot(fixtureId);
  printJson(`Odds snapshot (fixture ${fixtureId})`, data);
}

async function cmdScores(fixtureId: string): Promise<void> {
  const { query } = await bootstrap();
  console.log(`[Query] Fetching scores snapshot for fixture ${fixtureId} …`);
  const data = await query.getScoresSnapshot(fixtureId);
  printJson(`Scores snapshot (fixture ${fixtureId})`, data);
}

async function cmdLive(fixtureId: string): Promise<void> {
  const { query } = await bootstrap();
  console.log(`[Query] Fetching live scores for fixture ${fixtureId} …`);
  const data = await query.getLiveScores(fixtureId);
  printJson(`Live scores (fixture ${fixtureId})`, data);
}

async function cmdHistory(fixtureId: string): Promise<void> {
  const { query } = await bootstrap();
  console.log(`[Query] Fetching historical scores for fixture ${fixtureId} …`);
  console.log("        (available for fixtures that started between 2 weeks and 6 hours ago)\n");
  const data = await query.getHistoricalScores(fixtureId);

  if (data.length === 0) {
    console.log("(no historical data returned — check fixture start time window)");
    return;
  }

  console.log(`Retrieved ${data.length} historical score record(s):\n`);
  for (const r of data) {
    const ts     = r.ts ? new Date(r.ts * 1000).toISOString() : "?";
    const score  = r.score1 != null && r.score2 != null ? ` [${r.score1}–${r.score2}]` : "";
    const action = r.action ?? "?";
    console.log(`  seq=${r.seq}  ${ts}  ${action}${score}  phase=${r.gamePhase ?? "?"}  status=${r.statusId ?? "?"}`);
  }
}

async function cmdStreamScores(): Promise<void> {
  const { auth, credentials } = await bootstrap();
  console.log("[Query] Connecting to scores stream … (Ctrl+C to stop)\n");

  const feed = new TxLineScoresConnector(
    auth.apiOrigin,
    () => ({ jwt: credentials.jwt, apiToken: credentials.apiToken })
  );

  feed.on("connected",    () => console.log("[Stream] Connected to scores SSE stream\n"));
  feed.on("disconnected", (r) => console.warn(`[Stream] Disconnected: ${r}`));
  feed.on("error",        (e) => console.error(`[Stream] Error: ${e.message}`));

  feed.on("score", (event: ScoreEvent) => {
    const ts     = new Date(event.timestamp).toISOString();
    const minute = event.minute != null ? `${event.minute}'` : "";
    const score  = event.score1 != null && event.score2 != null
      ? ` [${event.score1}–${event.score2}]`
      : "";
    console.log(
      `[${ts}] fixture=${event.fixtureId}` +
      ` action=${event.action} phase=${event.gamePhase ?? "?"}${minute}${score}` +
      (event.isGameFinalised ? " ← GAME FINALISED" : "")
    );
    if (event.stats && Object.keys(event.stats).length > 0) {
      console.log("  stats:", JSON.stringify(event.stats));
    }
  });

  feed.connect();

  // Keep the process alive
  await new Promise<void>((resolve) => {
    process.on("SIGINT",  () => { feed.stop(); resolve(); });
    process.on("SIGTERM", () => { feed.stop(); resolve(); });
  });
}

async function cmdStreamOdds(): Promise<void> {
  const { auth, credentials } = await bootstrap();
  console.log("[Query] Connecting to odds stream … (Ctrl+C to stop)\n");

  const feed = new TxLineConnector(
    auth.apiOrigin,
    () => ({ jwt: credentials.jwt, apiToken: credentials.apiToken })
  );

  feed.on("connected",    () => console.log("[Stream] Connected to odds SSE stream\n"));
  feed.on("disconnected", (r) => console.warn(`[Stream] Disconnected: ${r}`));
  feed.on("error",        (e) => console.error(`[Stream] Error: ${e.message}`));

  feed.on("odds", (event: OddsEvent) => {
    const ts      = new Date(event.timestamp).toISOString();
    const selections = event.selections
      .map((s) => `${s.name}@${s.decimalOdds.toFixed(3)}`)
      .join("  ");
    console.log(
      `[${ts}] fixture=${event.fixtureId}` +
      ` ${event.marketType} ${event.inRunning ? "[LIVE]" : "[pre]"}` +
      `  ${selections}`
    );
  });

  feed.connect();

  await new Promise<void>((resolve) => {
    process.on("SIGINT",  () => { feed.stop(); resolve(); });
    process.on("SIGTERM", () => { feed.stop(); resolve(); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
OddsForge — TxLINE Query CLI

Usage: npx ts-node src/scripts/query.ts <command> [args]

Commands:
  fixtures [--competition <id>]   List fixtures (optionally by competition)
  odds     <fixtureId>            Odds snapshot for a fixture
  scores   <fixtureId>            Scores snapshot for a fixture
  live     <fixtureId>            Live scores updates for a fixture
  history  <fixtureId>            Historical scores (fixtures 2w–6h ago)
  stream   scores                 Stream live scores (Ctrl+C to stop)
  stream   odds                   Stream live odds (Ctrl+C to stop)

Examples:
  npx ts-node src/scripts/query.ts fixtures
  npx ts-node src/scripts/query.ts fixtures --competition 500005
  npx ts-node src/scripts/query.ts odds 17952170
  npx ts-node src/scripts/query.ts scores 17952170
  npx ts-node src/scripts/query.ts history 17952170
  npx ts-node src/scripts/query.ts stream scores
  npx ts-node src/scripts/query.ts stream odds
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd  = args[0];

  try {
    switch (cmd) {
      case "fixtures":
        await cmdFixtures(args.slice(1));
        break;

      case "odds": {
        const fid = args[1];
        if (!fid) { console.error("Error: fixtureId required\n"); printHelp(); process.exit(1); }
        await cmdOdds(fid);
        break;
      }

      case "scores": {
        const fid = args[1];
        if (!fid) { console.error("Error: fixtureId required\n"); printHelp(); process.exit(1); }
        await cmdScores(fid);
        break;
      }

      case "live": {
        const fid = args[1];
        if (!fid) { console.error("Error: fixtureId required\n"); printHelp(); process.exit(1); }
        await cmdLive(fid);
        break;
      }

      case "history": {
        const fid = args[1];
        if (!fid) { console.error("Error: fixtureId required\n"); printHelp(); process.exit(1); }
        await cmdHistory(fid);
        break;
      }

      case "stream": {
        const sub = args[1];
        if (sub === "scores") {
          await cmdStreamScores();
        } else if (sub === "odds") {
          await cmdStreamOdds();
        } else {
          console.error(`Unknown stream target: "${sub}". Use "scores" or "odds".`);
          process.exit(1);
        }
        break;
      }

      default:
        printHelp();
        if (cmd) {
          console.error(`Unknown command: "${cmd}"`);
          process.exit(1);
        }
        break;
    }
  } catch (err) {
    console.error("\n[Query] Error:", String(err));
    process.exit(1);
  }
}

main();
