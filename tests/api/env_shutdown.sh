#!/bin/bash
# tests/api/env_shutdown.sh — 杀 server pid 进程树 + 清注册表 + 删 .env_port
#
# v0.0.215：清残留只杀注册表声明 pid 的进程树（_port_kill_tree 递归 descendants +
# cmdline marker 验证），删除旧 `lsof -ti:$port | xargs kill` 裸杀（误杀兄弟 worktree 根源）。
# 端口为版本编码基址（本 worktree 独占），无需按端口扫杀。
#
# 参考: specs/tech/version_logs/v0.0.215/change_plan.md（端口隔离任务行）
set +e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
while [ "$ROOT_DIR" != "/" ]; do
  [ -f "$ROOT_DIR/package.json" ] && break
  ROOT_DIR="$(dirname "$ROOT_DIR")"
done

TESTS_DIR="$ROOT_DIR/tests"
APP_NAME="${APP_NAME:-rocky_agent}"
WT="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "$ROOT_DIR")")"

# 复用 port_alloc（同一 .env_port 注册表）
. "$TESTS_DIR/lib/port_alloc.sh"

PIDFILE="/tmp/${APP_NAME}-${WT}-v2.pid"

# pid：优先注册表，回退 pidfile
PID=$(_port_pid 2>/dev/null || true)
[ -z "$PID" ] && [ -f "$PIDFILE" ] && PID=$(cat "$PIDFILE" 2>/dev/null || true)

# 注册的端口（只清自己的，绝不写死端口号）
MY_API=$(grep -E '^api_port=' "$_PORT_FILE" 2>/dev/null | head -1 | cut -d= -f2 || true)
MY_WEB=$(grep -E '^web_port=' "$_PORT_FILE" 2>/dev/null | head -1 | cut -d= -f2 || true)

echo "[env_shutdown] worktree=$WT  pid=${PID:-<none>}  api=${MY_API:-<none>}  web=${MY_WEB:-<none>}"

# 1. 杀注册 pid + 递归 descendants（marker 验证 cmdline = server entrypoint，防 pid 复用误杀）。
#    v0.0.215：删除旧 `lsof -ti:$port | xargs kill` 裸杀（误杀兄弟 worktree 根源），
#    改为只杀注册表声明 pid 的进程树；端口是版本编码基址，本 worktree 独占无需按端口扫。
if [ -n "$PID" ]; then
  _port_kill_tree "$PID" "index.ts"
fi

# 2. 释放全局注册表 + .env_port（_port_free 双清）
rm -f "$PIDFILE"
_port_free

echo "[env_shutdown] done"
