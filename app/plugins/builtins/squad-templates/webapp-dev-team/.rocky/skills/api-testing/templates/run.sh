#!/bin/bash
# API 测试 case 执行入口（通用模板）
# 自动向上查找项目根（含 package.json 的目录），调用 lib/runner.py 执行 checkpoint.json。
#
# 依赖的 env 变量（runner.py 内部读取，需在调用前 export 或写入 ./test.env）:
#   BASE_URL / DATA_ROOT / APP_NAME / TEST_ENV / SERVER_PORT
#
# 用法: 在 case 目录下执行 ./run.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 向上查找项目根
ROOT_DIR="$SCRIPT_DIR"
while [ "$ROOT_DIR" != "/" ]; do
  if [ -f "$ROOT_DIR/package.json" ]; then break; fi
  ROOT_DIR="$(dirname "$ROOT_DIR")"
done

# lib 目录约定: $ROOT_DIR/tests/api/lib/runner.py
RUNNER="$ROOT_DIR/tests/api/lib/runner.py"
if [ ! -f "$RUNNER" ]; then
  echo "[run.sh] ERROR: 未找到 runner.py ($RUNNER)" >&2
  exit 2
fi

python3 "$RUNNER" "$SCRIPT_DIR/checkpoint.json"
