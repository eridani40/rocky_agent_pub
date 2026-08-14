#!/bin/bash
# tests/api/env_start.sh — 启动 server（NODE_ENV=test）
#
# ⚠️  AT 与 ET 不可并发：AT 共享 tests/lib/port_alloc.sh 注册表（.env_port）+ DATA_DIR
#     先跑 tests/api/env_shutdown.sh，再启本脚本。
#
# 端口：tests/lib/port_alloc.sh — v0.0.215 版本号编码（AT API=42000+后三位 / WEB=44000+后三位）
#     不同版本 worktree 天然隔离；全局注册表 _registry/ 跨 worktree 确权
# DATA_DIR：per-worktree（$HOME/.rocky_agent_test/<worktree>）
#
# 参考：design_storage_runall.md §5；change_plan C 组 env_start.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 向上找 package.json 确定项目根
ROOT_DIR="$SCRIPT_DIR"
while [ "$ROOT_DIR" != "/" ]; do
  [ -f "$ROOT_DIR/package.json" ] && break
  ROOT_DIR="$(dirname "$ROOT_DIR")"
done
cd "$ROOT_DIR"

# test.env 在 tests/ 下（AT/ET 共用）
TESTS_DIR="$ROOT_DIR/tests"
[ -f "$TESTS_DIR/test.env" ] || {
  echo "[env_start] ERROR: $TESTS_DIR/test.env missing"
  exit 2
}

APP_NAME="${APP_NAME:-rocky_agent}"
WT="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "$ROOT_DIR")")"

# 1. source committed schema
set -a; source "$TESTS_DIR/test.env"; set +a

# 2. overlay global secrets
SECRETS="$HOME/.rocky_agent/test.secrets.env"
if [ -f "$SECRETS" ]; then
  set -a; source "$SECRETS"; set +a
else
  echo "[env_start] WARN: no $SECRETS — Langfuse/Jina/Zhipu unavailable"
fi

# 3. port registry（复用旧 tests/lib/port_alloc.sh，共享 .env_port）
. "$TESTS_DIR/lib/port_alloc.sh"

# 4. DATA_DIR per-worktree
[ -z "${DATA_DIR:-}" ] && DATA_DIR="$HOME/.rocky_agent_test/$WT"
export DATA_DIR
mkdir -p "$DATA_DIR"

# 5. 分配空闲端口（v0.0.215 起版本号编码：AT API=42000+后三位 / WEB=44000+后三位，
#    不同版本 worktree 天然不同段；_port_pick_free 再叠全局注册表 + lsof 双校验选具体口）
_AT_API_BASE=$(_port_at_api_base); _AT_WEB_BASE=$(_port_at_web_base)
API_PORT="$(_port_pick_free "$_AT_API_BASE" $((_AT_API_BASE + 19)))" || {
  echo "[env_start] ERROR: no free API port in $_AT_API_BASE-$((_AT_API_BASE + 19))"
  exit 2
}
WEB_PORT="$(_port_pick_free "$_AT_WEB_BASE" $((_AT_WEB_BASE + 19)))" || {
  echo "[env_start] ERROR: no free WEB port in $_AT_WEB_BASE-$((_AT_WEB_BASE + 19))"
  exit 2
}
export API_PORT WEB_PORT
export SERVER_PORT="$API_PORT"
export BASE_URL="http://127.0.0.1:$API_PORT"
export DATA_ROOT="$DATA_DIR"
export SERVER_URL="$BASE_URL"
export RENDERER_PORT="$WEB_PORT"
export RENDERER_URL="http://127.0.0.1:$WEB_PORT"

# 6. validate required
[ -n "${API_START_CMD:-}" ] || {
  echo "[env_start] ERROR: API_START_CMD unset"
  exit 2
}

echo "[env_start] DATA_DIR=$DATA_DIR  worktree=$WT  api=$API_PORT"

# 7. clean stale pidfile
PIDFILE="/tmp/${APP_NAME}-${WT}-v2.pid"
[ -f "$PIDFILE" ] && {
  kill "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null || true
  rm -f "$PIDFILE"
}

# 8. globalize provider pool（symlink 用户 provider 配置 → per-worktree DATA_DIR）
# v0.0.190 用户裁决：test env 优先（self-contained，不依赖 dev 运行态）；
# providers 不 copy dev（case 硬编码 test pool ULID），仅 symlink test pool。
PROV_POOL="$HOME/.rocky_agent_test/app_config/providers"
mkdir -p "$DATA_DIR/app_config"
if [ -d "$PROV_POOL" ] && [ ! -e "$DATA_DIR/app_config/providers" ]; then
  ln -s "$PROV_POOL" "$DATA_DIR/app_config/providers"
  echo "[env_start] linked global provider pool → $DATA_DIR/app_config/providers"
fi

