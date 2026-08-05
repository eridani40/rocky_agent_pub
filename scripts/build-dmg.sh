#!/usr/bin/env bash
# build-dmg.sh — 打包发布产物（macOS dmg / Windows exe 平台变体）
# 参考: specs/tech/app/envs/[P0]scripts.md §3.3
#       specs/tech/app/package/[P0]packaging_toolchain.md §3.3（两段式）/§3.4（产物目录）
#
# source prod.env → 两段式：
#   ① vite build（app/web，outDir=app/electron/web-dist）
#   ② tsc -b（编译 electron main/preload + workspace refs）
#   ③ electron-builder（读 app/electron/electron-builder.yml + 注入 env）
# 缺 prod.env 或关键字段（APP_NAME/API_PORT 等）/ 根 package.json version 无效 → 非 0 退出（scripts.md §4.4）
# 退出码：打包工具退出码透传
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f ./prod.env ]; then
  echo "[build-dmg.sh] ERROR: 缺失 prod.env，请执行 cp prod.env.example prod.env（参考 specs/tech/app/envs/[P0]environments.md §3.5）" >&2
  exit 1
fi

set -a
. ./prod.env
set +a

# 版本号权威源 = 根 package.json version（不再从 prod.env 手填 APP_VERSION）。
# 注意：electron-builder 在 app/electron 子目录跑，默认读 app/electron/package.json
# 的 version（=0.0.0 占位），而非根。故显式读根 package.json version 并通过
# --config.extraMetadata.version 注入，保证产物版本 = 根 package.json 版本。
APP_VERSION="$(node -p "require('./package.json').version || ''")"
if [ -z "$APP_VERSION" ] || [ "$APP_VERSION" = "0.0.0" ]; then
  echo "[build-dmg.sh] ERROR: 根 package.json version 无效（'$APP_VERSION'）。请先在 package.json 设版本号（如 0.0.108）后再打包。" >&2
  exit 2
fi

# 共通字段校验（来自 prod.env）
for required in APP_NAME APP_ENV API_PORT WEB_PORT DATA_DIR; do
  if [ -z "${!required:-}" ]; then
    echo "[build-dmg.sh] ERROR: prod.env 缺关键字段 $required。请对照 prod.env.example 补齐。" >&2
    exit 2
  fi
done

