#!/bin/bash
# API 测试环境停止脚本（通用模板）
#
# 用途: 读 pidfile kill 进程；pidfile 失效则按端口 kill。
#
# 依赖的 env 变量:
#   APP_NAME       —— 应用名（默认 app），用于定位 pidfile
#   SERVER_PORT    —— 服务端口（默认 3701）
#   SERVER_PIDFILE —— pid 文件路径（默认 /tmp/${APP_NAME}-api-test.pid）
set +e

APP_NAME="${APP_NAME:-app}"
SERVER_PORT="${SERVER_PORT:-3701}"
SERVER_PIDFILE="${SERVER_PIDFILE:-/tmp/${APP_NAME}-api-test.pid}"

echo "[env_shutdown] stopping server (pidfile=$SERVER_PIDFILE port=$SERVER_PORT)..."

# 1. 读 pidfile kill
if [ -f "$SERVER_PIDFILE" ]; then
  PID="$(cat "$SERVER_PIDFILE" 2>/dev/null)"
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
  fi
  rm -f "$SERVER_PIDFILE"
fi

# 2. 按端口兜底
lsof -ti:$SERVER_PORT 2>/dev/null | xargs kill 2>/dev/null || true
sleep 0.3

# 3. 强杀
if lsof -ti:$SERVER_PORT > /dev/null 2>&1; then
  echo "[env_shutdown] force killing..."
  lsof -ti:$SERVER_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
fi

echo "[env_shutdown] done"
