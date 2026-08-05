#!/usr/bin/env bash
set -euo pipefail

# build-native.sh —— computer-native 编译链（四段）：
#   ① Swift → dylib      : swift build -c release → libRockyComputerCore.dylib
#   ② install_name → @rpath: 便于 .node 经 @loader_path rpath 在同目录解析 dylib
#   ③ C++ → .node        : node-gyp rebuild（对 **Electron** headers/ABI 编译，非系统 node）
#   ④ 产物并置            : dylib 拷入 build/Release/ 与 .node 同目录
# 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.2
#
# 前置：macOS + Xcode/Swift toolchain（构建期依赖，非 runtime）。runtime 不需 Swift toolchain
#       （macOS 14+ Swift runtime 在 OS /usr/lib/swift，ABI-stable）。
# 环境变量：
#   ELECTRON_VERSION  目标 Electron 版本（默认从 node_modules 探测，兜底 42.4.1）
#   ARCH              目标架构（默认 uname -m：arm64 / x86_64）

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFT_DIR="$HERE/swift"
BUILD_DIR="$HERE/build/Release"
DYLIB_NAME="libRockyComputerCore.dylib"

ARCH="${ARCH:-$(uname -m)}"

# Electron 版本探测（node-gyp 必须对 Electron 的 node ABI 编译，非系统 node）
detect_electron_version() {
  node -p "require('electron/package.json').version" 2>/dev/null || true
}
ELECTRON_VERSION="${ELECTRON_VERSION:-$(detect_electron_version)}"
ELECTRON_VERSION="${ELECTRON_VERSION:-42.4.1}"

echo "[build-native] target: Electron $ELECTRON_VERSION, arch $ARCH"

# ── ① Swift → dylib ─────────────────────────────────────────────
# 只编 dylib 主产品（--product），避免 release 一并编 TestRunner（@testable 需 debug enable-testing）
echo "[build-native] ① swift build -c release --product RockyComputerCore …"
( cd "$SWIFT_DIR" && swift build -c release --product RockyComputerCore )
DYLIB_SRC="$SWIFT_DIR/.build/release/$DYLIB_NAME"
if [ ! -f "$DYLIB_SRC" ]; then
  echo "[build-native] ERROR: dylib 未产出于 $DYLIB_SRC" >&2
  exit 1
fi
echo "[build-native]   → $DYLIB_SRC"

# 验证 @_cdecl C 符号确实导出（否则 .node 链接会 undefined symbol）
if ! nm -gU "$DYLIB_SRC" | grep -q "_rocky_cu_ping"; then
  echo "[build-native] ERROR: dylib 未导出 _rocky_cu_ping（@_cdecl 符号可见性问题）" >&2
  nm -gU "$DYLIB_SRC" | grep "rocky_cu" >&2 || true
  exit 1
fi

# ── ② install_name → @rpath ─────────────────────────────────────
echo "[build-native] ② install_name_tool -id @rpath/$DYLIB_NAME …"
install_name_tool -id "@rpath/$DYLIB_NAME" "$DYLIB_SRC"

# ── ③ C++ → .node（对 Electron ABI 编译）────────────────────────
echo "[build-native] ③ node-gyp rebuild (electron headers)…"
# 从包目录解析 node-gyp（deps 挂在 app/computer-native/node_modules，非 root）
NODE_GYP="$(cd "$HERE" && node -p "require.resolve('node-gyp/bin/node-gyp.js')" 2>/dev/null || true)"
if [ -z "$NODE_GYP" ]; then
  echo "[build-native] ERROR: 无法解析 node-gyp（bun install 了吗？）" >&2
  exit 1
fi
( cd "$HERE" && node "$NODE_GYP" rebuild \
    --loglevel=error \
    --target="$ELECTRON_VERSION" \
    --arch="$ARCH" \
    --dist-url=https://electronjs.org/headers \
    --runtime=electron )

NODE_ADDON="$BUILD_DIR/rocky_computer.node"
if [ ! -f "$NODE_ADDON" ]; then
  echo "[build-native] ERROR: .node 未产出于 $NODE_ADDON" >&2
  exit 1
fi

# ── ④ 产物并置（dylib 与 .node 同目录，@loader_path 解析）──────────
echo "[build-native] ④ 并置 dylib → $BUILD_DIR/"
cp "$DYLIB_SRC" "$BUILD_DIR/$DYLIB_NAME"

echo "[build-native] done."
echo "[build-native]   .node  : $NODE_ADDON"
echo "[build-native]   dylib  : $BUILD_DIR/$DYLIB_NAME"
echo "[build-native] otool -L rocky_computer.node:"
otool -L "$NODE_ADDON" | sed 's/^/[build-native]   /'
