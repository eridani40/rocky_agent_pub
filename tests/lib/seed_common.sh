#!/bin/bash
# tests/lib/seed_common.sh — 测试环境启动时的公共种子逻辑。
# 被 api/env_start.sh 和 e2e/env_start.sh 共同 source，确保两种执行路径种子行为完全一致。
#
# 调用方须在 source 本文件前保证：
#   TESTS_DIR   — tests/ 根目录（含 test.env）
#   DATA_DIR    — 本 worktree 测试数据目录
#   BASE_URL    — http://127.0.0.1:$API_PORT
#   HEALTH_ENDPOINT — 健康检查路径（默认 /health）
#   TEST_MODEL_ID / TEST_FALLBACK_MODEL_ID（可选，来自 test.env）
#   LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY（可选，来自 secrets）
#
# 提供两个函数，调用方按执行阶段分别调用：
#   seed_pre_boot   — server 启动前（observability 文件种子 + computer env）
#   seed_post_boot  — server health check 通过后（default_models 真实 API PUT）

# ── pre-boot：必须在 server 进程启动前调用 ──────────────────────────────────────
seed_pre_boot() {
  # 1. Langfuse observability 配置文件种子
  # ObservabilityManager 是 bootstrap-time 单例，不热更新；必须在进程启动前写文件。
  # 参见 specs/tech/config/[P0]dev_config.md §3.4.1 + specs/tech/agent/observability/[P0]observability_manager.md
  if [ -n "${LANGFUSE_BASE_URL:-}" ] && [ -n "${LANGFUSE_PUBLIC_KEY:-}" ] && [ -n "${LANGFUSE_SECRET_KEY:-}" ]; then
    . "$TESTS_DIR/api/lib/langfuse_setup.sh"
    lf_ensure_observability "$DATA_DIR" "$LANGFUSE_BASE_URL" "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY"
  fi

  # 2. computer_use mock native port（v0.0.105）
  # 真 OS 截图在 CI/Linux 不可用，AT/ET computer_use case 依赖 mock native port。
  # 注入到当前 shell，后续 nohup env ... 启动 server 时会带上此值。
  ROCKY_TEST_COMPUTER_NATIVE_PORT="${ROCKY_TEST_COMPUTER_NATIVE_PORT:-mock}"
  export ROCKY_TEST_COMPUTER_NATIVE_PORT
}

# ── post-boot：在 server health check 通过后立即调用 ─────────────────────────────
seed_post_boot() {
  local base_url="${BASE_URL:-}"
  local model_id="${TEST_MODEL_ID:-}"
  local fallback_id="${TEST_FALLBACK_MODEL_ID:-$model_id}"

  # default_models 全局前置：经真实 API PUT 建立（真实写路径 id=ULID，非文件 seed mock）。
  # 幂等：已存在则 set 复用其 ULID 走 update；不存在则 insert 新 ULID。
  # 缺少 model_id 时跳过（如纯 mock 模式不需要配置真实模型）。
  if [ -n "$model_id" ] && [ -n "$base_url" ]; then
    curl -sf -X PUT "$base_url/config/app" -H 'Content-Type: application/json' \
      -d "{\"group\":\"default_models\",\"key\":\"default\",\"data\":{\"chat\":\"$model_id\",\"summary\":\"$fallback_id\"}}" >/dev/null \
      && echo "[seed_common] default_models set via real API: chat=$model_id summary=$fallback_id" \
      || echo "[seed_common] WARN: default_models real-API PUT failed"
  fi
}