# ── v0.0.190: dev 真实凭证 copy 到 test DATA_DIR（test 优先，但需真实 key）──
# 5 组技术配置（web_search/see_image/runtime/web/consolidation）：优先 copy dev config 内容
# 到 test DATA_DIR（cp -rL 解引用 symlink，让 test env self-contained）；
# dev 不存在则回退 symlink test pool（兼容旧环境，但 test pool web_search 是假 key 致 case fail）。
# providers 不 copy（case 硬编码 test pool ULID）；default_models 不 copy（保 minimax）。
DEV_APP_CONFIG="$HOME/.rocky_agent_dev/app_config"
for _grp in web_search see_image runtime web consolidation; do
  _DEST="$DATA_DIR/app_config/$_grp"
  [ -e "$_DEST" ] && continue
  if [ -d "$DEV_APP_CONFIG/$_grp" ]; then
    # -L: 解引用 symlink，copy 实际内容（test env self-contained，不依赖 dev 运行态）
    cp -rL "$DEV_APP_CONFIG/$_grp" "$_DEST"
    echo "[env_start] copied dev $_grp → $_DEST"
  elif [ -d "$HOME/.rocky_agent_test/app_config/$_grp" ]; then
    ln -s "$HOME/.rocky_agent_test/app_config/$_grp" "$_DEST"
    echo "[env_start] linked test $_grp (dev missing) → $_DEST"
  fi
done

# 8b. 构建 browser worker bundle（幂等，~1s）：headless/managed 常驻走 browser-worker.cjs，
#   产物已 gitignore（D-F），每次 test/ET 启动前重建保证协议最新（loop/chromePid 等）。
echo "[env_start] 8b. building browser worker (bun run build:worker) ..."
(cd "$ROOT_DIR" && bun run build:worker)

# 9. start server（NODE_ENV=test，继承 secret 环境变量）
ROCKY_TEST_MOCK_LLM="${ROCKY_TEST_MOCK_LLM:-0}"
# computer native port mock（AT 默认 mock，禁止真实 OS 操作；外部可覆盖为 off 测真实路径）
ROCKY_TEST_COMPUTER_NATIVE_PORT="${ROCKY_TEST_COMPUTER_NATIVE_PORT:-mock}"
nohup env APP_NAME="$APP_NAME" APP_ENV="test" NODE_ENV=test \
  API_PORT="$API_PORT" WEB_PORT="$WEB_PORT" DATA_DIR="$DATA_DIR" \
  SERVER_PORT="$API_PORT" DATA_ROOT="$DATA_DIR" BASE_URL="$BASE_URL" \
  HEADLESS="${HEADLESS:-true}" ROCKY_TEST_MOCK_LLM="$ROCKY_TEST_MOCK_LLM" \
  ROCKY_TEST_COMPUTER_NATIVE_PORT="$ROCKY_TEST_COMPUTER_NATIVE_PORT" \
  SCHEDULER_TICK_MS="${SCHEDULER_TICK_MS:-86400000}" \
  LANGFUSE_BASE_URL="${LANGFUSE_BASE_URL:-}" \
  LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-}" \
  LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-}" \
  sh -c "$API_START_CMD" > "/tmp/${APP_NAME}-${WT}-v2.log" 2>&1 &
echo $! > "$PIDFILE"

# 10. health check（15s timeout，500ms 间隔）+ post-boot seed
for i in $(seq 1 30); do
  if curl -sf "${BASE_URL}${HEALTH_ENDPOINT}" >/dev/null 2>&1; then
    PID="$(cat "$PIDFILE")"
    echo "[env_start] ready at $BASE_URL (pid=$PID)"

    # 11. post-boot seed：确保 test provider 的 contextWindow=300000（对齐 dev 环境值）
    # 背景：tokenLimit < system+tools tokens(≈31k) 会触发 compact sibling 双发，
    #       录制/回放帧数不一致导致 drift。contextWindow=300000 >>> 31k，彻底消除触发。
    # 对 TEST_PROVIDER_ID + TEST_FALLBACK_PROVIDER_ID 各 model 都设一次（幂等，model 存在才生效）。
    TEST_CONTEXT_WINDOW=300000
    for _pid_mid in \
      "${TEST_PROVIDER_ID:-}:${TEST_MODEL_ID:-}" \
      "${TEST_FALLBACK_PROVIDER_ID:-}:${TEST_FALLBACK_MODEL_ID:-}"; do
      _pid="${_pid_mid%%:*}"
      _mid="${_pid_mid##*:}"
      [ -z "$_pid" ] || [ -z "$_mid" ] && continue
      curl -sf -X PUT "${BASE_URL}/provider/${_pid}/model/${_mid}" \
        -H 'Content-Type: application/json' \
        -d "{\"modelId\":\"${_mid}\",\"contextWindow\":${TEST_CONTEXT_WINDOW}}" >/dev/null \
        && echo "[env_start] contextWindow=${TEST_CONTEXT_WINDOW} set for ${_pid}/${_mid}" \
        || echo "[env_start] WARN: failed to set contextWindow for ${_pid}/${_mid} (provider may not exist)"
    done

    # 12. see_image app_config 已由第 8 步 copy（dev see_image config 含真实 minimax_m3 key）。
    # 原 POST /config/app seed 段已冗余（v0.0.141 D1 seed 是 copy 机制缺失时的替代）。

    # 注册到 port_alloc（mock_llm=0 表示真实 LLM 模式）
    _port_register "$API_PORT" "$WEB_PORT" "$PID" "$ROCKY_TEST_MOCK_LLM"
    exit 0
  fi
  sleep 0.5
done
echo "[env_start] ERROR: server not ready in 15s — see /tmp/${APP_NAME}-${WT}-v2.log"
exit 1
