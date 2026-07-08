/**
 * executor/jito.ts
 *
 * Jito Bundle Builder — submits Solana transactions as Jito MEV bundles for
 * priority landing and reduced failed-transaction rates.
 *
 * Flow:
 *  1. Compose the payload transaction(s) from the provided instructions.
 *  2. Build a tip instruction (SOL transfer to a random Jito tip account).
 *  3. Sign all transactions.
 *  4. Submit the bundle to the Jito Block Engine via the REST bundle API.
 *  5. Poll for bundle confirmation.
 *
 * References:
 *  https://jito-labs.gitbook.io/mev/searcher-resources/bundles
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import type { TradeDecision } from "../engine/strategy";
import type { AnchorExecutor } from "./anchor";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface JitoBundleConfig {
  /** Jito Block Engine endpoint URL */
  blockEngineUrl: string;
  /** Agent signer keypair */
  wallet: Keypair;
  /** Established Solana connection (shared with AnchorExecutor) */
  connection: Connection;
  /**
   * Tip in lamports paid to Jito per bundle.
   * Minimum is ~1000 lamports; 100_000 (0.0001 SOL) gives competitive priority.
   */
  tipLamports?: number;
}

export interface BundleResult {
  /** Jito bundle UUID */
  bundleId: string;
  /** Transaction signatures included in the bundle */
  signatures: string[];
  /** Final status returned by the Block Engine */
  status: "accepted" | "finalized" | "failed" | "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Jito tip accounts (sampled at random per bundle to spread load)
// Source: https://jito-labs.gitbook.io/mev/searcher-resources/tip-accounts
// ─────────────────────────────────────────────────────────────────────────────

const JITO_TIP_ACCOUNTS: PublicKey[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
].map((addr) => new PublicKey(addr));

function randomTipAccount(): PublicKey {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// JitoExecutor
// ─────────────────────────────────────────────────────────────────────────────

export class JitoExecutor {
  private readonly cfg: Required<JitoBundleConfig>;

  constructor(config: JitoBundleConfig) {
    this.cfg = {
      tipLamports: 100_000, // 0.0001 SOL default tip
      ...config,
    };
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Execute a trade decision as a Jito bundle.
   *
   * 1. Builds the place_stake instruction via AnchorExecutor.
   * 2. Adds a tip instruction to a random Jito tip account.
   * 3. Signs and submits the bundle.
   * 4. Returns bundle result with status.
   */
  async executeDecision(
    decision: TradeDecision,
    anchorExecutor: AnchorExecutor
  ): Promise<BundleResult> {
    // Build the payload instruction
    const stakeIx = await anchorExecutor.buildPlaceStakeInstruction(decision);

    // Build the tip instruction (must be included in the bundle)
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.cfg.wallet.publicKey,
      toPubkey: randomTipAccount(),
      lamports: this.cfg.tipLamports,
    });

    // Compose both into a single transaction
    const tx = await this._buildTransaction([stakeIx, tipIx]);

    const signature = await this._signAndSubmit(tx);

    // Submit as a Jito bundle
    const bundleResult = await this._submitBundle([tx], [signature]);

    return bundleResult;
  }

  /**
   * Submit raw pre-built transactions as a Jito bundle.
   * Useful if the caller needs to compose multi-instruction bundles.
   */
  async submitBundle(
    transactions: Transaction[],
    signatures: string[]
  ): Promise<BundleResult> {
    return this._submitBundle(transactions, signatures);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async _buildTransaction(
    instructions: TransactionInstruction[]
  ): Promise<Transaction> {
    const { blockhash, lastValidBlockHeight } =
      await this.cfg.connection.getLatestBlockhash("confirmed");

    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = this.cfg.wallet.publicKey;
    tx.add(...instructions);
    return tx;
  }

  private async _signAndSubmit(tx: Transaction): Promise<string> {
    tx.sign(this.cfg.wallet);
    const rawTx = tx.serialize();

    const signature = await this.cfg.connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    return signature;
  }

  /**
   * Submit serialised transactions to the Jito Block Engine REST API.
   *
   * POST /api/v1/bundles
   * Body: { jsonrpc: "2.0", method: "sendBundle", params: [[base64tx, ...]] }
   */
  private async _submitBundle(
    transactions: Transaction[],
    signatures: string[]
  ): Promise<BundleResult> {
    const serialisedTxs = transactions.map((tx) =>
      Buffer.from(tx.serialize()).toString("base64")
    );

    const bundleEndpoint = `${this.cfg.blockEngineUrl}/api/v1/bundles`;

    const requestBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [serialisedTxs],
    });

    let bundleId = "unknown";
    let status: BundleResult["status"] = "unknown";

    try {
      const response = await fetch(bundleEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Jito bundle submission failed: HTTP ${response.status} — ${errorText}`
        );
      }

      const json = (await response.json()) as { result?: string; error?: unknown };

      if (json.error) {
        throw new Error(`Jito RPC error: ${JSON.stringify(json.error)}`);
      }

      bundleId = json.result ?? "unknown";
      status = "accepted";

      console.log(
        `[Jito] Bundle submitted | bundleId=${bundleId} txs=${signatures.length}`
      );

      // Poll for finalization
      status = await this._pollBundleStatus(bundleId);
    } catch (err) {
      console.error(`[Jito] Bundle error: ${String(err)}`);
      status = "failed";
    }

    return { bundleId, signatures, status };
  }

  /**
   * Poll the Jito Block Engine for bundle status.
   * Times out after 60 seconds.
   */
  private async _pollBundleStatus(
    bundleId: string,
    maxAttempts = 12,
    intervalMs = 5_000
  ): Promise<BundleResult["status"]> {
    const statusEndpoint = `${this.cfg.blockEngineUrl}/api/v1/bundles`;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));

      try {
        const response = await fetch(statusEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getBundleStatuses",
            params: [[bundleId]],
          }),
        });

        if (!response.ok) continue;

        const json = (await response.json()) as {
          result?: { value?: Array<{ confirmation_status?: string; err?: unknown }> };
        };

        const entry = json.result?.value?.[0];
        if (!entry) continue;

        if (entry.err) {
          console.warn(`[Jito] Bundle error on-chain: ${JSON.stringify(entry.err)}`);
          return "failed";
        }

        const confirmStatus = entry.confirmation_status;
        if (confirmStatus === "finalized") {
          console.log(`[Jito] Bundle finalized | bundleId=${bundleId}`);
          return "finalized";
        }

        console.log(`[Jito] Bundle status=${confirmStatus} attempt=${i + 1}/${maxAttempts}`);
      } catch (err) {
        console.warn(`[Jito] Poll error: ${String(err)}`);
      }
    }

    console.warn(`[Jito] Bundle timed out waiting for finalization | bundleId=${bundleId}`);
    return "unknown";
  }
}
