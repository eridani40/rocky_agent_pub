#!/usr/bin/env bash
# update-app.sh — 杀 Rocky Agent → 替换 .app → 重启
# 用法: nohup bash scripts/update-app.sh [version] > /tmp/rocky-update.log 2>&1 &
#   version 可选，缺省取 release/ 下最新 dmg
# 必须用 nohup + & 脱离 app 进程运行（否则 app 被 kill 时脚本一起死）

set -euo pipefail

APP_NAME="rocky_agent"
APP_PATH="/Applications/${APP_NAME}.app"
RELEASE_DIR="$(cd "$(dirname "$0")/.." && pwd)/release"
LOG="/tmp/rocky-update.log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

# ── 1. 确定 dmg ──
VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  DMG=$(ls -t "${RELEASE_DIR}"/${APP_NAME}-*-arm64.dmg 2>/dev/null | head -1)
else
  DMG="${RELEASE_DIR}/${APP_NAME}-${VERSION}-arm64.dmg"
fi

if [[ -z "$DMG" || ! -f "$DMG" ]]; then
  log "ERROR: dmg not found. Usage: $0 [version]  (looked in ${RELEASE_DIR})"
  exit 1
fi
log "dmg: $DMG"

# ── 2. 缓冲 2s（让调用方 bash 返回） ──
log "waiting 2s for caller to exit..."
sleep 2

# ── 3. 杀 app ──
log "killing ${APP_NAME}..."
pkill -f "${APP_PATH}/Contents/MacOS/${APP_NAME}" 2>/dev/null || true
# 等待进程退出（最多 5s）
for i in $(seq 1 10); do
  pgrep -f "${APP_PATH}/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1 || break
  sleep 0.5
done
# 确保杀干净（含 Helper 子进程）
pkill -9 -f "${APP_NAME}" 2>/dev/null || true
sleep 1
log "app killed."

# ── 4. 挂载 dmg ──
MOUNT="/tmp/${APP_NAME}-dmg-mount"
mkdir -p "$MOUNT"
log "mounting dmg..."
hdiutil attach "$DMG" -nobrowse -mountpoint "$MOUNT" 2>&1 | tee -a "$LOG"

SRC_APP="${MOUNT}/${APP_NAME}.app"
if [[ ! -d "$SRC_APP" ]]; then
  log "ERROR: ${SRC_APP} not found in dmg"
  hdiutil detach "$MOUNT" 2>/dev/null || true
  exit 1
fi

# ── 5. 替换 .app ──
log "replacing ${APP_PATH}..."
rm -rf "$APP_PATH"
cp -R "$SRC_APP" "$APP_PATH"
log "copied."

# ── 6. 卸载 dmg ──
hdiutil detach "$MOUNT" 2>/dev/null || true
log "dmg detached."

# ── 7. 重启 app ──
log "launching ${APP_NAME}..."
open "$APP_PATH"
log "DONE. ${APP_NAME} updated and launched."
