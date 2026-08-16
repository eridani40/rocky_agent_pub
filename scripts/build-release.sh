#!/usr/bin/env bash
# build-release.sh — 便捷打包入口（封装 build-dmg.sh + 跳过已有原生产物 + node/bun PATH 适配）
#
# 用法：bash scripts/build-release.sh
#
# 与 build-dmg.sh 的区别：
#   - 自动设置 PATH（bun → node symlink，适配无 node 环境）
#   - computer-native 产物已存在时跳过 Swift 重编（避免 sandbox 权限偶发失败）
#   - 其余步骤与 build-dmg.sh 完全一致
#
# 参考：scripts/build-dmg.sh（权威打包脚本）
#       specs/tech/app/package/[P0]packaging_toolchain.md
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# ① 设置 PATH：bun bin（node/npm 由 login shell 自带，不再 bun→node symlink）
# [v0.0.265] login shell 修复后系统自带真 node；bun→node symlink 会导致
#   node-gyp `--target=undefined`（bun -p require 失败返回 undefined 但 exit 0，fallback 不触发）
export PATH="$HOME/.bun/bin:$PATH"

# ② 检查 computer-native 产物是否已存在
NATIVE_DIR="app/computer-native/build/Release"
SKIP_NATIVE=false
if [ -f "$NATIVE_DIR/rocky_computer.node" ] && [ -f "$NATIVE_DIR/libRockyComputerCore.dylib" ]; then
  echo "[build-release.sh] computer-native 产物已存在，跳过 Swift 重编"
  SKIP_NATIVE=true
fi

if [ "$SKIP_NATIVE" = true ]; then
  # 产物已存在 → 跳过 Swift，直接跑后续步骤（②c/②d/③）
  echo "[build-release.sh] 跳过 build-dmg.sh 的 ①~②b（产物复用），从 ②c 开始 ..."

  bash "$REPO_ROOT/scripts/build-dmg-skip-native.sh"
else
  # 全新构建 → 走完整 build-dmg.sh
  echo "[build-release.sh] 全新构建，走完整 build-dmg.sh ..."
  bash "$REPO_ROOT/scripts/build-dmg.sh"
fi
