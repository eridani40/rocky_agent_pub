# tests/lib/port_alloc.sh — 跨会话端口隔离（v0.0.215 方案 A 版本号编码 + B 全局注册表）
#
# 核心机制：
#   1. 端口基址 = 段前缀 + 版本后三位（worktree 名提取，如 v0.0.215 → 215）
#      - AT API 42000+后三位 / AT WEB 44000+后三位
#      - ET API 43000+后三位 / ET WEB 45000+后三位 / ET CDP 46000+后三位
#      不同版本 worktree 天然不同端口 → 不抢不撞。
#   2. 全局注册表 ~/.rocky_agent_test/_registry/（跨 worktree 端口占用真相源）
#      每 env 一文件 {kind}-{key}.env，字段 {worktree,kind,key,api_port,web_port,cdp_port,pid,started_at}。
#   3. 清残留只杀注册表声明 pid + 递归 descendants（cmdline marker 验证防 pid 复用误杀），
#      删除旧 `lsof -ti:$port | xargs kill` 裸杀（误杀兄弟 worktree 根源）。
#
# 向后兼容：旧 per-worktree .env_port 仍读写（run_case/run_all/cleanup_check 依赖），
# 全局注册表是新增的确权层（_port_registry_ports 改读它）。
#
# 参考: specs/tech/version_logs/v0.0.215/change_plan.md（端口隔离任务行）
#
# 用法（source 后）：
#   _port_version_suffix                         → echo 版本后三位（0-999）
#   _port_at_api_base / _port_at_web_base        → AT API/WEB 端口基址
#   _port_et_api_base / _port_et_web_base / _port_et_cdp_base → ET 三端口基址
#   _port_pick_free <base> <max>                 → echo 一个空端口（全局注册表 + lsof 双校验）
#   _port_register <api> <web> <pid> [mock_llm]  → AT env 登记成功后（写 .env_port + 全局注册表）
#   _port_et_register <cid> <api> <web> <cdp> <pid>  → ET case env 登记
#   _port_et_free <cid>                          → ET case 清全局注册表
#   _port_read / _port_mock / _port_pid          → 读 .env_port（向后兼容）
#   _port_free                                   → AT 清 .env_port + 全局注册表
#   _port_kill_tree <pid> [marker]               → 杀 pid + 递归 descendants（marker 验证 cmdline）
#   _port_cleanup_check                          → worktree 清理前检查 .env_port 残留

_PORT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
_PORT_WT="$(basename "$_PORT_ROOT")"
_PORT_FILE="$HOME/.rocky_agent_test/$_PORT_WT/.env_port"
_PORT_REG_DIR="$HOME/.rocky_agent_test/_registry"

# 端口段前缀（千段隔离，杜绝跨版本/跨 kind 重叠）
_PORT_AT_API_PREFIX=42000
_PORT_AT_WEB_PREFIX=44000
_PORT_ET_API_PREFIX=43000
_PORT_ET_WEB_PREFIX=45000
_PORT_ET_CDP_PREFIX=46000
_PORT_WINDOW=19   # 基址 + 0~19 容错窗口（基址被偶发占用时的回退空间）

