use anchor_lang::prelude::*;

declare_id!("7NeF1c8RMvLzM7qDgcroJ3PmmTbQpWCCaAw2dWHYfAwL");

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Minimum signal score required to place a stake (0–100 scale).
pub const MIN_SIGNAL_SCORE: u8 = 60;

/// Maximum match-id string byte length (stored inside the PDA).
pub const MAX_MATCH_ID_LEN: usize = 64;

/// Maximum selection label length (e.g. "home_win", "draw", "away_win").
pub const MAX_SELECTION_LEN: usize = 32;

/// Space reserved for the Position account:
///   discriminator    8
///   authority        32
///   match_id         4 + 64
///   selection        4 + 32
///   odds_snapshot    8  (f64 as u64 bits)
///   stake_lamports   8
///   signal_score     1
///   status           1
///   placed_at        8  (i64 unix timestamp)
///   settled_at       8  (i64 unix timestamp, 0 = not settled)
///   bump             1
pub const POSITION_SPACE: usize = 8 + 32 + (4 + 64) + (4 + 32) + 8 + 8 + 1 + 1 + 8 + 8 + 1;

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum PositionStatus {
    /// Position has been placed on-chain; awaiting settlement.
    Open,
    /// Match concluded — position was a winner.
    Won,
    /// Match concluded — position was a loser.
    Lost,
    /// Position was voided / cancelled (e.g. abandoned match).
    Voided,
}

