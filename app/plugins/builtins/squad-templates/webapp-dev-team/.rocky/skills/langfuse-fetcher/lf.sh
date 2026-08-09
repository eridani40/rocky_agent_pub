#!/usr/bin/env bash
# langfuse-fetcher CLI (lf.sh) — 通用只读 Langfuse 查询工具。
#
# 凭证：环境变量 > repo 根 test.env（LANGFUSE_BASE_URL / _PUBLIC_KEY / _SECRET_KEY）。
# 认证：HTTP Basic，user=public_key，password=secret_key。只发 GET /api/public/*。
# 输出：默认 pretty JSON（python3），--raw 输出原始；可管道到 jq/python/grep。
#
# 用法见 --help。逃生舱：lf.sh raw '<path?query>' 任意 GET。
set -u

usage() { cat <<'EOF'
lf.sh — 通用只读 Langfuse 查询 CLI

用法: lf.sh <subcommand> [filters] [options]

子命令:
  health                         探活
  traces    [filters]            列 trace（默认 limit=50）
  trace     <id>                 单 trace 详情
  observations [filters]         列 observation（--type=SPAN|GENERATION|EVENT）
  observation <id>               单 observation 详情
  scores    [filters]            列 score
  score     <id>                 单 score 详情
  sessions  [filters]            列 session
  session   <id>                 单 session 详情
  users     [filters]            列 user
  user      <id>                 单 user 详情
  query     <queryId>            执行已保存 query
  raw       <path>               任意 GET /api/public/<path>（可含 ?a=b）

过滤参数（--key=value，转 langfuse query string；常用别名）:
  --session  → sessionId     --user → userId      --trace → traceId
  --type     → type          --name → name        --tag   → tags
  --from     → fromTimestamp --to   → toTimestamp
  --env      → environment   --limit / --page 分页

选项:
  --raw            输出原始 JSON（不美化）
  --out=FILE       写入文件（默认 stdout）
  -h, --help       本帮助

例:
  lf.sh health
  lf.sh traces --session=sess_abc --limit=10
  lf.sh trace tr_xyz
  lf.sh observations --trace=tr_xyz --type=GENERATION
  lf.sh traces --limit=20 | jq '.data[] | {id,name,tokens:.usage.totalTokens}'
  lf.sh raw 'traces?limit=5'
EOF
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 向上找含 test.env 的 repo 根
ROOT_DIR="$SCRIPT_DIR"
while [ "$ROOT_DIR" != "/" ]; do
  [ -f "$ROOT_DIR/test.env" ] && break
  ROOT_DIR="$(dirname "$ROOT_DIR")"
done

# 凭证：已设 env > test.env
if [ -z "${LANGFUSE_BASE_URL:-}" ] || [ -z "${LANGFUSE_PUBLIC_KEY:-}" ] || [ -z "${LANGFUSE_SECRET_KEY:-}" ]; then
  if [ -f "$ROOT_DIR/test.env" ]; then set -a; . "$ROOT_DIR/test.env" 2>/dev/null || true; set +a; fi
fi
: "${LANGFUSE_BASE_URL:?lf.sh: 缺 LANGFUSE_BASE_URL（在 test.env 或环境变量提供）}"
: "${LANGFUSE_PUBLIC_KEY:?lf.sh: 缺 LANGFUSE_PUBLIC_KEY}"
: "${LANGFUSE_SECRET_KEY:?lf.sh: 缺 LANGFUSE_SECRET_KEY}"

AUTH="$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY"
API="${LANGFUSE_BASE_URL%/}/api/public"

SUB="${1:-}"
[ $# -gt 0 ] && shift || true
[ -z "$SUB" ] && { usage; exit 1; }
if [ "$SUB" = "-h" ] || [ "$SUB" = "--help" ]; then usage; exit 0; fi

RAW_OUT=0
OUT=""
LIMIT_DEFAULT="50"
declare -a POSITIONAL=()
declare -a QP=()

map_param() {
  case "$1" in
    trace) echo traceId ;; session) echo sessionId ;; user) echo userId ;;
    tag) echo tags ;; from) echo fromTimestamp ;; to) echo toTimestamp ;;
    env) echo environment ;; *) echo "$1" ;;
  esac
}

