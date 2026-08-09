#!/bin/bash
# API 测试环境启动脚本（通用模板）
#
# 用途:
#   1. cd 到项目根（向上找 package.json）
#   2. source ./test.env（存在则加载项目自定义环境变量）
#   3. 清理残留端口 / pidfile
#   4. 用 SERVER_START_CMD 启动服务，写 pidfile
#   5. 轮询 HEALTH_PATH 直到就绪
#
# 依赖的 env 变量（都有默认值，除 SERVER_START_CMD 外）:
#   APP_NAME          —— 应用名，用于日志/pidfile 命名（默认 app）
#   TEST_ENV          —— 环境标识（默认 test）
#   SERVER_PORT       —— 服务端口（默认 3701）
#   BASE_URL          —— 服务根地址（默认 http://localhost:${SERVER_PORT}）
#   HEALTH_PATH       —— 健康检查路径（默认 /health）
#   SERVER_START_CMD  —— 启动命令（必填，项目自填，例如 "bun run src/server.ts"）
#   SERVER_PIDFILE    —— pid 文件路径（默认 /tmp/${APP_NAME}-api-test.pid）
#   DATA_ROOT         —— 数据根目录（默认 ~/.${APP_NAME}_${TEST_ENV}）
#
# 跨项目说明:
#   - 此脚本不写死任何启动命令；请把 SERVER_START_CMD 放进 ./test.env 或直接 export。
#   - 启动时会以 env 前缀形式把 APP_NAME/TEST_ENV/SERVER_PORT/DATA_ROOT 注入到子进程。
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. cd 到项目根
ROOT_DIR="$SCRIPT_DIR"
while [ "$ROOT_DIR" != "/" ]; do
  if [ -f "$ROOT_DIR/package.json" ]; then break; fi
  ROOT_DIR="$(dirname "$ROOT_DIR")"
done
cd "$ROOT_DIR"

# 2. 加载项目自定义环境变量（test.env 存在则加载）
if [ -f ./test.env ]; then
  set -a
  source ./test.env
  set +a
fi

# 3. 解析变量（带默认值）
APP_NAME="${APP_NAME:-app}"
TEST_ENV="${TEST_ENV:-test}"
SERVER_PORT="${SERVER_PORT:-3701}"
BASE_URL="${BASE_URL:-http://localhost:${SERVER_PORT}}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
SERVER_PIDFILE="${SERVER_PIDFILE:-/tmp/${APP_NAME}-api-test.pid}"
DATA_ROOT="${DATA_ROOT:-$HOME/.${APP_NAME}_${TEST_ENV}}"

if [ -z "${SERVER_START_CMD:-}" ]; then
  echo "[env_start] ERROR: SERVER_START_CMD 未设置。请在 ./test.env 或环境中提供，例如 SERVER_START_CMD=\"bun run src/server.ts\"" >&2
  exit 2
fi

echo "[env_start] APP_NAME=$APP_NAME TEST_ENV=$TEST_ENV port=$SERVER_PORT base=$BASE_URL data=$DATA_ROOT"

# 4. 清理残留
if [ -f "$SERVER_PIDFILE" ]; then
  kill "$(cat "$SERVER_PIDFILE" 2>/dev/null)" 2>/dev/null || true
  rm -f "$SERVER_PIDFILE"
fi
lsof -ti:$SERVER_PORT 2>/dev/null | xargs kill 2>/dev/null || true
sleep 0.5

# 5. 启动服务（注入 env 前缀）
nohup env APP_NAME="$APP_NAME" TEST_ENV="$TEST_ENV" \
  SERVER_PORT="$SERVER_PORT" BASE_URL="$BASE_URL" DATA_ROOT="$DATA_ROOT" \
  sh -c "$SERVER_START_CMD" > "/tmp/${APP_NAME}-api-test.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$SERVER_PIDFILE"

# 6. 轮询健康检查
HEALTH_URL="${BASE_URL}${HEALTH_PATH}"
for i in $(seq 1 30); do
  if curl -s "$HEALTH_URL" > /dev/null 2>&1; then
    echo "[env_start] server ready at $BASE_URL (pid=$SERVER_PID, health=$HEALTH_URL)"
    exit 0
  fi
  sleep 0.5
done
echo "[env_start] WARNING: server may not be ready (health=$HEALTH_URL not responding)" >&2
exit 0
