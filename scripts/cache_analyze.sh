#!/usr/bin/env bash
# cache_analyze.sh — 一键 trace 缓存分析（纯脚本，零 LLM 参与）
#
# 给一个 env + trace id：自动从 <env>.env 读 LANGFUSE_* 凭证 → 下载每 step 负载到
# logs/<traceId>/（step-NN.json + usage.json）→ 相邻 step(1→2,2→3...) 对比
# system(逐block)/tools(逐项)/messages(逐条) 报「前缀一致✅/分歧❌@位置+原文片段」
# → 每 step 缓存命中率表（cache_read/(cache_read+input)），<阈值(默认70%) ❌ 高亮 + 归因。
# 报告 = markdown，stdout 与 logs/<traceId>/result.md 同文（result.md 可直接 @ 给人看）。
#
# 用法:
#   bash scripts/cache_analyze.sh --env prod --tid <traceId> [--threshold=70]
#   bash scripts/cache_analyze.sh --env prod 123          # 位置参数也行
#   bash scripts/cache_analyze.sh --tid <traceId>         # --env 缺省 prod
#
# --env prod|test|dev：只是去读 repo 根 <env>.env 拿 LANGFUSE_BASE_URL/_PUBLIC_KEY/_SECRET_KEY。
# 离线复分析（不联网，用已下载的 logs/<traceId>/）：
#   python3 .claude/skills/langfuse-fetcher/references/trace_cache_report.py --dir=logs/<traceId>
#
# 分析内核：.claude/skills/langfuse-fetcher/references/trace_cache_report.py（单一实现，本脚本只是入口）。
set -euo pipefail

usage() { sed -n '2,20p' "$0"; }

ENV=prod; TID=""; THRESH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env)        ENV="${2:?--env 需要值}"; shift 2 ;;
    --env=*)      ENV="${1#*=}"; shift ;;
    --tid)        TID="${2:?--tid 需要值}"; shift 2 ;;
    --tid=*)      TID="${1#*=}"; shift ;;
    --threshold)  THRESH="${2:?--threshold 需要值}"; shift 2 ;;
    --threshold=*) THRESH="${1#*=}"; shift ;;
    -h|--help)    usage; exit 0 ;;
    -*)           echo "cache_analyze.sh: 未知选项 '$1'" >&2; usage; exit 2 ;;
    *)            [ -z "$TID" ] && TID="$1" || { echo "cache_analyze.sh: 多余参数 '$1'" >&2; exit 2; }; shift ;;
  esac
done
[ -n "$TID" ] || { echo "cache_analyze.sh: 缺 --tid <traceId>" >&2; usage; exit 2; }

cd "$(dirname "$0")/.."
ENVFILE="$ENV.env"
[ -f "$ENVFILE" ] || { echo "cache_analyze.sh: 缺 $ENVFILE（--env prod|test|dev）" >&2; exit 1; }
set -a; . "./$ENVFILE"; set +a

ARGS=(--trace="$TID" --dir="logs/$TID")
[ -n "$THRESH" ] && ARGS+=(--threshold="$THRESH")
exec python3 .claude/skills/langfuse-fetcher/references/trace_cache_report.py "${ARGS[@]}"
