-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260607_solana.sql
-- Day 7 — USDC Deposits + Solana Address Linking
--
-- Changes:
--   1. wallets.solana_address        — links a user's personal Solana wallet
--                                      for automatic deposit crediting
--   2. wallet_transactions.token_mint — stores SPL token mint address for
--                                      token (USDC) deposit transactions
--   3. Index on wallets.solana_address for fast deposit address lookup
--
-- Run in: Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Add solana_address to wallets ────────────────────────────────────────
-- TEXT UNIQUE — one Solana address per user, no duplicates across accounts.
-- NULL is allowed (not all users will link a Solana wallet).
ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS solana_address TEXT UNIQUE;

-- ─── 2. Add token_mint to wallet_transactions ─────────────────────────────────
-- Stores the SPL token mint address for token transfer deposits (e.g. USDC).
-- NULL for native SOL transactions.
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS token_mint TEXT;

-- ─── 3. Index on wallets.solana_address ──────────────────────────────────────
-- Fast lookup when a deposit arrives — find the user wallet by their Solana
-- public key without a full table scan.
CREATE INDEX IF NOT EXISTS idx_wallets_solana_address
  ON wallets (solana_address)
  WHERE solana_address IS NOT NULL;

-- ─── 4. Index on wallet_transactions.token_mint ───────────────────────────────
-- Useful for querying all USDC transactions or filtering by token type.
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_token_mint
  ON wallet_transactions (token_mint)
  WHERE token_mint IS NOT NULL;
