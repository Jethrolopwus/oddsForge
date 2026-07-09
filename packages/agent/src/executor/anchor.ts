/**
 * executor/anchor.ts
 *
 * Anchor Program Caller — wraps the on-chain `oddsforge-executor` program.
 *
 * Exposes two methods:
 *  - placeStake(decision)     → calls the place_stake instruction
 *  - settlePosition(...)      → calls the settle_position instruction
 *  - closePosition(...)       → calls the close_position instruction
 *
 * Returns the transaction signature string on success.
 *
 * The IDL is loaded from the Anchor build output at runtime so the TypeScript
 * agent doesn't need to manually replicate the account layouts.
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import type { TradeDecision } from "../engine/strategy";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaceStakeResult {
  /** Transaction signature */
  signature: string;
  /** On-chain PDA address (base58) */
  pdaAddress: string;
}

export interface AnchorExecutorConfig {
  /** Solana RPC endpoint */
  rpcUrl: string;
  /** Signer keypair (the agent wallet) */
  wallet: Keypair;
  /** Deployed program ID */
  programId: PublicKey;
  /** Commitment level (default: "confirmed") */
  commitment?: anchor.web3.Commitment;
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal IDL — inline so we don't depend on a build artifact at runtime.
// Keep in sync with lib.rs.
// ─────────────────────────────────────────────────────────────────────────────

// Anchor 0.31 IDL format:
//  - instructions use { name, discriminator, accounts, args }
//  - accounts array contains only { name, discriminator } — no embedded type
//  - full type definitions live in types[]
//  - discriminators are the first 8 bytes of sha256("global:<snake_case_name>")
const IDL = {
  address: "", // injected at runtime from config.programId
  metadata: { name: "oddsforge_executor", version: "0.1.0", spec: "0.1.0" },
  instructions: [
    {
      name: "placeStake",
      discriminator: [133, 210, 132, 56, 35, 234, 87, 234],
      accounts: [
        { name: "authority", writable: true, signer: true },
        { name: "position", writable: true },
        { name: "systemProgram" },
      ],
      args: [
        { name: "matchId", type: "string" },
        { name: "selection", type: "string" },
        { name: "oddsSnapshot", type: "f64" },
        { name: "stakeLamports", type: "u64" },
        { name: "signalScore", type: "u8" },
      ],
    },
    {
      name: "settlePosition",
      discriminator: [212, 28, 11, 164, 253, 189, 72, 155],
      accounts: [
        { name: "authority", writable: true, signer: true },
        { name: "position", writable: true },
      ],
      args: [{ name: "outcome", type: "string" }],
    },
    {
      name: "closePosition",
      discriminator: [123, 134, 59, 85, 229, 41, 210, 47],
      accounts: [
        { name: "authority", writable: true, signer: true },
        { name: "position", writable: true },
      ],
      args: [],
    },
  ],
  // In Anchor 0.31, accounts[] only holds name + discriminator.
  // The actual struct layout is declared in types[].
  accounts: [
    {
      name: "Position",
      discriminator: [170, 188, 143, 228, 122, 64, 247, 208],
    },
  ],
  errors: [
    { code: 6000, name: "SignalScoreTooLow", msg: "Signal score is below the minimum threshold of 60" },
    { code: 6001, name: "InvalidMatchId",    msg: "match_id is empty or exceeds 64 bytes" },
    { code: 6002, name: "InvalidSelection",  msg: "selection is empty or exceeds 32 bytes" },
    { code: 6003, name: "InvalidOdds",       msg: "odds_snapshot must be greater than 1.0" },
    { code: 6004, name: "InvalidStake",      msg: "stake_lamports must be greater than 0" },
    { code: 6005, name: "AlreadySettled",    msg: "Position has already been settled" },
    { code: 6006, name: "InvalidOutcome",    msg: "outcome must be 'won', 'lost', or 'voided'" },
    { code: 6007, name: "Unauthorized",      msg: "Signer is not the position authority" },
    { code: 6008, name: "PositionStillOpen", msg: "Cannot close an open position — settle it first" },
  ],
  types: [
    {
      name: "Position",
      type: {
        kind: "struct",
        fields: [
          { name: "authority", type: "pubkey" },
          { name: "matchId", type: "string" },
          { name: "selection", type: "string" },
          { name: "oddsSnapshot", type: "u64" },
          { name: "stakeLamports", type: "u64" },
          { name: "signalScore", type: "u8" },
          { name: "status", type: { defined: { name: "PositionStatus" } } },
          { name: "placedAt", type: "i64" },
          { name: "settledAt", type: "i64" },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "PositionStatus",
      type: {
        kind: "enum",
        variants: [
          { name: "Open" },
          { name: "Won" },
          { name: "Lost" },
          { name: "Voided" },
        ],
      },
    },
  ],
} as unknown as anchor.Idl;

// ─────────────────────────────────────────────────────────────────────────────
// AnchorExecutor
// ─────────────────────────────────────────────────────────────────────────────

export class AnchorExecutor {
  private readonly provider: anchor.AnchorProvider;
  private readonly program: anchor.Program;
  private readonly wallet: Keypair;
  private readonly programId: PublicKey;

  constructor(config: AnchorExecutorConfig) {
    this.wallet = config.wallet;
    this.programId = config.programId;

    const connection = new Connection(config.rpcUrl, config.commitment ?? "confirmed");
    const nodeWallet = new anchor.Wallet(config.wallet);
    this.provider = new anchor.AnchorProvider(connection, nodeWallet, {
      commitment: config.commitment ?? "confirmed",
      preflightCommitment: "confirmed",
    });

    // Anchor 0.31 reads the program ID exclusively from idl.address —
    // inject it at runtime so we don't hard-code it in the IDL constant.
    const idlWithAddress = { ...IDL, address: config.programId.toBase58() } as anchor.Idl;
    this.program = new anchor.Program(idlWithAddress, this.provider);
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Call `place_stake` on the Anchor program.
   *
   * The on-chain `match_id` field is the string representation of the TxLINE
   * i64 fixtureId — guaranteed ≤ 20 chars, well within the 64-byte limit.
   * The on-chain `selection` field maps to `decision.selectionName`.
   */
  async placeStake(decision: TradeDecision): Promise<PlaceStakeResult> {
    const [positionPDA] = this._derivePositionPDA(decision.fixtureId);

    const signature = await this.program.methods
      .placeStake(
        decision.fixtureId,       // on-chain match_id = TxLINE fixtureId string
        decision.selectionName,   // on-chain selection = normalised price name
        decision.oddsSnapshot,
        new anchor.BN(decision.stakeLamports),
        decision.signalScore
      )
      .accounts({
        authority: this.wallet.publicKey,
        position: positionPDA,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { signature, pdaAddress: positionPDA.toBase58() };
  }

  /**
   * Call `settle_position` on the Anchor program.
   * fixtureId is the TxLINE i64 fixture identifier as a string.
   * outcome must be "won", "lost", or "voided".
   */
  async settlePosition(
    fixtureId: string,
    outcome: "won" | "lost" | "voided"
  ): Promise<string> {
    const [positionPDA] = this._derivePositionPDA(fixtureId);

    const signature = await this.program.methods
      .settlePosition(outcome)
      .accounts({
        authority: this.wallet.publicKey,
        position: positionPDA,
      })
      .rpc();

    return signature;
  }

  /**
   * Call `close_position` to reclaim rent lamports.
   */
  async closePosition(fixtureId: string): Promise<string> {
    const [positionPDA] = this._derivePositionPDA(fixtureId);

    const signature = await this.program.methods
      .closePosition()
      .accounts({
        authority: this.wallet.publicKey,
        position: positionPDA,
      })
      .rpc();

    return signature;
  }

  /**
   * Build a `place_stake` instruction without sending it.
   * Used by the Jito bundle builder.
   */
  async buildPlaceStakeInstruction(
    decision: TradeDecision
  ): Promise<TransactionInstruction> {
    const [positionPDA] = this._derivePositionPDA(decision.fixtureId);

    return this.program.methods
      .placeStake(
        decision.fixtureId,
        decision.selectionName,
        decision.oddsSnapshot,
        new anchor.BN(decision.stakeLamports),
        decision.signalScore
      )
      .accounts({
        authority: this.wallet.publicKey,
        position: positionPDA,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** Derive the Position PDA for a given fixtureId and the agent wallet. */
  derivePositionPDA(fixtureId: string): PublicKey {
    const [pda] = this._derivePositionPDA(fixtureId);
    return pda;
  }

  /** Expose the underlying Connection for callers that need it. */
  get connection(): Connection {
    return this.provider.connection;
  }

  /** Expose the agent public key. */
  get publicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  private _derivePositionPDA(fixtureId: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        this.wallet.publicKey.toBuffer(),
        Buffer.from(fixtureId),
      ],
      this.programId
    );
  }
}
