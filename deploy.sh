#!/usr/bin/env bash
#
# Deploy script for warning-app-api (Elysia + Bun + Prisma)
# Runs on the VPS. Invoked by GitHub Actions (see .github/workflows/deploy.yml)
# or manually:  bash deploy.sh
#
# Features:
#   - Lock file (no concurrent deploys)
#   - Automatic rollback to previous commit if health check fails
#   - Timestamped logging to /var/www/logs/
#   - Does NOT auto-run DB migrations (prisma migrate/db push) — those are
#     explicit and reviewed. Only `prisma generate` is run to refresh the client.
#
set -euo pipefail

# bun is installed under /root/.bun/bin (not on PATH for non-interactive SSH)
export PATH="/root/.bun/bin:$PATH"

APP_DIR="/var/www/warning-app-api"
PM2_NAME="warning-app-api"
PORT=3001
HEALTH_URL="http://localhost:${PORT}/api/health"
LOG_DIR="/var/www/logs"
LOG_FILE="${LOG_DIR}/warning-app-api-deploy.log"
LOCK_FILE="/tmp/warning-app-api-deploy.lock"

mkdir -p "${LOG_DIR}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"; }

# ── Concurrency lock ──────────────────────────────────────────────────────────
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  log "Otro deploy en curso. Saliendo."
  exit 0
fi

# ── Prerequisites ────────────────────────────────────────────────────────────
if [ ! -d "${APP_DIR}/.git" ]; then
  log "ERROR: ${APP_DIR} no es un repo git."
  exit 1
fi
cd "${APP_DIR}"

PREV_COMMIT="$(git rev-parse HEAD)"
log "Deploy iniciado. Commit previo: ${PREV_COMMIT}"

# ── Fetch + reset to origin/main ─────────────────────────────────────────────
log "Fetching origin/main..."
git fetch origin main --prune
git reset --hard origin/main
NEW_COMMIT="$(git rev-parse HEAD)"
log "Reseteado a origin/main: ${NEW_COMMIT}"

if [ "${NEW_COMMIT}" = "${PREV_COMMIT}" ]; then
  log "Ya estamos en el último commit (${NEW_COMMIT}). Deploy no necesita cambios de código; continúo."
fi

# ── Install dependencies ─────────────────────────────────────────────────────
log "Instalando dependencias (bun install)..."
if ! bun install --frozen-lockfile; then
  log "ERROR: bun install falló."
  git reset --hard "${PREV_COMMIT}"
  log "Rollback de código a ${PREV_COMMIT}."
  exit 1
fi

# ── Prisma generate (refresh client, NO migrations) ──────────────────────────
log "Regenerando Prisma client..."
if [ -f "prisma/schema.prisma" ]; then
  if ! bunx prisma generate; then
    log "ERROR: prisma generate falló."
    git reset --hard "${PREV_COMMIT}"
    log "Rollback de código a ${PREV_COMMIT}."
    exit 1
  fi
fi

# ── Restart API ──────────────────────────────────────────────────────────────
log "Reiniciando ${PM2_NAME}..."
pm2 restart "${PM2_NAME}"

# ── Health check ─────────────────────────────────────────────────────────────
sleep 4
if curl -fsS -o /dev/null "${HEALTH_URL}"; then
  log "Health check OK (${HEALTH_URL})."
else
  log "ERROR: health check falló. Ejecutando rollback..."
  git reset --hard "${PREV_COMMIT}"
  if ! bun install --frozen-lockfile; then
    log "ERROR: bun install durante rollback falló."
  fi
  if [ -f "prisma/schema.prisma" ]; then
    bunx prisma generate 2>/dev/null || true
  fi
  pm2 restart "${PM2_NAME}" 2>/dev/null || true
  sleep 4
  if curl -fsS -o /dev/null "${HEALTH_URL}"; then
    log "Rollback OK, servicio restaurado."
  else
    log "ERROR CRÍTICO: rollback falló, intervención manual requerida."
  fi
  exit 1
fi

log "Deploy completado OK en ${NEW_COMMIT}."
