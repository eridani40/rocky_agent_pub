#!/usr/bin/env bash
# clean-squad.sh — 清理 setup 临时目录
# 用法: bash clean-squad.sh <tmpDir>
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "用法: bash clean-squad.sh <tmpDir>"
  echo "示例: bash clean-squad.sh /tmp/squad-setup-abc123"
  exit 1
fi

TMP_DIR="$1"

if [ -d "$TMP_DIR" ]; then
  rm -rf "$TMP_DIR"
  echo "✅ 已清理: $TMP_DIR"
else
  echo "⚠️ 目录不存在: $TMP_DIR"
fi
