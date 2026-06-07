# Migrations — MaintMentor.ai Agent API + Wallet + Data Flywheel

**Author:** Mack (CTO)  
**Created:** 2026-06-06  
**System:** Agent API, prepaid wallet, Solana payments, data flywheel  

---

## Overview

This directory contains database migrations for the Agent API + Wallet system. Migrations are written in plain SQL and designed to run against Supabase (PostgreSQL 15+).

**Migration naming convention:**

```
YYYYMMDD_NNN_description.sql
YYYYMMDD_NNN_description.rollback.sql
```

- `YYYYMMDD` — date the migration was authored
- `NNN` — sequence number (001, 002, ...) for same-day ordering
- `description` — short snake_case summary of what it does
- `.rollback.sql` — companion rollback file (required for every forward migration)

---

## Migration Files

| File | Purpose | Status |
|------|---------|--------|
| `20260606_001_agent_api_core.sql` | `api_keys`, `wallets`, `wallet_transactions`, `api_usage_logs`, `credit_packs`, `debit_wallet` RPC, `credit_wallet` RPC | Day 1 |
| `20260606_001_agent_api_core.rollback.sql` | Rollback for 001 | Day 1 |
| `20260606_002_solana.sql` | Solana columns on `wallets`, `solana_deposits` table | Day 1 |
| `20260606_002_solana.rollback.sql` | Rollback for 002 | Day 1 |
| `20260606_003_data_flywheel.sql` | `query_history`, `query_embeddings` (pgvector), `data_quality_flags`, RAG RPC | Day 1 |
| `20260606_003_data_flywheel.rollback.sql` | Rollback for 003 | Day 1 |

**Legacy migrations** (pre-Agent API, do not modify):

| File | Purpose |
|------|---------|
| `000-full-setup.sql` | Initial app schema |
| `001-security-tables.sql` | Security controls |
| `002-team-accounts.sql` | Organizations / team accounts |

---

## Prerequisites

### 1. psql client

```bash
# Ubuntu / Debian
sudo apt-get install postgresql-client

# macOS
brew install postgresql
```

### 2. Supabase database URL

Get it from: **Supabase Dashboard → Project Settings → Database → Connection String (URI)**

Add to your `.env` file:

```env
SUPABASE_DB_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

### 3. pgvector extension (required for migration 003)

Enable **before** running migration 003:

1. Go to **Supabase Dashboard → Extensions**
2. Search for `vector`
3. Enable it (one click, no downtime)

The runner script will warn you if pgvector is unavailable. Migrations 001 and 002 will still succeed without it.

---

## How to Run Migrations

### Run all forward migrations (in order)

```bash
cd /root/maintmentor-api
./migrations/run-migrations.sh
```

### Dry run (preview SQL, no changes)

```bash
./migrations/run-migrations.sh --dry-run
```

### Run from a custom environment file

```bash
SUPABASE_DB_URL='postgresql://...' ./migrations/run-migrations.sh
```

### Run a single migration manually (using psql)

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f migrations/20260606_001_agent_api_core.sql
```

---

## How to Roll Back

> ⚠️ **Rollbacks destroy data.** Only run on staging, or on production if you have a verified database backup/snapshot.

```bash
# Roll back migration 003 (data flywheel)
./migrations/run-migrations.sh --rollback 003

# Roll back migration 002 (Solana)
./migrations/run-migrations.sh --rollback 002

# Roll back migration 001 (core tables)
./migrations/run-migrations.sh --rollback 001
```

The runner will ask you to type `ROLLBACK` to confirm before executing.

### Rollback order matters

Roll back in reverse order of application:

```
003 → 002 → 001
```

Rolling back 001 while 002 or 003 are still applied will fail because of foreign key dependencies. The rollback files use `CASCADE` and `IF EXISTS` to handle partial states, but reverse order is still the correct approach.

### Manual rollback (using psql)

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f migrations/20260606_003_data_flywheel.rollback.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f migrations/20260606_002_solana.rollback.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f migrations/20260606_001_agent_api_core.rollback.sql
```

---

## Verification After Running

After each migration, run the verification queries embedded at the bottom of each SQL file. Example for migration 001:

```sql
-- Should return 5 rows
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('wallets','api_keys','api_usage_logs','wallet_transactions','credit_packs')
ORDER BY table_name;

