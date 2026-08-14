#!/usr/bin/env bash
# run-dev.sh — 启动开发态应用（后端 server + web dev server + electron 外壳）
# 参考: specs/tech/app/envs/[P0]scripts.md §3.2
#       specs/tech/app/package/[P0]package_structure.md §4.3
#
# source dev.env → 起 server（API_START_CMD）+ web dev（WEB_START_CMD）
#   → export VITE_DEV_SERVER_URL=http://127.0.0.1:${WEB_PORT} → tsc -b 编译 main
#   → electron .（读 app/electron/package.json main=dist/main.js）
# 缺 dev.env 或关键字段（API_PORT/WEB_PORT/DATA_DIR/API_START_CMD/WEB_START_CMD）→ 非 0 退出
# 退出码：进程退出码透传
#
# ⚠️ Bash 3.2 兼容：禁用 `wait -n`（bash 4+ 才有）。轮询 kill -0。
set -euo pipefail

cd "$(dirname "$0")/.."

# --debug：启动 electron 时自动开 devtools（main.ts 检测 ROCKY_OPEN_DEVTOOLS=1 → openDevTools detach）。
# 用途：窗口创建即开 devtools，让 SSE agent_loop 连接建立时 devtools 已就位，Network/EventSource
# 面板能捕捉完整 event 流（排查「丢中间 message」类问题）。用法：./scripts/run-dev.sh --debug
if [ "${1:-}" = "--debug" ]; then
  export ROCKY_OPEN_DEVTOOLS=1
  echo "[run-dev.sh] --debug: electron devtools 将自动打开（detach），可用 Network/EventSource 观察 SSE"
fi

if [ ! -f ./dev.env ]; then
  echo "[run-dev.sh] ERROR: 缺失 dev.env，请执行 cp dev.env.example dev.env（参考 specs/tech/app/envs/[P0]environments.md §3.5）" >&2
  exit 1
fi

set -a
. ./dev.env
set +a

# 关键字段校验（含启动命令键）
for required in APP_NAME APP_ENV API_PORT WEB_PORT DATA_DIR API_START_CMD WEB_START_CMD HEALTH_ENDPOINT; do
  if [ -z "${!required:-}" ]; then
    echo "[run-dev.sh] ERROR: dev.env 缺关键字段 ${required}。请对照 dev.env.example 补齐。" >&2
    exit 2
  fi
done

echo "[run-dev.sh] APP_NAME=$APP_NAME env=$APP_ENV API_PORT=$API_PORT WEB_PORT=$WEB_PORT DATA_DIR=$DATA_DIR"

# 0a. 生成 app/server/app-version.json（dev/packaged 同源：读根 package.json version 写静态文件）。
#   server 启动前必须就绪，否则 app-version.ts.getAppVersion() 抛错。
echo "[run-dev.sh] 0a. generating app/server/app-version.json ..."
bun run gen-version

# 0a'. 构建 browser worker bundle（幂等，~1s）：headless/managed 常驻走 browser-worker.cjs，
#   产物已 gitignore（D-F），每次 dev 启动前重建保证协议最新（loop/chromePid 等）。
echo "[run-dev.sh] 0a'. building browser worker (bun run build:worker) ..."
bun run build:worker

# 0. 预清理残留端口（避免上次 Ctrl-C 残留进程占用 API_PORT/WEB_PORT → vite "Port already in use"）
#    [v0.0.105] 含 computer use dev loopback 端口（空值 for 循环安全跳过）
for p in "$API_PORT" "$WEB_PORT" "${ROCKY_DEV_COMPUTER_LOOPBACK_PORT:-}"; do
  [ -n "$p" ] || continue
  lsof -ti:"$p" 2>/dev/null | xargs kill 2>/dev/null || true
done
sleep 0.5

# 1. 起 @app/server（后端 Bun.serve，监听 API_PORT）
echo "[run-dev.sh] starting server: $API_START_CMD"
sh -c "$API_START_CMD" &
SERVER_PID=$!

# 2. 起 @app/web dev server（渲染层 Vite，监听 WEB_PORT）
echo "[run-dev.sh] starting web dev: $WEB_START_CMD"
sh -c "$WEB_START_CMD" &
WEB_PID=$!

# 3. 轮询 server 就绪（HEALTH_ENDPOINT），再起 electron
HEALTH_URL="http://127.0.0.1:${API_PORT}${HEALTH_ENDPOINT}"
echo "[run-dev.sh] waiting server ready at $HEALTH_URL ..."
for i in $(seq 1 60); do
  if kill -0 "$SERVER_PID" 2>/dev/null && curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "[run-dev.sh] server ready (after ${i}*0.5s)"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[run-dev.sh] ERROR: server 进程已退出，见日志" >&2
    exit 3
  fi
  sleep 0.5
done

# 4. 轮询 web dev server 端口就绪
WEB_URL="http://127.0.0.1:${WEB_PORT}/"
echo "[run-dev.sh] waiting web dev ready at $WEB_URL ..."
for i in $(seq 1 60); do
  if kill -0 "$WEB_PID" 2>/dev/null && curl -fsS "$WEB_URL" >/dev/null 2>&1; then
    echo "[run-dev.sh] web dev ready (after ${i}*0.5s)"
    break
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "[run-dev.sh] ERROR: web dev 进程已退出，见日志" >&2
    exit 3
  fi
  sleep 0.5
done

# 5. 编译 electron main + preload（dist/）然后起 electron 外壳
#    electron 读 package.json main=dist/main.js；先编译避免旧产物
echo "[run-dev.sh] building electron TS (tsc -b) ..."
(cd app/electron && bun run build:ts)

# 注入 VITE_DEV_SERVER_URL 让 main.ts resolveLoadTarget 走 dev URL 分支
export VITE_DEV_SERVER_URL="http://127.0.0.1:${WEB_PORT}"
echo "[run-dev.sh] starting electron (VITE_DEV_SERVER_URL=$VITE_DEV_SERVER_URL) ..."
(cd app/electron && bun run dev) &
ELECTRON_PID=$!

cleanup() {
  echo "[run-dev.sh] shutting down (server=$SERVER_PID web=$WEB_PID electron=$ELECTRON_PID)"
  kill "$ELECTRON_PID" 2>/dev/null || true
  kill "$WEB_PID" 2>/dev/null || true
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 任一子进程退出即跳出（bash 3.2 无 wait -n，用 kill -0 轮询）
EXIT_CODE=0
while kill -0 "$SERVER_PID" 2>/dev/null \
   && kill -0 "$WEB_PID" 2>/dev/null \
   && kill -0 "$ELECTRON_PID" 2>/dev/null; do
  sleep 0.5
done
# 取首个已退出子进程的退出码（best-effort）
wait "$SERVER_PID" 2>/dev/null || EXIT_CODE=$?
wait "$WEB_PID" 2>/dev/null || true
wait "$ELECTRON_PID" 2>/dev/null || true
echo "[run-dev.sh] a child exited (code=$EXIT_CODE)，开始清理"
exit "$EXIT_CODE"
