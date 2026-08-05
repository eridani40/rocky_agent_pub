#!/usr/bin/env bash
# unit-test.sh — 跑全量单元测试
# 参考: specs/tech/app/envs/[P0]scripts.md §3.1
#
# source test.env → bun run test（即 npx vitest run）
# 缺 test.env 或关键字段（API_PORT/WEB_PORT）→ 非 0 退出并提示从 .example 拷贝
# 退出码：vitest 退出码透传
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f ./test.env ]; then
  echo "[unit-test.sh] ERROR: 缺失 test.env，请执行 cp test.env.example test.env（参考 specs/tech/app/envs/[P0]environments.md §3.5）" >&2
  exit 1
fi

# source test.env（含 set -a 让所有变量自动 export，供子进程读）
set -a
. ./test.env
set +a

# 关键字段校验（缺则报错，参考 scripts.md §4.4 不留默认值兜底）
for required in APP_NAME APP_ENV API_PORT WEB_PORT; do
  if [ -z "${!required:-}" ]; then
    echo "[unit-test.sh] ERROR: test.env 缺关键字段 $required。请对照 test.env.example 补齐。" >&2
    exit 2
  fi
done

echo "[unit-test.sh] APP_NAME=$APP_NAME env=$APP_ENV API_PORT=$API_PORT WEB_PORT=$WEB_PORT"
exec bun run test
