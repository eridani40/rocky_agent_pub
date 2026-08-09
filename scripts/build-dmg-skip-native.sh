#!/usr/bin/env bash
# build-dmg-skip-native.sh — 跳过 computer-native Swift 编译的打包（产物已存在时用）
# 与 build-dmg.sh 的差异：仅跳过 ②b（Swift/node-gyp computer-native），其余完全一致
# 由 build-release.sh 在检测到 computer-native 产物已存在时调用
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f ./prod.env ]; then
  echo "[build-dmg-skip-native.sh] ERROR: 缺失 prod.env" >&2; exit 1
fi
set -a; . ./prod.env; set +a

APP_VERSION="$(node -p "require('./package.json').version || ''")"
if [ -z "$APP_VERSION" ] || [ "$APP_VERSION" = "0.0.0" ]; then
  echo "[build-dmg-skip-native.sh] ERROR: version 无效" >&2; exit 2
fi
for required in APP_NAME APP_ENV API_PORT WEB_PORT DATA_DIR; do
  if [ -z "${!required:-}" ]; then
    echo "[build-dmg-skip-native.sh] ERROR: prod.env 缺 $required" >&2; exit 2
  fi
done

BUILD_OUT_DIR="$(pwd)/release"
echo "[build-dmg-skip-native.sh] APP_NAME=$APP_NAME version=$APP_VERSION → $BUILD_OUT_DIR"

# runtime-config.json
node -e '
  const WL = ["API_PORT","DATA_DIR","APP_NAME","APP_ENV","LOG_LEVEL","HEALTH_ENDPOINT","EVENT_LOOP_MONITOR","MAIN_EVENT_LOOP_MONITOR"];
  const home = process.env.HOME; const out = {};
  for (const k of WL) { let v = process.env[k]; if (!v) continue;
    if (k === "DATA_DIR" && home && (v === home || v.startsWith(home+"/"))) v = "~"+v.slice(home.length);
    out[k] = v; }
  require("fs").writeFileSync("app/electron/runtime-config.json", JSON.stringify(out,null,2)+"\n");
  console.log("[build-dmg-skip-native.sh]   runtime-config keys:", Object.keys(out).join(", "));
'

# ①a server
echo "[build-dmg-skip-native.sh] ①a building @app/server ..."
(cd app/server && bun run build)
bun run gen-version

# ①b plugins
echo "[build-dmg-skip-native.sh] ①b building builtin plugins ..."
bun run scripts/build-plugins.ts

# ① web
export VITE_API_BASE="http://127.0.0.1:${API_PORT}"
(cd app/web && bun run build)

# ② electron TS
echo "[build-dmg-skip-native.sh] ② building @app/electron TS ..."
(cd app/electron && bun run build:ts)

# ②b SKIP（产物已存在）
echo "[build-dmg-skip-native.sh] ②b SKIP computer-native (产物复用)"

# ②c better-sqlite3 fast-skip
BSQLITE3_DIR="app/server/node_modules/better-sqlite3"
[ ! -d "$BSQLITE3_DIR" ] && BSQLITE3_DIR="node_modules/better-sqlite3"
BS3_VERSION="$(node -p "require('./$BSQLITE3_DIR/package.json').version" 2>/dev/null || echo "unknown")"
if [[ "$BS3_VERSION" == 11.* ]]; then
  echo "[build-dmg-skip-native.sh] ②c SKIP better-sqlite3@$BS3_VERSION (Electron 42 mismatch, packaged uses node:sqlite)"
else
  echo "[build-dmg-skip-native.sh] ②c SKIP (non-v11 but packaged uses node:sqlite default)"
fi

# ②d posix（hard dep）
echo "[build-dmg-skip-native.sh] ②d posix Electron ABI rebuild ..."
ELECTRON_VER="$(node -p "require('electron/package.json').version" 2>/dev/null || echo '42.4.1')"
POSIX_DIR="app/electron/node_modules/posix"
[ ! -d "$POSIX_DIR" ] && POSIX_DIR="node_modules/posix"
NODE_GYP_POSIX="$(cd "$POSIX_DIR" && node -p "require.resolve('node-gyp/bin/node-gyp.js')")"
(cd "$POSIX_DIR" && CXXFLAGS="-Wno-cast-function-type-mismatch" node "$NODE_GYP_POSIX" rebuild \
  --loglevel=error --target="$ELECTRON_VER" --arch=arm64 \
  --dist-url=https://electronjs.org/headers --runtime=electron)

# ③ electron-builder
echo "[build-dmg-skip-native.sh] ③ electron-builder ..."
for k in CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  v="${!k:-}"; [ -z "$v" ] && unset "$k"
done
(cd app/electron && bunx electron-builder \
  --config electron-builder.yml \
  --config.extraMetadata.version="$APP_VERSION" \
  --config.directories.output="$BUILD_OUT_DIR" \
  --config.productName="$APP_NAME" \
  --publish never)

# 验证产物
DMG_COUNT=$(ls -1 "$BUILD_OUT_DIR"/*.dmg 2>/dev/null | wc -l | tr -d ' ')
if [ "$DMG_COUNT" -lt 1 ]; then
  echo "[build-dmg-skip-native.sh] ERROR: 未产出 *.dmg" >&2; exit 4
fi
echo "[build-dmg-skip-native.sh] DONE："
ls -la "$BUILD_OUT_DIR"/*.dmg
