#!/usr/bin/env bash
# tests/worktree_cleanup_check.sh — git worktree remove 前跑：检查 env 残留 + 提示清理。
# 用法：bash tests/worktree_cleanup_check.sh  （exit 0=可删 worktree；exit 1=先 env_shutdown）
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$SCRIPT_DIR"
while [ "$TESTS_DIR" != "/" ] && [ ! -f "$TESTS_DIR/test.env" ]; do TESTS_DIR="$(dirname "$TESTS_DIR")"; done
[ -f "$TESTS_DIR/test.env" ] || { echo "[cleanup] WARN: test.env not found (worktree 已删？)"; exit 0; }
. "$TESTS_DIR/lib/port_alloc.sh"

if _port_cleanup_check; then
  echo "[cleanup] OK: worktree $_PORT_WT 无 env 残留，可安全删除"
  exit 0
else
  echo "[cleanup] → 先清理: bash $TESTS_DIR/e2e/env_shutdown.sh  (或 api/env_shutdown.sh)"
  exit 1
fi