# 版本后三位（0-999）：优先 worktree 目录名（会话版本真相，package.json 开发期滞后）；
# worktree 名无版本号（如 tmp-regression 回归 worktree）则回退 package.json version。
_port_version_suffix() {
  local numver patch pkgver
  numver=$(echo "$_PORT_WT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ -z "$numver" ] && [ -f "$_PORT_ROOT/package.json" ]; then
    pkgver=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' "$_PORT_ROOT/package.json" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
    numver="$pkgver"
  fi
  [ -z "$numver" ] && { echo 0; return; }
  patch="${numver##*.}"           # 取 patch 段
  echo $((10#$patch % 1000))      # 后三位（10# 强制十进制，去前导零）
}

_port_at_api_base() { echo $(( _PORT_AT_API_PREFIX + $(_port_version_suffix) )); }
_port_at_web_base() { echo $(( _PORT_AT_WEB_PREFIX + $(_port_version_suffix) )); }
_port_et_api_base() { echo $(( _PORT_ET_API_PREFIX + $(_port_version_suffix) )); }
_port_et_web_base() { echo $(( _PORT_ET_WEB_PREFIX + $(_port_version_suffix) )); }
_port_et_cdp_base() { echo $(( _PORT_ET_CDP_PREFIX + $(_port_version_suffix) )); }

# ── 全局注册表（跨 worktree 端口占用真相源）──────────────────────────────────
# 文件名：<kind>-<key>.env（kind=at/et，key=worktree 名 或 ET case_id）
_port_registry_file() { echo "$_PORT_REG_DIR/$1.env"; }

# 写入全局注册表
_port_registry_add() {
  local kind="$1" key="$2" api_port="$3" web_port="$4" pid="$5"
  shift 5 2>/dev/null || true
  local extra="$*" ts
  mkdir -p "$_PORT_REG_DIR"
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)
  cat > "$(_port_registry_file "$kind-$key")" <<EOF
worktree=$_PORT_WT
kind=$kind
key=$key
api_port=$api_port
web_port=$web_port
pid=$pid
${extra:+$extra}
started_at=$ts
EOF
}

_port_registry_remove() {
  [ -f "$(_port_registry_file "$1")" ] && rm -f "$(_port_registry_file "$1")"
}

# 所有在用端口（pid 活才算占用；stale 行 — pid 死 — 就地清理）
_port_registry_ports() {
  local f pid ap wp cp
  for f in "$_PORT_REG_DIR"/*.env; do
    [ -f "$f" ] || continue
    pid=$(grep -E '^pid=' "$f" | head -1 | cut -d= -f2)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      ap=$(grep -E '^api_port=' "$f" | head -1 | cut -d= -f2)
      wp=$(grep -E '^web_port=' "$f" | head -1 | cut -d= -f2)
      cp=$(grep -E '^cdp_port=' "$f" | head -1 | cut -d= -f2)
      [ -n "$ap" ] && echo "$ap"
      [ -n "$wp" ] && echo "$wp"
      [ -n "$cp" ] && echo "$cp"
    else
      rm -f "$f"   # stale 行（pid 死）→ 清理
    fi
  done
}

# 找一个空端口：全局注册表登记（boot-race 防抢）+ lsof 实际占用 双校验
_port_pick_free() {
  local base="$1" max="$2"
  local used; used=$(_port_registry_ports | sort -u)
  local p
  for ((p=base; p<=max; p++)); do
    echo "$used" | grep -qx "$p" && continue          # 全局注册表已登记（boot-race 防抢）
    lsof -ti:"$p" 2>/dev/null | grep -q . && continue  # 实际被占（lsof 主判定）
    echo "$p"; return 0
  done
  return 1
}

# ── AT env 登记（.env_port 向后兼容 + 全局注册表新增）──────────────────────────
_port_register() {
  mkdir -p "$(dirname "$_PORT_FILE")"
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)
  # mock_llm=server 启动时的 ROCKY_TEST_MOCK_LLM（旧 ET run_case.sh llm_mode gate 读它判断 real case 是否会假绿；
  # v0.0.127 起 ET 改 case.yaml + stub 通道，此 env 仅 server 启动时读，新框架不再经 llm_mode gate）
  cat > "$_PORT_FILE" <<EOF
worktree=$_PORT_WT
api_port=$1
web_port=$2
pid=$3
mock_llm=${4:-}
started_at=$ts
EOF
  _port_registry_add "at" "$_PORT_WT" "$1" "$2" "$3"
  echo "[port] registered worktree=$_PORT_WT api=$1 web=$2 pid=$3 mock_llm=${4:-} → $_PORT_FILE (+registry)"
}

_port_read() {
  [ -f "$_PORT_FILE" ] || return 1
  local ap wp
  ap=$(grep -E '^api_port=' "$_PORT_FILE" | head -1 | cut -d= -f2)
  wp=$(grep -E '^web_port=' "$_PORT_FILE" | head -1 | cut -d= -f2)
  echo "api_port=$ap web_port=$wp"
}

# server 启动时的 mock 标记（0/1）。无记录（旧 env_start / 手动启的 server）返空 → caller fail-open 不 skip。
_port_mock() {
  [ -f "$_PORT_FILE" ] || return 1
  grep -E '^mock_llm=' "$_PORT_FILE" | head -1 | cut -d= -f2
}

_port_pid() {
  [ -f "$_PORT_FILE" ] || return 1
  grep -E '^pid=' "$_PORT_FILE" | head -1 | cut -d= -f2
}

_port_free() {
  [ -f "$_PORT_FILE" ] && { rm -f "$_PORT_FILE"; echo "[port] freed $_PORT_FILE"; }
  _port_registry_remove "at-$_PORT_WT"
}

_port_cleanup_check() {
  if [ -f "$_PORT_FILE" ]; then
    echo "[port] WARN: worktree $_PORT_WT 仍有 env 注册 ($_PORT_FILE)"
    grep -E '^(worktree|api_port|web_port|pid)=' "$_PORT_FILE"
    echo "[port] 先跑 tests/api/env_shutdown.sh 再删 worktree"
    return 1
  fi
  return 0
}

# ── ET case env 登记/释放（per-case，复用全局注册表）──────────────────────────
# extra 字段：cdp_port（electron 模式有值）
_port_et_register() {
  local cid="$1" api="$2" web="$3" cdp="$4" pid="$5"
  local extra=""
  [ -n "$cdp" ] && extra="cdp_port=$cdp"
  _port_registry_add "et" "$cid" "$api" "$web" "$pid" $extra
  echo "[port] et registered case=$cid api=$api web=$web cdp=${cdp:-n/a} pid=$pid (+registry)"
}

_port_et_free() {
  _port_registry_remove "et-$1"
}

# ── 杀进程树（pid + 递归 descendants）— 清残留专用，替代旧 lsof 裸杀 ──────────
# marker 非空时先验证 root pid 的 cmdline 包含 marker（防 pid 复用后误杀无关进程）。
# 递归收集 descendants → 倒序 SIGTERM（子先于父）→ 0.3s → SIGKILL 顽固。
_port_kill_tree() {
  local root="$1" marker="${2:-}"
  [ -n "$root" ] || return 0
  kill -0 "$root" 2>/dev/null || return 0
  # cmdline 验证（marker 非空时）— 防 pid 复用后杀到无关进程
  if [ -n "$marker" ]; then
    local cmd; cmd=$(ps -o command= -p "$root" 2>/dev/null || true)
    case "$cmd" in
      *"$marker"*) ;;  # 匹配，继续
      *) echo "[port] WARN: pid=$root cmdline 不含 marker='$marker', 实际 cmdline=$cmd, 跳过避免误杀" >&2; return 0 ;;
    esac
  fi
  # 递归收集 descendants（BFS — pgrep -P 找每层子进程）
  local all=("$root") queue=("$root")
  while [ "${#queue[@]}" -gt 0 ]; do
    local head="${queue[0]}"; queue=("${queue[@]:1}")
    local children c
    children=$(pgrep -P "$head" 2>/dev/null || true)
    for c in $children; do all+=("$c"); queue+=("$c"); done
  done
  # 倒序 SIGTERM（descendants 先于 root，避免父进程早死孤儿化子进程）
  local i
  for ((i=${#all[@]}-1; i>=0; i--)); do kill -TERM "${all[$i]}" 2>/dev/null || true; done
  sleep 0.3
  # SIGKILL 仍存活的
  for ((i=${#all[@]}-1; i>=0; i--)); do
    kill -0 "${all[$i]}" 2>/dev/null && kill -KILL "${all[$i]}" 2>/dev/null || true
  done
}
