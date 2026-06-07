#!/usr/bin/env bash
# =============================================================================
# run-migrations.sh
# MaintMentor.ai — Agent API + Wallet + Data Flywheel Migrations
# Author: Mack (CTO)
# Date:   2026-06-06
#
# Runs the three Agent API migrations in order against Supabase.
# Reads credentials from ../.env (relative to this script's directory).
# Stops immediately on first error.
#
# Usage:
#   ./migrations/run-migrations.sh                    # Run all forward migrations
#   ./migrations/run-migrations.sh --dry-run          # Print SQL, do not execute
#   ./migrations/run-migrations.sh --rollback 001     # Roll back migration 001
#   ./migrations/run-migrations.sh --rollback 002     # Roll back migration 002
#   ./migrations/run-migrations.sh --rollback 003     # Roll back migration 003
#
# Requirements:
#   - psql must be installed (brew install postgresql or apt-get install postgresql-client)
#   - SUPABASE_URL and SUPABASE_SERVICE_KEY must be in ../.env
#   - pgvector extension must be enabled in Supabase Dashboard before running migration 003
#
# =============================================================================

set -euo pipefail

# ── Resolve script directory (works even if called from another directory) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"
MIGRATIONS_DIR="$SCRIPT_DIR"

# ── Logging helpers ──────────────────────────────────────────────────────────
log()    { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*"; }
ok()     { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] ✅  $*"; }
warn()   { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] ⚠️   $*" >&2; }
err()    { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] ❌  $*" >&2; }
header() { echo ""; echo "═══════════════════════════════════════════════════════"; echo "  $*"; echo "═══════════════════════════════════════════════════════"; }

# ── Parse arguments ──────────────────────────────────────────────────────────
DRY_RUN=false
ROLLBACK_TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --rollback)
      if [[ -z "${2:-}" ]]; then
        err "--rollback requires a migration number (001, 002, or 003)"
        exit 1
      fi
      ROLLBACK_TARGET="$2"
      shift 2
      ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      err "Use --help for usage."
      exit 1
      ;;
  esac
done

# ── Load .env ────────────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  err "Missing .env file at: $ENV_FILE"
  err "Copy .env.example to .env and fill in SUPABASE_URL and SUPABASE_SERVICE_KEY."
  exit 1
fi

