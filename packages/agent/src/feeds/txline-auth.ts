/**
 * feeds/txline-auth.ts
 *
 * TxLINE Authentication & Subscription Bootstrap.
 *
 * Implements the full TxLINE auth flow documented at:
 *   https://txline.txodds.com/documentation/worldcup
 *   https://txline.txodds.com/documentation/quickstart
 *
 * Flow:
 *  1. POST /auth/guest/start             → obtain guest JWT
 *  2. program.methods.subscribe(...)     → register wallet on-chain (free tier: no TxL cost)
 *  3. sign( `${txSig}:${leagues}:${jwt}` )
 *  4. POST /api/token/activate           → obtain API token
 *
 * The returned { jwt, apiToken } pair is passed as headers on all data requests:
 *   Authorization: Bearer <jwt>
 *   X-Api-Token:   <apiToken>
 *
 * Tokens expire — the caller should refresh before expiry using refreshAuth().
 * The TxLINE docs don't publish an exact TTL; the agent re-activates every
 * REFRESH_INTERVAL_MS (6 hours) as a safe default.
 */

import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import axios from "axios";
import nacl from "tweetnacl";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TxLineAuthConfig {
  /** "mainnet" | "devnet" */
  network: "mainnet" | "devnet";
  /** Agent signer keypair */
  wallet: Keypair;
  /**
   * Service level ID.
   *   1  = World Cup + Int Friendlies (60s delay) — FREE
   *   12 = World Cup + Int Friendlies real-time   — FREE on mainnet
   */
  serviceLevelId?: number;
  /**
   * Duration in weeks (must be a multiple of 4).
   * Default 4 (minimum allowed).
   */
  durationWeeks?: number;
}