for arg in "$@"; do
  case "$arg" in
    --raw) RAW_OUT=1 ;;
    --out=*) OUT="${arg#*=}" ;;
    --help|-h) usage; exit 0 ;;
    --limit=*) QP+=("limit=${arg#*=}") ;;
    --page=*) QP+=("page=${arg#*=}") ;;
    --*=*)
      k="${arg%%=*}"; k="${k#--}"; v="${arg#*=}"
      QP+=("$(map_param "$k")=$v")
      ;;
    --*|-*) echo "lf.sh: 未知选项 '$arg'（查询参数用 --key=value）" >&2; exit 2 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

# 决定 path + 模式
case "$SUB" in
  health)       PATH_="health"; MODE="get" ;;
  trace)        [ "${#POSITIONAL[@]}" -ge 1 ] || { echo "lf.sh: trace 需要 <id>" >&2; exit 2; }; PATH_="traces/${POSITIONAL[0]}"; MODE="get" ;;
  traces)       PATH_="traces"; MODE="list" ;;
  observation)  [ "${#POSITIONAL[@]}" -ge 1 ] || { echo "lf.sh: observation 需要 <id>" >&2; exit 2; }; PATH_="observations/${POSITIONAL[0]}"; MODE="get" ;;
  observations) PATH_="observations"; MODE="list" ;;
  score)        [ "${#POSITIONAL[@]}" -ge 1 ] || { echo "lf.sh: score 需要 <id>" >&2; exit 2; }; PATH_="scores/${POSITIONAL[0]}"; MODE="get" ;;
  scores)       PATH_="scores"; MODE="list" ;;
  session)      [ "${#POSITIONAL[@]}" -ge 1 ] || { echo "lf.sh: session 需要 <id>" >&2; exit 2; }; PATH_="sessions/${POSITIONAL[0]}"; MODE="get" ;;
  sessions)     PATH_="sessions"; MODE="list" ;;
  user)         [ "${#POSITIONAL[@]}" -ge 1 ] || { echo "lf.sh: user 需要 <id>" >&2; exit 2; }; PATH_="users/${POSITIONAL[0]}"; MODE="get" ;;
  users)        PATH_="users"; MODE="list" ;;
  query)        [ "${#POSITIONAL[@]}" -ge 1 ] || { echo "lf.sh: query 需要 <queryId>" >&2; exit 2; }; PATH_="queries/${POSITIONAL[0]}/execute"; MODE="get" ;;
  raw)          [ "${#POSITIONAL[@]}" -ge 1 ] || { echo "lf.sh: raw 需要 <path>" >&2; exit 2; }; PATH_="${POSITIONAL[0]}"; MODE="raw" ;;
  *) echo "lf.sh: 未知子命令 '$SUB'" >&2; usage >&2; exit 2 ;;
esac

# list 模式默认补 limit
if [ "$MODE" = "list" ]; then
  has_limit=0
  if [ "${#QP[@]}" -gt 0 ]; then
    for q in "${QP[@]}"; do case "$q" in limit=*) has_limit=1 ;; esac; done
  fi
  [ "$has_limit" = 0 ] && QP=("limit=$LIMIT_DEFAULT" "${QP[@]}")
fi

# 组 URL
URL="$API/$PATH_"
if [ "${#QP[@]}" -gt 0 ]; then
  QS=$(printf '%s&' "${QP[@]}"); QS="${QS%&}"
  case "$URL" in
    *\?*) URL="$URL&$QS" ;;     # raw 自带 ?
    *) URL="$URL?$QS" ;;
  esac
fi

BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT
# -g 关 URL globbing：raw query 里的 [ ] { } 不被当 glob/范围展开
HTTP="$(curl -g -sS -o "$BODY" -w "%{http_code}" -u "$AUTH" "$URL" 2>/dev/null)" || {
  echo "lf.sh: curl failed (instance unreachable? LANGFUSE_BASE_URL=$LANGFUSE_BASE_URL)" >&2; exit 1; }

if ! [[ "$HTTP" =~ ^[0-9]+$ ]] || [ "$HTTP" -ge 400 ]; then
  echo "lf.sh: HTTP $HTTP  $URL" >&2
  sed 's/^/  /' "$BODY" >&2
  exit 1
fi

emit() {
  if [ "$RAW_OUT" = 1 ] || ! command -v python3 >/dev/null 2>&1; then
    cat "$BODY"
  else
    python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), indent=2, ensure_ascii=False))' <"$BODY" 2>/dev/null || cat "$BODY"
  fi
}

if [ -n "$OUT" ]; then
  emit >"$OUT"; echo "lf.sh: 写入 $OUT（HTTP $HTTP）" >&2
else
  emit
fi