impl Default for PositionStatus {
    fn default() -> Self {
        PositionStatus::Open
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// State account
// ─────────────────────────────────────────────────────────────────────────────

/// PDA: seeds = [b"position", authority.key, match_id.as_bytes()]
#[account]
#[derive(Default)]
pub struct Position {
    /// Wallet that placed (and can settle) this position.
    pub authority: Pubkey,
    /// TxODDS match identifier (e.g. "wc2026_esp_fra_20260714").
    pub match_id: String,
    /// Selection placed (e.g. "home_win", "draw", "away_win").
    pub selection: String,
    /// Decimal odds at the moment of placement (stored as raw f64 bits).
    pub odds_snapshot: u64,
    /// Stake in lamports.
    pub stake_lamports: u64,
    /// Signal confidence score (0–100) that triggered this position.
    pub signal_score: u8,
    /// Current lifecycle status of the position.
    pub status: PositionStatus,
    /// Unix timestamp when the position was placed.
    pub placed_at: i64,
    /// Unix timestamp when the position was settled (0 if still open).
    pub settled_at: i64,
    /// PDA bump seed.
    pub bump: u8,
}

// ─────────────────────────────────────────────────────────────────────────────
// Program
// ─────────────────────────────────────────────────────────────────────────────

#[program]
pub mod oddsforge_executor {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────────
    // place_stake
    // ─────────────────────────────────────────────────────────────────────────

    /// Record an on-chain position for a live match.
    ///
    /// The instruction:
    ///   1. Validates signal_score ≥ MIN_SIGNAL_SCORE.
    ///   2. Validates match_id / selection are non-empty and within length bounds.
    ///   3. Validates odds_snapshot > 1.0 (decimal odds must be positive).
    ///   4. Validates stake_lamports > 0.
    ///   5. Initialises the Position PDA and writes all fields.
    pub fn place_stake(
        ctx: Context<PlaceStake>,
        match_id: String,
        selection: String,
        odds_snapshot: f64,
        stake_lamports: u64,
        signal_score: u8,
    ) -> Result<()> {
        // ── validation ────────────────────────────────────────────────────────
        require!(
            signal_score >= MIN_SIGNAL_SCORE,
            OddsForgeError::SignalScoreTooLow
        );
        require!(
            !match_id.is_empty() && match_id.len() <= MAX_MATCH_ID_LEN,
            OddsForgeError::InvalidMatchId
        );
        require!(
            !selection.is_empty() && selection.len() <= MAX_SELECTION_LEN,
            OddsForgeError::InvalidSelection
        );
        require!(odds_snapshot > 1.0, OddsForgeError::InvalidOdds);
        require!(stake_lamports > 0, OddsForgeError::InvalidStake);

        // ── write state ───────────────────────────────────────────────────────
        let position = &mut ctx.accounts.position;
        let clock = Clock::get()?;

        position.authority = ctx.accounts.authority.key();
        position.match_id = match_id.clone();
        position.selection = selection.clone();
        position.odds_snapshot = odds_snapshot.to_bits();
        position.stake_lamports = stake_lamports;
        position.signal_score = signal_score;
        position.status = PositionStatus::Open;
        position.placed_at = clock.unix_timestamp;
        position.settled_at = 0;
        position.bump = ctx.bumps.position;

        msg!(
            "OddsForge | position opened | match={} sel={} odds={:.4} stake={} score={}",
            match_id,
            selection,
            odds_snapshot,
            stake_lamports,
            signal_score
        );

        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────────
    // settle_position
    // ─────────────────────────────────────────────────────────────────────────

    /// Settle an existing open position after the match concludes.
    ///
    /// Only the original `authority` may settle their own position.
    /// `outcome` must be "won", "lost", or "voided" (case-insensitive).
    pub fn settle_position(ctx: Context<SettlePosition>, outcome: String) -> Result<()> {
        let position = &mut ctx.accounts.position;

        // Must be open to settle
        require!(
            position.status == PositionStatus::Open,
            OddsForgeError::AlreadySettled
        );

        // Parse outcome string → enum
        let status = match outcome.to_lowercase().as_str() {
            "won" => PositionStatus::Won,
            "lost" => PositionStatus::Lost,
            "voided" => PositionStatus::Voided,
            _ => return err!(OddsForgeError::InvalidOutcome),
        };

        let clock = Clock::get()?;
        position.status = status.clone();
        position.settled_at = clock.unix_timestamp;

        msg!(
            "OddsForge | position settled | match={} sel={} outcome={:?}",
            position.match_id,
            position.selection,
            status
        );

        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────────
    // close_position
    // ─────────────────────────────────────────────────────────────────────────

    /// Reclaim rent lamports from a settled or voided position.
    ///
    /// Only the original authority may close their own account.
    pub fn close_position(_ctx: Context<ClosePosition>) -> Result<()> {
        // ClosePosition constraint `close = authority` handles the lamport
        // transfer automatically; nothing extra needed here.
        msg!("OddsForge | position account closed, rent reclaimed");
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Account contexts
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(match_id: String)]
pub struct PlaceStake<'info> {
    /// Signer paying for the new account + submitting the position.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Position PDA — created fresh for each (authority, match_id) pair.
    ///
    /// Using `match_id` as part of the seed means the agent can have one
    /// on-chain position per match per wallet at a time.
    #[account(
        init,
        payer = authority,
        space = POSITION_SPACE,
        seeds = [b"position", authority.key().as_ref(), match_id.as_bytes()],
        bump
    )]
    pub position: Account<'info, Position>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettlePosition<'info> {
    /// The wallet that originally placed this position.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The position PDA being settled.
    #[account(
        mut,
        seeds = [b"position", authority.key().as_ref(), position.match_id.as_bytes()],
        bump = position.bump,
        has_one = authority @ OddsForgeError::Unauthorized
    )]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    /// The wallet that originally placed this position (receives reclaimed rent).
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The position PDA to close.  Must be settled or voided before closing.
    #[account(
        mut,
        seeds = [b"position", authority.key().as_ref(), position.match_id.as_bytes()],
        bump = position.bump,
        has_one = authority @ OddsForgeError::Unauthorized,
        constraint = position.status != PositionStatus::Open @ OddsForgeError::PositionStillOpen,
        close = authority
    )]
    pub position: Account<'info, Position>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum OddsForgeError {
    #[msg("Signal score is below the minimum threshold of 60")]
    SignalScoreTooLow,

    #[msg("match_id is empty or exceeds 64 bytes")]
    InvalidMatchId,

    #[msg("selection is empty or exceeds 32 bytes")]
    InvalidSelection,

    #[msg("odds_snapshot must be greater than 1.0")]
    InvalidOdds,

    #[msg("stake_lamports must be greater than 0")]
    InvalidStake,

    #[msg("Position has already been settled")]
    AlreadySettled,

    #[msg("outcome must be 'won', 'lost', or 'voided'")]
    InvalidOutcome,

    #[msg("Signer is not the position authority")]
    Unauthorized,

    #[msg("Cannot close an open position — settle it first")]
    PositionStillOpen,
}