export interface TxLineCredentials {
  jwt: string;
  apiToken: string;
  /** Millisecond timestamp when these credentials were activated */
  activatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const NETWORK_CONFIG = {
  mainnet: {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    apiOrigin: "https://txline.txodds.com",
    programId: new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
    txlTokenMint: new PublicKey("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"),
  },
  devnet: {
    rpcUrl: "https://api.devnet.solana.com",
    apiOrigin: "https://txline-dev.txodds.com",
    programId: new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
    txlTokenMint: new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
  },
} as const;

/** Re-activate every 6 hours to stay ahead of token expiry */
export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Standard bundle — no specific league IDs needed for World Cup free tier */
const SELECTED_LEAGUES: number[] = [];

// Minimal TxOracle IDL — only the `subscribe` instruction is needed here.
// Full IDL at: https://github.com/txodds/tx-on-chain/blob/main/idl/txoracle.json
const TXORACLE_IDL = {
  address: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
  metadata: { name: "txoracle", version: "1.5.5", spec: "0.1.0" },
  instructions: [
    {
      name: "subscribe",
      discriminator: [254, 28, 191, 138, 156, 179, 183, 53],
      accounts: [
        { name: "user", writable: true, signer: true },
        { name: "pricingMatrix" },
        { name: "tokenMint" },
        { name: "userTokenAccount", writable: true },
        { name: "tokenTreasuryVault", writable: true },
        { name: "tokenTreasuryPda" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
        { name: "associatedTokenProgram" },
      ],
      args: [
        { name: "serviceLevelId", type: "u16" },
        { name: "weeks", type: "u8" },
      ],
    },
  ],
  accounts: [],
  errors: [],
  types: [],
} as unknown as anchor.Idl;

// ─────────────────────────────────────────────────────────────────────────────
// TxLineAuth
// ─────────────────────────────────────────────────────────────────────────────

export class TxLineAuth {
  private readonly cfg: Required<TxLineAuthConfig>;
  private readonly netCfg: (typeof NETWORK_CONFIG)["mainnet" | "devnet"];
  private readonly connection: Connection;
  private readonly provider: anchor.AnchorProvider;
  private readonly program: anchor.Program;

  constructor(config: TxLineAuthConfig) {
    this.cfg = {
      serviceLevelId: 12, // default: real-time World Cup free tier
      durationWeeks: 4,
      ...config,
    };

    this.netCfg = NETWORK_CONFIG[this.cfg.network];
    this.connection = new Connection(this.netCfg.rpcUrl, "confirmed");

    const nodeWallet = new anchor.Wallet(this.cfg.wallet);
    this.provider = new anchor.AnchorProvider(this.connection, nodeWallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(this.provider);

    // Use the program ID from the selected network, regardless of IDL address field
    this.program = new anchor.Program(TXORACLE_IDL, this.netCfg.programId, this.provider);
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Run the full auth flow:
   *  1. Get guest JWT
   *  2. Subscribe on-chain (free tier — no TxL payment needed)
   *  3. Sign + activate API token
   *
   * Returns credentials ready to use as HTTP headers.
   */
  async activate(): Promise<TxLineCredentials> {
    console.log(
      `[TxLINE Auth] Activating | network=${this.cfg.network}` +
        ` serviceLevel=${this.cfg.serviceLevelId} weeks=${this.cfg.durationWeeks}`
    );

    // Step 1: guest JWT
    const jwt = await this._getGuestJwt();
    console.log("[TxLINE Auth] Guest JWT obtained");

    // Step 2: on-chain subscription
    const txSig = await this._subscribeOnChain();
    console.log(`[TxLINE Auth] Subscription tx: ${txSig}`);

    // Step 3: sign + activate
    const apiToken = await this._activateToken(jwt, txSig);
    console.log("[TxLINE Auth] API token activated");

    return { jwt, apiToken, activatedAt: Date.now() };
  }

  /**
   * Refresh only the JWT and API token without re-subscribing on-chain.
   * Use this if the subscription is still valid but the token has expired.
   *
   * Note: if on-chain subscription has lapsed, call activate() instead.
   */
  async refreshToken(existingTxSig: string): Promise<TxLineCredentials> {
    const jwt = await this._getGuestJwt();
    const apiToken = await this._activateToken(jwt, existingTxSig);
    console.log("[TxLINE Auth] Token refreshed");
    return { jwt, apiToken, activatedAt: Date.now() };
  }

  /** Returns the configured API origin (e.g. https://txline.txodds.com) */
  get apiOrigin(): string {
    return this.netCfg.apiOrigin;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  private async _getGuestJwt(): Promise<string> {
    const response = await axios.post<{ token: string }>(
      `${this.netCfg.apiOrigin}/auth/guest/start`
    );
    const token = response.data?.token;
    if (!token) {
      throw new Error("[TxLINE Auth] Guest JWT response missing token field");
    }
    return token;
  }

  private async _subscribeOnChain(): Promise<string> {
    const { programId, txlTokenMint } = this.netCfg;

    const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_treasury_v2")],
      programId
    );

    const tokenTreasuryVault = getAssociatedTokenAddressSync(
      txlTokenMint,
      tokenTreasuryPda,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pricing_matrix")],
      programId
    );

    const userTokenAccount = getAssociatedTokenAddressSync(
      txlTokenMint,
      this.cfg.wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const txSig = await this.program.methods
      .subscribe(this.cfg.serviceLevelId, this.cfg.durationWeeks)
      .accounts({
        user: this.cfg.wallet.publicKey,
        pricingMatrix: pricingMatrixPda,
        tokenMint: txlTokenMint,
        userTokenAccount,
        tokenTreasuryVault,
        tokenTreasuryPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return txSig;
  }

  private async _activateToken(jwt: string, txSig: string): Promise<string> {
    // Message to sign: "${txSig}:${leagues.join(",")}:${jwt}"
    // For empty SELECTED_LEAGUES this becomes "${txSig}::${jwt}"
    const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
    const messageBytes = new TextEncoder().encode(messageString);

    // Sign with the wallet's secret key using tweetnacl
    const signatureBytes = nacl.sign.detached(messageBytes, this.cfg.wallet.secretKey);
    const walletSignature = Buffer.from(signatureBytes).toString("base64");

    const response = await axios.post<{ token?: string } | string>(
      `${this.netCfg.apiOrigin}/api/token/activate`,
      {
        txSig,
        walletSignature,
        leagues: SELECTED_LEAGUES,
      },
      {
        headers: { Authorization: `Bearer ${jwt}` },
      }
    );

    // Response is either { token: "..." } or the token string directly
    const data = response.data;
    const apiToken =
      typeof data === "string"
        ? data
        : (data as { token?: string }).token;

    if (!apiToken) {
      throw new Error(
        `[TxLINE Auth] Activation response missing token: ${JSON.stringify(data)}`
      );
    }

    return apiToken;
  }
}