# Export only the vars we need, without sourcing the whole file (safer)
SUPABASE_URL=$(grep -E '^SUPABASE_URL=' "$ENV_FILE" | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
SUPABASE_SERVICE_KEY=$(grep -E '^SUPABASE_SERVICE_KEY=' "$ENV_FILE" | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")

if [[ -z "$SUPABASE_URL" ]]; then
  err "SUPABASE_URL not found in $ENV_FILE"
  exit 1
fi

if [[ -z "$SUPABASE_SERVICE_KEY" ]]; then
  err "SUPABASE_SERVICE_KEY not found in $ENV_FILE"
  exit 1
fi

# ── Build psql connection string from Supabase URL ───────────────────────────
# Supabase URL format: https://<project-ref>.supabase.co
# Direct DB connection: postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
# 
# We use the Supabase Postgres connection via the REST API for migrations,
# or fall back to direct psql if SUPABASE_DB_URL is set.

SUPABASE_DB_URL="${SUPABASE_DB_URL:-}"

if [[ -z "$SUPABASE_DB_URL" ]]; then
  # Try to extract from .env
  SUPABASE_DB_URL=$(grep -E '^SUPABASE_DB_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'" || true)
fi

if [[ -z "$SUPABASE_DB_URL" ]]; then
  err "SUPABASE_DB_URL not set."
  err ""
  err "To get your database URL:"
  err "  1. Go to Supabase Dashboard → Project Settings → Database"
  err "  2. Copy the 'Connection string' (URI format)"
  err "  3. Add it to your .env file as: SUPABASE_DB_URL=postgresql://..."
  err ""
  err "Or set it as an environment variable before running this script:"
  err "  SUPABASE_DB_URL='postgresql://...' ./migrations/run-migrations.sh"
  exit 1
fi

# ── Verify psql is installed ─────────────────────────────────────────────────
if ! command -v psql &>/dev/null; then
  err "psql is not installed or not in PATH."
  err "Install it with:"
  err "  Ubuntu/Debian: sudo apt-get install postgresql-client"
  err "  macOS:         brew install postgresql"
  exit 1
fi

# ── Define migrations in order ───────────────────────────────────────────────
declare -a MIGRATION_FILES=(
  "20260606_001_agent_api_core.sql"
  "20260606_002_solana.sql"
  "20260606_003_data_flywheel.sql"
)

declare -a ROLLBACK_FILES=(
  "20260606_001_agent_api_core.rollback.sql"
  "20260606_002_solana.rollback.sql"
  "20260606_003_data_flywheel.rollback.sql"
)

# Map shorthand numbers to array indices (0-based)
declare -A ROLLBACK_INDEX=(
  ["001"]=0
  ["002"]=1
  ["003"]=2
)

# ── Run a single SQL file via psql ───────────────────────────────────────────
run_sql_file() {
  local filepath="$1"
  local label="$2"

  if [[ ! -f "$filepath" ]]; then
    err "Migration file not found: $filepath"
    return 1
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    warn "DRY RUN — would execute: $filepath"
    echo ""
    echo "--- SQL PREVIEW ($label) ---"
    cat "$filepath"
    echo "--- END PREVIEW ---"
    echo ""
    return 0
  fi

  log "Executing: $label"
  log "File: $filepath"

  # Run with:
  #   -v ON_ERROR_STOP=1  → abort on first SQL error (critical — prevents partial migrations)
  #   --no-password       → rely on connection string credentials
  #   --single-transaction → wrap in a transaction where possible
  if psql \
    "$SUPABASE_DB_URL" \
    -v ON_ERROR_STOP=1 \
    --no-password \
    --single-transaction \
    -f "$filepath" \
    2>&1; then
    ok "$label — SUCCESS"
    return 0
  else
    local exit_code=$?
    err "$label — FAILED (exit code $exit_code)"
    err "Migration stopped. Run the rollback if needed:"
    err "  ./migrations/run-migrations.sh --rollback <number>"
    return $exit_code
  fi
}

# ── ROLLBACK MODE ─────────────────────────────────────────────────────────────
if [[ -n "$ROLLBACK_TARGET" ]]; then
  header "ROLLBACK MODE — Migration $ROLLBACK_TARGET"

  if [[ -z "${ROLLBACK_INDEX[$ROLLBACK_TARGET]:-}" ]]; then
    err "Unknown rollback target: $ROLLBACK_TARGET"
    err "Valid targets: 001, 002, 003"
    exit 1
  fi

  idx="${ROLLBACK_INDEX[$ROLLBACK_TARGET]}"
  rollback_file="${ROLLBACK_FILES[$idx]}"
  full_path="$MIGRATIONS_DIR/$rollback_file"

  warn "⚠️  ROLLBACK DESTROYS DATA. This is irreversible."
  warn "Target: $rollback_file"

  if [[ "$DRY_RUN" != "true" ]]; then
    read -r -p "Type 'ROLLBACK' to confirm: " confirm
    if [[ "$confirm" != "ROLLBACK" ]]; then
      log "Rollback cancelled."
      exit 0
    fi
  fi

  run_sql_file "$full_path" "ROLLBACK $ROLLBACK_TARGET"
  log "Rollback complete."
  exit 0
fi

# ── FORWARD MIGRATION MODE ───────────────────────────────────────────────────
header "MaintMentor.ai — Agent API + Wallet + Data Flywheel Migrations"

if [[ "$DRY_RUN" == "true" ]]; then
  warn "DRY RUN MODE — SQL will be printed but NOT executed"
fi

log "Project root: $PROJECT_ROOT"
log "Migrations dir: $MIGRATIONS_DIR"
log "Environment: $ENV_FILE"
log "Supabase URL: $SUPABASE_URL"
log "DB URL: [redacted — set in env]"
echo ""

# ── Pre-flight checks ────────────────────────────────────────────────────────
log "Pre-flight: checking database connectivity..."
if [[ "$DRY_RUN" != "true" ]]; then
  if ! psql "$SUPABASE_DB_URL" -c "SELECT 1;" --no-password -q 2>&1; then
    err "Cannot connect to database. Check SUPABASE_DB_URL."
    exit 1
  fi
  ok "Database connection: OK"
fi

# ── Check pgvector for migration 003 ─────────────────────────────────────────
if [[ "$DRY_RUN" != "true" ]]; then
  log "Pre-flight: checking pgvector extension..."
  VECTOR_CHECK=$(psql "$SUPABASE_DB_URL" -t -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'vector';" --no-password 2>/dev/null | tr -d ' ')
  if [[ "$VECTOR_CHECK" == "0" ]]; then
    warn "pgvector extension is not available on this Supabase project."
    warn "Migration 003 (data flywheel) will fail without it."
    warn "Enable it in: Supabase Dashboard → Extensions → vector"
    warn "Continuing — migrations 001 and 002 will still run."
  else
    ok "pgvector extension: available"
  fi
fi

# ── Run migrations in order ───────────────────────────────────────────────────
FAILED=0
COMPLETED=0

for i in "${!MIGRATION_FILES[@]}"; do
  migration="${MIGRATION_FILES[$i]}"
  full_path="$MIGRATIONS_DIR/$migration"
  num=$((i + 1))

  header "Migration $num of ${#MIGRATION_FILES[@]}: $migration"

  if run_sql_file "$full_path" "$migration"; then
    COMPLETED=$((COMPLETED + 1))
  else
    FAILED=1
    err "Stopping after failed migration: $migration"
    break
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
header "Migration Run Complete"

if [[ "$DRY_RUN" == "true" ]]; then
  log "DRY RUN complete — no changes were made."
  log "Remove --dry-run to execute for real."
elif [[ $FAILED -eq 0 ]]; then
  ok "All $COMPLETED migration(s) completed successfully."
  log ""
  log "Recommended next steps:"
  log "  1. Run the verification queries in each migration file"
  log "  2. Test RLS policies with two separate test accounts"
  log "  3. Confirm pgvector index built (check idx_query_embeddings_ivfflat)"
  log "  4. Update Stripe price IDs in credit_packs table"
  log "  5. Update mack-build-status.md with completion notes"
else
  err "$COMPLETED of ${#MIGRATION_FILES[@]} migration(s) completed before failure."
  err "Investigate the error above, then either:"
  err "  a) Fix and re-run (all migrations are idempotent)"
  err "  b) Roll back: ./migrations/run-migrations.sh --rollback <number>"
  exit 1
fi