-- Should return 3 packs (Starter, Pro, Scale)
SELECT name, price_cents, credits FROM credit_packs ORDER BY price_cents;
```

---

## Post-Migration Setup (required before first API call)

### 1. Set Stripe price IDs

After creating products/prices in Stripe Dashboard, update the seed data:

```sql
UPDATE credit_packs SET stripe_price_id = 'price_ACTUAL_STRIPE_ID' WHERE name = 'Starter';
UPDATE credit_packs SET stripe_price_id = 'price_ACTUAL_STRIPE_ID' WHERE name = 'Pro';
UPDATE credit_packs SET stripe_price_id = 'price_ACTUAL_STRIPE_ID' WHERE name = 'Scale';
```

### 2. Write RLS policies

The migrations create tables but do **not** set Row Level Security policies. RLS policies must be written and tested before the API goes live. See spec Section 13.1 — Schema Review Checklist.

Policies to write:
- `wallets`: users can only see their own wallet
- `api_keys`: users can only see/manage their own keys
- `wallet_transactions`: users can only see their own transactions
- `api_usage_logs`: users can only see their own logs
- `solana_deposits`: users can only see their own deposits
- `query_history`: service role only (no user-facing access)
- `credit_packs`: read-only for all authenticated users

### 3. Enable pg_cron for embedding worker (migration 003)

After migration 003 runs, schedule the embedding worker:

```sql
-- Schedule the embedding worker (runs every 60 seconds)
-- Replace the URL with your actual Edge Function URL
SELECT cron.schedule(
  'embed-worker',
  '* * * * *',
  $$SELECT net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/generate-embeddings',
    headers := '{"Authorization": "Bearer <service-key>"}',
    body := '{}'
  )$$
);

-- Schedule monthly data purge (1st of each month at 03:00 UTC)
SELECT cron.schedule(
  'purge-query-history',
  '0 3 1 * *',
  $$SELECT purge_old_query_history()$$
);
```

---

## Migration Naming Convention

```
YYYYMMDD_NNN_description.sql
```

Rules:
1. **Date prefix** — always the date the migration is authored (not when it runs)
2. **Sequence number** — three-digit zero-padded (001, 002, ...)
3. **Description** — snake_case, concise, describes what changes (not why)
4. **Companion rollback** — every `.sql` must have a `.rollback.sql` in the same directory
5. **Version in header** — every file starts with a header block documenting author, date, purpose, dependencies

Good examples:
- `20260610_001_add_rls_policies.sql`
- `20260615_001_add_webhook_events_table.sql`
- `20260620_001_add_query_history_indexes.sql`

---

## ⚠️ Golden Rule: Never Modify a Migration After It Runs in Production

Once a migration file has been executed against the production database, **it is immutable**. Do not edit it.

Why:
- Other developers may have already run it — editing it creates drift
- Rollback files correspond to a specific version of the forward migration
- Audit trail integrity — the file should match exactly what ran on the database

**If you need to change something after a migration has run:**
1. Write a new migration that makes the incremental change
2. Use the date of the new migration
3. Update the rollback file accordingly

The only exception: typo fixes in SQL comments (not in SQL statements) before the migration has been run in production.

---

## Emergency Contacts

If a migration fails in production:

1. **Do not panic.** All migrations are idempotent — re-running is safe.
2. Check the error output — Postgres error messages are descriptive.
3. If partial failure: check which tables were created (`\dt` in psql) and run the rollback for the affected migration.
4. If you need to roll back a migration that already has live traffic:
   - Revert the application code first (DigitalOcean → deploy previous version)
   - Then run the rollback SQL
   - Never roll back the DB while new application code is running against it

**Mack (CTO):** Direct escalation for any production database incident.  
**Winston (COO):** Required approval for any production migration — see spec Section 13.8.

---

*This README is part of the MaintMentor.ai Agent API + Wallet build.*  
*Full technical spec: `/root/.openclaw/workspace/c-suite/cto/agent-api-wallet-spec.md`*
