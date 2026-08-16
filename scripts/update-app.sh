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

# ── 3. 让 app 自己先优雅关闭（graceful quit：跑完 shutdown 钩子/存窗口态；直接强杀会留下崩溃态→下次启动恢复白屏） ──
log "asking ${APP_NAME} to quit gracefully..."
osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
for i in $(seq 1 16); do
  pgrep -f "${APP_PATH}/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1 || break
  sleep 0.5
done
# 8s 还活着才升级强杀（TERM → KILL 兜底）
if pgrep -f "${APP_PATH}/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1; then
  log "graceful quit timeout (8s), escalating to kill..."
  pkill -f "${APP_PATH}/Contents/MacOS/${APP_NAME}" 2>/dev/null || true
  for i in $(seq 1 10); do
    pgrep -f "${APP_PATH}/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1 || break
    sleep 0.5
  done
  pkill -9 -f "${APP_NAME}" 2>/dev/null || true
  sleep 1
fi
log "app closed."

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

# ── 7. 等文件真正落盘（检测式，替代盲等秒数；修复白屏：290MB 拷贝后未落盘就 open 读到半成品） ──
log "waiting for files to settle (sync + lsof drain + size stable)..."
sync
# 7a. lsof 排空：没有任何进程仍占用 .app（cp/mdworker/索引都结束），最多等 30s
for i in $(seq 1 60); do
  if lsof +D "$APP_PATH" >/dev/null 2>&1; then sleep 0.5; else break; fi
done
# 7b. 大小稳定双读：连续两次 du 一致 = 落盘完成（最多 5s）
prev=$(du -sk "$APP_PATH" 2>/dev/null | cut -f1)
for i in $(seq 1 10); do
  sleep 0.5
  cur=$(du -sk "$APP_PATH" 2>/dev/null | cut -f1)
  [[ "$cur" == "$prev" ]] && break
  prev="$cur"
done
log "files settled (size=${prev}KB), +1s buffer..."
sleep 1

# ── 8. 重启 app ──
log "launching ${APP_NAME}..."
open "$APP_PATH"
# 8b. 确认进程真起来了（最多 5s），起不来就明说
for i in $(seq 1 10); do
  pgrep -f "${APP_PATH}/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1 && break
  sleep 0.5
done
if pgrep -f "${APP_PATH}/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1; then
  log "DONE. ${APP_NAME} updated and launched (process confirmed)."
else
  log "WARN: launched but process not detected within 5s — 请手动打开确认。"
fi