# BUILD_OUT_DIR 缺省 ./release（相对仓库根），转绝对路径传给 electron-builder
# （builder cwd=app/electron，相对路径会被误解析到子目录）
BUILD_OUT_DIR_DEFAULT="$(pwd)/release"
BUILD_OUT_DIR="${BUILD_OUT_DIR:-$BUILD_OUT_DIR_DEFAULT}"
case "$BUILD_OUT_DIR" in
  /*) : ;;                                   # 已是绝对路径
  *)  BUILD_OUT_DIR="$(pwd)/$BUILD_OUT_DIR" ;; # 相对转绝对
esac
echo "[build-dmg.sh] APP_NAME=$APP_NAME version=$APP_VERSION → $BUILD_OUT_DIR"

# v0.0.1 允许未签名（PRD §7.2）。prod.env.example 的签名字段留空占位，
# 但 electron-builder 见到空 CSC_LINK 会误当成证书文件路径报 "not a file"。
# 故显式 unset 空值签名字段，让 builder 跳过签名（不致命）。
for signkey in CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  if [ -z "${!signkey:-}" ]; then
    unset "$signkey"
  fi
done

# 生成运行时配置（白名单非密钥键 → app/electron/runtime-config.json，打进 asar）。
# packaged app 运行时 process.env 干净，靠此文件把 API_PORT 等注入回 process.env
# （main.ts loadRuntimeConfig 读取），否则后端起不来（本版本修的真 bug）。
# 零密钥硬约束：只抽白名单键，LLM key / 苹果签名 / CSC 一律不进（与 runtime-config.ts 同源）。
# 用 node 生成保证 JSON 转义正确；只读白名单键，非白名单键即便在 env 里也不写入。
# DATA_DIR 可移植性：source prod.env 时 bash 把 `~/.rocky_agent_prod` 展开成 build 机
#   绝对 home 路径（/Users/<builder>/...），直接写进 config 会在分发到别的用户/机器时
#   指向错目录。故对 DATA_DIR 做 $HOME 前缀→字面 `~` 还原，config 里存字面 `~/...`，
#   由 server config 层 expandTilde 按【运行用户】home 展开（可移植 + 保留可配置性）。
#   其他白名单键原样。
echo "[build-dmg.sh] generating app/electron/runtime-config.json (whitelist non-secret keys) ..."
node -e '
  const WHITELIST = ["API_PORT","DATA_DIR","APP_NAME","APP_ENV","LOG_LEVEL","HEALTH_ENDPOINT","EVENT_LOOP_MONITOR","MAIN_EVENT_LOOP_MONITOR"];
  const home = process.env.HOME;
  const out = {};
  for (const k of WHITELIST) {
    let v = process.env[k];
    if (v === undefined || v === "") continue;
    // DATA_DIR: build 机 $HOME 前缀 → 字面 ~（仅当值落在 $HOME 下；显式绝对路径保留）
    if (k === "DATA_DIR" && home && (v === home || v.startsWith(home + "/"))) {
      v = "~" + v.slice(home.length);
    }
    out[k] = v;
  }
  require("fs").writeFileSync("app/electron/runtime-config.json", JSON.stringify(out, null, 2) + "\n");
  console.log("[build-dmg.sh]   runtime-config keys:", Object.keys(out).join(", "), "| DATA_DIR:", out.DATA_DIR);
'

# ① 构建 web 静态产物（vite build → app/electron/web-dist，见 vite.config.ts outDir）
# 注入 VITE_API_BASE：packaged 渲染层用 file:// 加载，需绝对 URL fetch 后端（跨域）。
# dev 时 VITE_API_BASE 未设 → '' → 相对路径走 vite proxy；packaged 必须显式注入绝对 URL。
# vite 仅在 build 期内联 VITE_ 前缀变量到产物，故此处 export 后再 build。
# feature gate（specs/tech/app/[P1]feature_gate.md）：本脚本默认【不】export FEATURE_OKR
# → __FEATURE_OKR__ 编译期内联为 false，packaged 默认隐藏 OKR/requirement 前端呈现。
# 未来开 OKR 重启路径：build 前 `export FEATURE_OKR=true` 再跑本脚本（零代码改动）。
export VITE_API_BASE="http://127.0.0.1:${API_PORT}"
echo "[build-dmg.sh] ① building @app/web (VITE_API_BASE=$VITE_API_BASE, vite build → app/electron/web-dist) ..."
# 先编译 @app/server dist（CJS）：electron 主进程 packaged 模式 require('@app/server')
# 取 startServer；不预编译则 main.js 运行时 require 失败（server package.json main=dist/index.js）。
echo "[build-dmg.sh] ①a building @app/server TS (tsc -b → app/server/dist, CJS for Electron require) ..."
(cd app/server && bun run build)
if [ ! -f app/server/dist/index.js ]; then
  echo "[build-dmg.sh] ERROR: app/server/dist/index.js 不存在，server tsc -b 失败（electron 主进程无法 require）" >&2
  exit 3
fi
# ①a.1 生成 app/server/app-version.json（读根 package.json version，供运行时 app-version.ts 读）。
#   必须在 server build 后（dist 已就绪，gen-version 写 app-version.json 同级）、electron-builder 前跑
#   （确保 files 映射把 app-version.json 打进 asar node_modules/@app/server）。缺产物 = packaged
#   运行时 getAppVersion() 抛错 → bootstrap 崩。
echo "[build-dmg.sh] ①a.1 generating app/server/app-version.json ..."
bun run gen-version
if [ ! -f app/server/app-version.json ]; then
  echo "[build-dmg.sh] ERROR: app/server/app-version.json 未生成（gen-version 失败）" >&2
  exit 3
fi
# ①b 编译内置 plugin（.ts impl → 自包含 .cjs bundle → app/plugins/dist）。
# 依赖 server dist（bundle 外置 @app/server/dist/X）故必须在 ①a 之后；须在 electron-builder（③）
# 前完成，让 files 映射能把 app/plugins/dist 打进 asar node_modules/@app/plugins。
# 缺产物 = packaged 无内置插件（无 LLM provider = 空壳 + ScopeConfigLoader 崩），非 0 退出。
echo "[build-dmg.sh] ①b building builtin plugins (bun build → app/plugins/dist/builtins) ..."
bun run scripts/build-plugins.ts
if [ -z "$(ls -A app/plugins/dist/builtins 2>/dev/null)" ]; then
  echo "[build-dmg.sh] ERROR: app/plugins/dist/builtins 为空，build-plugins.ts 失败（packaged 无内置插件=空壳）" >&2
  exit 3
fi
(cd app/web && bun run build)

# 确认产物落点（packaging_toolchain §3.3 约定）
if [ ! -f app/electron/web-dist/index.html ]; then
  echo "[build-dmg.sh] ERROR: app/electron/web-dist/index.html 不存在，vite build 失败" >&2
  exit 3
fi

# ② 编译 electron main + preload（tsc -b 编译到 app/electron/dist）
echo "[build-dmg.sh] ② building @app/electron TS (tsc -b → app/electron/dist) ..."
(cd app/electron && bun run build:ts)
if [ ! -f app/electron/dist/main.js ]; then
  echo "[build-dmg.sh] ERROR: app/electron/dist/main.js 不存在，tsc -b 失败" >&2
  exit 3
fi

# ②b 构建 computer-native 原生模块（macOS only）：Swift dylib → node-gyp(Electron ABI) → .node
# 并置 dylib。必须在 electron-builder（③）前完成——builder 已设 npmRebuild:false 不重跑 rebuild，
# 故此处不产出 .node/dylib 则 packaged app 加载 addon fail-closed（computer 能力全失效）。
# 非 macOS（win 交叉打包）跳过：原生模块仅 mac 平台，Swift toolchain 也仅 mac 有。
if [ "$(uname)" = "Darwin" ]; then
  echo "[build-dmg.sh] ②b building @app/computer-native (swift → node-gyp Electron ABI) ..."
  (cd app/computer-native && bash scripts/build-native.sh)
  NATIVE_DIR="app/computer-native/build/Release"
  if [ ! -f "$NATIVE_DIR/rocky_computer.node" ] || [ ! -f "$NATIVE_DIR/libRockyComputerCore.dylib" ]; then
    echo "[build-dmg.sh] ERROR: computer-native 产物缺失（$NATIVE_DIR 下应有 rocky_computer.node + libRockyComputerCore.dylib），build-native.sh 失败" >&2
    exit 3
  fi

  # ②c better-sqlite3 Electron ABI 预编译（v0.0.194 CrudStore sqlite engine 扶正）
  # 守 memory native-addon-workspace-skip-install-nodegyp：bun install 期 prebuild-install 下载的是
  # Node ABI prebuilt，packaged Electron 需 Electron ABI（process.versions.modules 不同）。用
  # @electron/rebuild 显式对 better-sqlite3 重编译面向 Electron headers。
  # npmRebuild:false 已禁止 electron-builder 自动跑（与 computer-native 一致）。
  #
  # warn+skip 语义（orchestrator 裁决 v0.0.194）：rebuild 失败不阻断 dmg build。理由：packaged
  # default=NodeSqlDriver（node:sqlite Node 22+ 内置）全覆盖 CrudStore + search.sqlite 所需能力
  # （含 FTS5），BetterSqlite3Driver 生产从不激活（setPackagedSqlDriverKind('better-sqlite3') 不调）。
  # better-sqlite3@11 + Electron 42 存在 V8 API mismatch（ExternalPointerTypeTag），是上游兼容问题
  # 非本版代码 bug。详见 specs/tech/persistence/[P0]sqlite_engine_packaged_promotion.md §4。
  ELECTRON_VERSION_FROM_BUILDER="$(node -p "require('electron/package.json').version" 2>/dev/null || true)"
  ELECTRON_VERSION_FOR_BS3="${ELECTRON_VERSION_FOR_BS3:-${ELECTRON_VERSION_FROM_BUILDER:-42.4.1}}"
  # 找 better-sqlite3 目录（app/server 声明，bun hoist 时可能在根 node_modules）
  BSQLITE3_DIR="app/server/node_modules/better-sqlite3"
  if [ ! -d "$BSQLITE3_DIR" ]; then
    BSQLITE3_DIR="node_modules/better-sqlite3"
  fi
  if [ ! -d "$BSQLITE3_DIR" ]; then
    echo "[build-dmg.sh] ERROR: 找不到 better-sqlite3 目录（app/server/node_modules 与根 node_modules 都没有），bun install 了吗？" >&2
    exit 3
  fi
  # 用路径 resolve（node 从 cwd 主仓库 resolve 不到 app/server/node_modules/better-sqlite3，会 fail 返 unknown）
  BS3_VERSION="$(node -p "require('./$BSQLITE3_DIR/package.json').version" 2>/dev/null || echo "unknown")"
  # fast-skip：better-sqlite3@11 + Electron 42 V8 API mismatch（上游 ExternalPointerTypeTag），rebuild 注定 fail。
  # packaged default=NodeSqlDriver（node:sqlite Node 22+ 内置）全覆盖（含 FTS5），better-sqlite3 为未激活 fallback，不需 .node。
  # 升 @12+ 适配 Electron 42 V8 后，移除此 fast-skip 恢复 rebuild。
  if [[ "$BS3_VERSION" == 11.* ]]; then
    echo "[build-dmg.sh] ②c SKIP: better-sqlite3@$BS3_VERSION + Electron $ELECTRON_VERSION_FOR_BS3 V8 API 不兼容（上游 ExternalPointerTypeTag mismatch），rebuild 注定 fail；packaged default=node:sqlite 全覆盖（含 FTS5）不需 better-sqlite3 .node"
  else
  echo "[build-dmg.sh] ②c rebuilding better-sqlite3@$BS3_VERSION for Electron ABI ..."
  (
    cd "$BSQLITE3_DIR"
    # @electron/rebuild（项目已装则 --no-install 直接用；旧包名 electron-rebuild 会触发 npx "missing packages" cancel 噪音）
    if node -e "require.resolve('@electron/rebuild')" 2>/dev/null; then
      npx --no-install @electron/rebuild -f -w better-sqlite3 --version="$ELECTRON_VERSION_FOR_BS3"
    else
      NODE_GYP_BS3="$(node -p "require.resolve('node-gyp/bin/node-gyp.js')" 2>/dev/null || true)"
      if [ -z "$NODE_GYP_BS3" ]; then
        echo "[build-dmg.sh] ERROR: 无法解析 node-gyp（better-sqlite3 rebuild 需要）" >&2
        exit 1
      fi
      node "$NODE_GYP_BS3" rebuild \
        --loglevel=error \
        --target="$ELECTRON_VERSION_FOR_BS3" \
        --arch="$(uname -m)" \
        --dist-url=https://electronjs.org/headers \
        --runtime=electron
    fi
  ) || {
    # rebuild 失败 → warn 不阻断（packaged default=node:sqlite 全覆盖，better-sqlite3 为未激活 fallback）
    echo "[build-dmg.sh] WARN: better-sqlite3 Electron ABI rebuild 失败 — 跳过（packaged default=node:sqlite 全覆盖含 FTS5，better-sqlite3 为未激活 fallback；详见 [P0]sqlite_engine_packaged_promotion.md §4）" >&2
  }
  BS3_NODE="$BSQLITE3_DIR/build/Release/better_sqlite3.node"
  if [ ! -f "$BS3_NODE" ]; then
    # .node 缺失 → warn 不阻断：rebuild 跳过/失败时 .node 可能不存在或为旧 prebuild（Node ABI）；
    # packaged 用 NodeSqlDriver 不加载 better-sqlite3 .node，无害
    echo "[build-dmg.sh] WARN: better-sqlite3 .node 产物缺失（Electron ABI rebuild 跳过/失败）— packaged default=node:sqlite 不加载此 .node，dmg build 继续" >&2
  else
    echo "[build-dmg.sh] ②c done: $BS3_NODE (Electron $ELECTRON_VERSION_FOR_BS3 ABI)"
  fi
  fi

  # ②d posix Electron ABI 预编译（raise-nofile native binding）
  # posix 是 packaged Electron 主进程的【运行时硬依赖】（raiseNofileLimit 调 setrlimit 抬 nofile），
  # 非 better-sqlite3 那种可 skip 的未激活 fallback → rebuild 失败必须阻断 dmg build（exit 1）。
  # bun install 默认装 Node ABI prebuild，packaged Electron 需 Electron ABI → 走 node-gyp direct（见下方）。
  # 与 ②c 唯一差异 = 失败 exit 1 非 warn+skip。
  echo "[build-dmg.sh] ②d rebuilding posix for Electron ABI (hard runtime dep, must succeed) ..."
  ELECTRON_VERSION_FOR_POSIX="${ELECTRON_VERSION_FOR_POSIX:-${ELECTRON_VERSION_FROM_BUILDER:-42.4.1}}"
  POSIX_DIR="app/electron/node_modules/posix"
  if [ ! -d "$POSIX_DIR" ]; then
    # bun hoist 时可能在根 node_modules；fallback 解析
    POSIX_DIR="node_modules/posix"
  fi
  if [ ! -d "$POSIX_DIR" ]; then
    echo "[build-dmg.sh] ERROR: 找不到 posix 目录（app/electron/node_modules 与根 node_modules 都没有）。posix 是 packaged 主进程硬依赖（raise-nofile），缺它 bash 工具 nofile 抬升失效。请确认 app/electron/package.json dependencies 含 posix 且 bun install 已跑。" >&2
    exit 3
  fi
  # node-gyp direct 主路径：不经 @electron/rebuild / npx（npx 命中陈旧 node-abi 不识别 electron 42 ABI 必败，
  # 且绕过本地 install）。node-gyp direct 走 --dist-url 直拉 Electron headers 绕过 node-abi ABI 探测，复用本地 node-gyp@11。
  # 失败 → exit 1（posix 是运行时硬依赖，非 better-sqlite3 可 skip）。
  NODE_GYP_POSIX="$(cd "$POSIX_DIR" && node -p "require.resolve('node-gyp/bin/node-gyp.js')" 2>/dev/null || true)"
  if [ -z "$NODE_GYP_POSIX" ]; then
    echo "[build-dmg.sh] ERROR: 无法从 posix 目录解析 node-gyp（posix Electron ABI rebuild 需要）。确认 node-gyp 已装（app/electron devDeps）且 bun install 已跑。" >&2
    exit 1
  fi
  (
    cd "$POSIX_DIR"
    # CXXFLAGS 抑制 Electron 42 V8 header 的 cast_function_type_mismatch warning（posix 用 nan@2.28 未适配 V8 42 callback 签名；上游问题不阻断，仅降噪；实测 5 warnings → 0）
    CXXFLAGS="-Wno-cast-function-type-mismatch" node "$NODE_GYP_POSIX" rebuild \
      --loglevel=error \
      --target="$ELECTRON_VERSION_FOR_POSIX" \
      --arch="$(uname -m)" \
      --dist-url=https://electronjs.org/headers \
      --runtime=electron
  ) || {
    # rebuild 失败 → 阻断（posix 是运行时硬依赖，非 better-sqlite3 可 skip）
    echo "[build-dmg.sh] ERROR: posix Electron ABI rebuild 失败 — posix 是 packaged 主进程硬依赖（raiseNofileLimit 调 setrlimit），不可 skip。退路：自写 minimal N-API addon（参照 computer-native 模式）。" >&2
    exit 1
  }
  POSIX_NODE="$POSIX_DIR/build/Release/posix.node"
  if [ ! -f "$POSIX_NODE" ]; then
    echo "[build-dmg.sh] ERROR: posix .node 产物缺失（$POSIX_NODE）— packaged 主进程 require('posix') 会崩，bash nofile 抬升失效。rebuild 未产出 .node，疑 node-gyp 失败被吞。" >&2
    exit 1
  fi
  echo "[build-dmg.sh] ②d done: $POSIX_NODE (Electron $ELECTRON_VERSION_FOR_POSIX ABI)"
else
  echo "[build-dmg.sh] ②b 跳过 computer-native 构建（非 macOS：$(uname)）"
  echo "[build-dmg.sh] ②c 跳过 better-sqlite3 Electron ABI 重建（非 macOS）"
  echo "[build-dmg.sh] ②d 跳过 posix Electron ABI 重建（非 macOS）"
fi

# 版本号注入：electron-builder 从 app/electron 子目录跑，默认读 app/electron/package.json
# 的 version（0.0.0 占位）。用 --config.extraMetadata.version 覆盖为根 package.json 版本，
# 保证产物名 rocky_agent-${APP_VERSION}-arm64.dmg 版本正确（不改任何 package.json 文件）。
echo "[build-dmg.sh] ③ running electron-builder ..."
(
  cd app/electron
  bunx electron-builder \
    --config electron-builder.yml \
    --config.extraMetadata.version="$APP_VERSION" \
    --config.directories.output="$BUILD_OUT_DIR" \
    --config.productName="$APP_NAME" \
    --publish never
)

# 产物存在性校验（acceptanceCriteria：dmg 文件存在且体积 > 0）
DMG_COUNT=$(ls -1 "$BUILD_OUT_DIR"/*.dmg 2>/dev/null | wc -l | tr -d ' ')
if [ "$DMG_COUNT" -lt 1 ]; then
  echo "[build-dmg.sh] ERROR: $BUILD_OUT_DIR 下未产出 *.dmg" >&2
  exit 4
fi
echo "[build-dmg.sh] DONE："
ls -la "$BUILD_OUT_DIR"/*.dmg
