/**
 * OddsForge Executor — Anchor Program Tests
 *
 * Coverage:
 *  ✓ place_stake   — happy path
 *  ✓ place_stake   — signal score too low
 *  ✓ place_stake   — invalid odds (≤ 1.0)
 *  ✓ place_stake   — empty match_id
 *  ✓ place_stake   — zero stake
 *  ✓ settle_position — won
 *  ✓ settle_position — lost
 *  ✓ settle_position — voided
 *  ✓ settle_position — invalid outcome string
 *  ✓ settle_position — already settled (double-settle)
 *  ✓ close_position  — after settlement
 *  ✓ close_position  — rejected when still open
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN, AnchorError } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert, expect } from "chai";
import { OddsforgeExecutor } from "../target/types/oddsforge_executor";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Derive the Position PDA for a given authority + match_id. */
function derivePositionPDA(
  programId: PublicKey,
  authority: PublicKey,
  matchId: string
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), authority.toBuffer(), Buffer.from(matchId)],
    programId
  );
}

/** Airdrop SOL to a keypair and wait for confirmation. */
async function fundKeypair(
  connection: anchor.web3.Connection,
  kp: Keypair,
  sol = 2
): Promise<void> {
  const sig = await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
}

/** Assert a transaction rejects with the given Anchor error code. */
async function assertAnchorError(
  promise: Promise<unknown>,
  errorCode: string
): Promise<void> {
  try {
    await promise;
    assert.fail(`Expected error "${errorCode}" but transaction succeeded`);
  } catch (err: unknown) {
    if (err instanceof AnchorError) {
      expect(err.error.errorCode.code).to.equal(errorCode);
    } else if (err instanceof Error) {
      // Generic SDK errors (e.g. account constraint violations) — surface the message.
      expect(err.message, `Expected "${errorCode}" in error`).to.include(errorCode);
    } else {
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("oddsforge-executor", () => {
  // ── provider / program setup ────────────────────────────────────────────────
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.OddsforgeExecutor as Program<OddsforgeExecutor>;
  const connection = provider.connection;

  // ── reusable test fixtures ───────────────────────────────────────────────────
  const MATCH_ID = "wc2026_esp_fra_20260714";
  const SELECTION = "home_win";
  const ODDS = 2.15;
  const STAKE = new BN(0.05 * LAMPORTS_PER_SOL); // 0.05 SOL
  const SIGNAL = 75;

  let authority: Keypair;
  let positionPDA: PublicKey;
  let positionBump: number;

  // Fund a fresh authority before each top-level describe block.
  before(async () => {
    authority = Keypair.generate();
    await fundKeypair(connection, authority, 2);
    [positionPDA, positionBump] = derivePositionPDA(program.programId, authority.publicKey, MATCH_ID);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // place_stake
  // ─────────────────────────────────────────────────────────────────────────

  describe("place_stake", () => {
    it("creates a Position PDA with correct state on happy path", async () => {
      const tx = await program.methods
        .placeStake(MATCH_ID, SELECTION, ODDS, STAKE, SIGNAL)
        .accounts({
          authority: authority.publicKey,
          position: positionPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      console.log("  place_stake tx:", tx);

      const pos = await program.account.position.fetch(positionPDA);

      assert.strictEqual(pos.authority.toBase58(), authority.publicKey.toBase58());
      assert.strictEqual(pos.matchId, MATCH_ID);
      assert.strictEqual(pos.selection, SELECTION);
      assert.strictEqual(pos.signalScore, SIGNAL);
      assert.strictEqual(pos.stakeLamports.toNumber(), STAKE.toNumber());
      // odds stored as f64 bits — reconstruct and compare with tolerance
      const storedOdds = Buffer.from(pos.oddsSnapshot.toArray("le", 8)).readDoubleLe(0);
      expect(storedOdds).to.be.approximately(ODDS, 1e-9);
      assert.deepEqual(pos.status, { open: {} });
      assert.isAbove(pos.placedAt.toNumber(), 0);
      assert.strictEqual(pos.settledAt.toNumber(), 0);
      assert.strictEqual(pos.bump, positionBump);
    });

    it("rejects signal score below 60", async () => {
      const [pda] = derivePositionPDA(program.programId, authority.publicKey, "reject_low_score");
      await assertAnchorError(
        program.methods
          .placeStake("reject_low_score", SELECTION, ODDS, STAKE, 59)
          .accounts({
            authority: authority.publicKey,
            position: pda,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc(),
        "SignalScoreTooLow"
      );
    });

    it("rejects empty match_id", async () => {
      const [pda] = derivePositionPDA(program.programId, authority.publicKey, "");
      await assertAnchorError(
        program.methods
          .placeStake("", SELECTION, ODDS, STAKE, SIGNAL)
          .accounts({
            authority: authority.publicKey,
            position: pda,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc(),
        "InvalidMatchId"
      );
    });

    it("rejects odds <= 1.0", async () => {
      const [pda] = derivePositionPDA(program.programId, authority.publicKey, "reject_odds");
      await assertAnchorError(
        program.methods
          .placeStake("reject_odds", SELECTION, 1.0, STAKE, SIGNAL)
          .accounts({
            authority: authority.publicKey,
            position: pda,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc(),
        "InvalidOdds"
      );
    });

    it("rejects zero stake", async () => {
      const [pda] = derivePositionPDA(program.programId, authority.publicKey, "reject_zero_stake");
      await assertAnchorError(
        program.methods
          .placeStake("reject_zero_stake", SELECTION, ODDS, new BN(0), SIGNAL)
          .accounts({
            authority: authority.publicKey,
            position: pda,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc(),
        "InvalidStake"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // settle_position
  // ─────────────────────────────────────────────────────────────────────────

  describe("settle_position", () => {
    // These tests share the position opened in the place_stake happy-path test.

    it("settles to Won", async () => {
      const tx = await program.methods
        .settlePosition("won")
        .accounts({
          authority: authority.publicKey,
          position: positionPDA,
        })
        .signers([authority])
        .rpc();

      console.log("  settle_position (won) tx:", tx);

      const pos = await program.account.position.fetch(positionPDA);
      assert.deepEqual(pos.status, { won: {} });
      assert.isAbove(pos.settledAt.toNumber(), 0);
    });

    it("rejects double-settle", async () => {
      await assertAnchorError(
        program.methods
          .settlePosition("lost")
          .accounts({
            authority: authority.publicKey,
            position: positionPDA,
          })
          .signers([authority])
          .rpc(),
        "AlreadySettled"
      );
    });

    it("settles a fresh position to Lost", async () => {
      const matchId = "wc2026_ger_bra_20260715";
      const [pda] = derivePositionPDA(program.programId, authority.publicKey, matchId);

      await program.methods
        .placeStake(matchId, "away_win", 3.4, new BN(0.02 * LAMPORTS_PER_SOL), 80)
        .accounts({
          authority: authority.publicKey,
          position: pda,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      await program.methods
        .settlePosition("lost")
        .accounts({ authority: authority.publicKey, position: pda })
        .signers([authority])
        .rpc();

      const pos = await program.account.position.fetch(pda);
      assert.deepEqual(pos.status, { lost: {} });
    });

    it("settles a fresh position to Voided", async () => {
      const matchId = "wc2026_jpn_mor_voided";
      const [pda] = derivePositionPDA(program.programId, authority.publicKey, matchId);

      await program.methods
        .placeStake(matchId, "draw", 3.1, new BN(0.01 * LAMPORTS_PER_SOL), 65)
        .accounts({
          authority: authority.publicKey,
          position: pda,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      await program.methods
        .settlePosition("voided")
        .accounts({ authority: authority.publicKey, position: pda })
        .signers([authority])
        .rpc();

      const pos = await program.account.position.fetch(pda);
      assert.deepEqual(pos.status, { voided: {} });
    });

    it("rejects an invalid outcome string", async () => {
      const matchId = "wc2026_invalid_outcome";
      const [pda] = derivePositionPDA(program.programId, authority.publicKey, matchId);

      await program.methods
        .placeStake(matchId, "home_win", 2.0, new BN(0.01 * LAMPORTS_PER_SOL), 70)
        .accounts({
          authority: authority.publicKey,
          position: pda,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      await assertAnchorError(
        program.methods
          .settlePosition("cancelled")
          .accounts({ authority: authority.publicKey, position: pda })
          .signers([authority])
          .rpc(),
        "InvalidOutcome"
      );
    });

    it("rejects settle by non-authority", async () => {
      // Open a new position with `authority`
      const matchId = "wc2026_unauth_settle";
      const [pda] = derivePositionPDA(program.programId, authority.publicKey, matchId);

      await program.methods
        .placeStake(matchId, "home_win", 1.9, new BN(0.01 * LAMPORTS_PER_SOL), 70)
        .accounts({
          authority: authority.publicKey,
          position: pda,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      // Try to settle with a different signer
      const rogue = Keypair.generate();
      await fundKeypair(connection, rogue, 1);

      try {
        await program.methods
          .settlePosition("won")
          .accounts({ authority: rogue.publicKey, position: pda })
          .signers([rogue])
          .rpc();
        assert.fail("Expected unauthorized settle to fail");
      } catch (err: unknown) {
        // Either a constraint error or seeds mismatch — both are acceptable rejections.
        assert.ok(err instanceof Error, "Expected an error");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // close_position
  // ─────────────────────────────────────────────────────────────────────────

  describe("close_position", () => {
    it("closes a settled position and reclaims rent", async () => {
      const balanceBefore = await connection.getBalance(authority.publicKey);

      const tx = await program.methods
        .closePosition()
        .accounts({
          authority: authority.publicKey,
          position: positionPDA,
        })
        .signers([authority])
        .rpc();

      console.log("  close_position tx:", tx);

      // Account should no longer exist
      const acc = await connection.getAccountInfo(positionPDA);
      assert.isNull(acc, "Position account should be closed");

      // Authority balance should increase (minus tx fees)
      const balanceAfter = await connection.getBalance(authority.publicKey);
      assert.isAbove(balanceAfter, balanceBefore - 5000 /* fee tolerance */);
    });

    it("rejects closing an open position", async () => {
      const matchId = "wc2026_open_close_reject";
      const [pda] = derivePositionPDA(program.programId, authority.publicKey, matchId);

      await program.methods
        .placeStake(matchId, "home_win", 2.5, new BN(0.01 * LAMPORTS_PER_SOL), 62)
        .accounts({
          authority: authority.publicKey,
          position: pda,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      await assertAnchorError(
        program.methods
          .closePosition()
          .accounts({ authority: authority.publicKey, position: pda })
          .signers([authority])
          .rpc(),
        "PositionStillOpen"
      );
    });
  });
});
