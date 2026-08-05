#!/usr/bin/env bash
# tests/e2e/env.sh — ET 单 case 环境一键启停
#
# 职责：为单个 case 启停独立 test 环境（server + web dev [+ electron]），
# 每 case 独立 DATA_DIR 用完即清，端口段与 AT 隔离（v0.0.215 起版本号编码：
#   ET API=43000+后三位 / WEB=45000+后三位 / CDP=46000+后三位；与 AT 42xxx/44xxx 段天然分离）。
# 设计：nohup + pidfile + 轮询 health；DATA_DIR 绝对路径展开（$HOME，禁字面 ~）；pidfile 精确 kill（禁 pkill -f）。
# v0.0.215：清残留改 cmdline 验证（_kill_port_orphans 只杀本服务孤儿），删旧 lsof 裸杀；
#           全局注册表 _registry/ 跨 worktree/跨 case 确权。
# 参考: reqs/[working] v0.0.188.et-playwright-agent/req.md（每 case 独立环境 + 双模式）
#       scripts/run-test.sh（electron 模式蓝本：起 server + web + electron 外壳）
#       memory BUG-004 / pkill-wide-match-kills-other-worktrees
#
# 用法:
#   tests/e2e/env.sh start <case_id> [--mode=headless|electron]
#   tests/e2e/env.sh stop <case_id>
#   tests/e2e/env.sh case-data-dir <case_id>
#
# case_id 须匹配 [a-z0-9-]+；DATA_DIR 派生为 $HOME/.rocky_agent_et_<case_id>（绝对路径）。
# stop 用 pidfile 精确 kill（绝不 pkill -f 宽匹配）+ 删本 case DATA_DIR。
set -euo pipefail

# ── 常量 ─────────────────────────────────────────────────────────────────────
APP_NAME="rocky_agent"

# ── 路径定位 ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 项目根 = 往上找 package.json
ROOT_DIR="$SCRIPT_DIR"
while [ "$ROOT_DIR" != "/" ] && [ ! -f "$ROOT_DIR/package.json" ]; do
  ROOT_DIR="$(dirname "$ROOT_DIR")"
done
[ -f "$ROOT_DIR/package.json" ] || { echo "[env.sh] ERROR: 找不到项目根（package.json）" >&2; exit 2; }
TESTS_DIR="$ROOT_DIR/tests"

# v0.0.215 起端口 = 版本号编码基址（ET API=43000+后三位 / WEB=45000+后三位 / CDP=46000+后三位）。
# 不同版本 worktree 天然不同段；_pick_free_port 再叠全局注册表 + lsof 双校验选具体口。
# 基址由 tests/lib/port_alloc.sh 的 _port_et_*_base 派生（worktree 名提取版本后三位）。
. "$TESTS_DIR/lib/port_alloc.sh"   # 复用全局注册表 + 版本基址函数（_PORT_WT/_PORT_REG_DIR 等）
ET_API_PORT_BASE=$(_port_et_api_base); ET_API_PORT_MAX=$((ET_API_PORT_BASE + 19))
ET_WEB_PORT_BASE=$(_port_et_web_base); ET_WEB_PORT_MAX=$((ET_WEB_PORT_BASE + 19))
ET_CDP_PORT_BASE=$(_port_et_cdp_base); ET_CDP_PORT_MAX=$((ET_CDP_PORT_BASE + 19))

# ── 工具：case_id 校验 + DATA_DIR 派生 ───────────────────────────────────────
# 校验 case_id 仅含 [a-z0-9-]，避免奇怪字符污染路径 / pidfile 名
validate_case_id() {
  local cid="$1"
  if ! [[ "$cid" =~ ^[a-z0-9-]+$ ]]; then
    echo "[env.sh] ERROR: case_id '$cid' 不合法（须匹配 [a-z0-9-]+）" >&2
    return 2
  fi
}

# 派生本 case DATA_DIR（绝对路径，禁字面 ~ 拼接 — memory BUG-004）
case_data_dir() {
  local cid="$1"
  validate_case_id "$cid" || exit 2
  echo "$HOME/.rocky_agent_et_$cid"
}

# pidfile / portfile / log（均以 case_id 为 key，per-case 隔离）
_pidfile() { echo "/tmp/${APP_NAME}-et-$1.pid"; }
_portfile() { echo "/tmp/${APP_NAME}-et-$1.port"; }

# ── 工具：找空闲端口（全局注册表 + lsof 双校验）──────────────────────────────
# v0.0.215：复用 tests/lib/port_alloc.sh 的全局注册表 _port_registry_ports（boot-race 防抢，
# 跨 worktree/跨 case 端口占用真相源），叠加 lsof 实际占用判定。
_pick_free_port() {
  local base="$1" max="$2"
  local used; used=$(_port_registry_ports | sort -u)
  local p
  for ((p=base; p<=max; p++)); do
    echo "$used" | grep -qx "$p" && continue          # 全局注册表已登记（boot-race 防抢）
    lsof -ti:"$p" 2>/dev/null | grep -q . && continue  # 实际被占
    echo "$p"; return 0
  done
  echo "[env.sh] ERROR: ${base}-${max} 段无空闲端口" >&2
  return 1
}

# ── 工具：清理本 case 端口残留（cmdline marker 验证，只杀本服务孤儿）────────────
# v0.0.215：替代旧 `lsof -ti:$port | xargs kill` 裸杀。端口为版本编码基址（本 worktree 独占段），
# 残留只能是自己的孤儿；marker 验证双保险，绝不误杀无关/兄弟进程。
_ORPHAN_MARKERS='index.ts|app/web|electron|bun|vite'
_kill_port_orphans() {
  local port="$1" pids p cmd
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  [ -z "$pids" ] && return 0
  for p in $pids; do
    cmd=$(ps -o command= -p "$p" 2>/dev/null || true)
    if echo "$cmd" | grep -qE "$_ORPHAN_MARKERS"; then
      echo "[env.sh] 清理端口 $port 本服务孤儿 pid=$p"; kill "$p" 2>/dev/null || true
    elif [ -n "$cmd" ]; then
      echo "[env.sh] WARN: 端口 $port pid=$p 非本服务, cmdline=$cmd, 跳过" >&2
    fi
  done
  sleep 0.3
  # SIGKILL 顽固（同样 marker 验证）
  for p in $(lsof -ti:"$port" 2>/dev/null || true); do
    ps -o command= -p "$p" 2>/dev/null | grep -qE "$_ORPHAN_MARKERS" && kill -9 "$p" 2>/dev/null || true
  done
}

# ── start 子命令 ─────────────────────────────────────────────────────────────
cmd_start() {
  local cid="$1" mode="headless"
  shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --mode=*) mode="${1#--mode=}"; shift ;;
      *) echo "[env.sh] ERROR: 未知参数 $1" >&2; exit 2 ;;
    esac
  done
  validate_case_id "$cid" || exit 2
  case "$mode" in
    headless|electron) ;;
    *) echo "[env.sh] ERROR: --mode 仅支持 headless|electron（got: ${mode}）" >&2; exit 2 ;;
  esac

  # 拒绝重复 start（pidfile 存在 + pid 活）
  local pidfile; pidfile=$(_pidfile "$cid")
  if [ -f "$pidfile" ] && kill -0 "$(head -1 "$pidfile" 2>/dev/null)" 2>/dev/null; then
    echo "[env.sh] ERROR: case '$cid' 已在运行（pidfile=${pidfile}）" >&2; exit 3
  fi

  # 加载 test.env schema + 全局 secrets（与 AT 同源 — 复用其 provider pool 配置）
  [ -f "$TESTS_DIR/test.env" ] || { echo "[env.sh] ERROR: 缺 $TESTS_DIR/test.env" >&2; exit 2; }
  set -a; . "$TESTS_DIR/test.env"; set +a
  local secrets="$HOME/.rocky_agent/test.secrets.env"
  [ -f "$secrets" ] && { set -a; . "$secrets"; set +a; } || echo "[env.sh] WARN: 无 $secrets"

  # 派生 DATA_DIR + 分配端口
  local data_dir; data_dir=$(case_data_dir "$cid")
  local api_port web_port cdp_port=""
  api_port=$(_pick_free_port "$ET_API_PORT_BASE" "$ET_API_PORT_MAX") || exit 1
  web_port=$(_pick_free_port "$ET_WEB_PORT_BASE" "$ET_WEB_PORT_MAX") || exit 1
  if [ "$mode" = "electron" ]; then
    cdp_port=$(_pick_free_port "$ET_CDP_PORT_BASE" "$ET_CDP_PORT_MAX") || exit 1
  fi
  echo "[env.sh] case=$cid mode=$mode DATA_DIR=$data_dir api=$api_port web=$web_port cdp=${cdp_port:-n/a}"

  # 启动前清端口孤儿（防 packaged app 残留 / 上次 Ctrl-C 残留）
  _kill_port_orphans "$api_port"
  _kill_port_orphans "$web_port"
  [ -n "$cdp_port" ] && _kill_port_orphans "$cdp_port"

  # symlink 全局 provider pool（同 AT，使 app 内 provider 配置可用 — req 真实 LLM 调用必需）
  mkdir -p "$data_dir/app_config"
  local prov_pool="$HOME/.rocky_agent_test/app_config/providers"
  [ -d "$prov_pool" ] && [ ! -e "$data_dir/app_config/providers" ] && ln -s "$prov_pool" "$data_dir/app_config/providers"
  local ws_pool="$HOME/.rocky_agent_test/app_config/web_search"
  [ -d "$ws_pool" ] && [ ! -e "$data_dir/app_config/web_search" ] && ln -s "$ws_pool" "$data_dir/app_config/web_search"
  # default_models：避免每个 case 都要在 app 内手选模型（缺它模型 picker 显示「未配置」）
  local dm_pool="$HOME/.rocky_agent_test/app_config/default_models"
  [ -d "$dm_pool" ] && [ ! -e "$data_dir/app_config/default_models" ] && ln -s "$dm_pool" "$data_dir/app_config/default_models"

  # 启 server（后端 Bun.serve，监听 api_port）
  local server_pid
  nohup env APP_NAME="$APP_NAME" APP_ENV="${APP_ENV:-test}" NODE_ENV=test \
    API_PORT="$api_port" WEB_PORT="$web_port" DATA_DIR="$data_dir" \
    SERVER_PORT="$api_port" DATA_ROOT="$data_dir" \
    BASE_URL="http://127.0.0.1:$api_port" \
    sh -c "${API_START_CMD}" > "/tmp/${APP_NAME}-et-$cid-server.log" 2>&1 &
  server_pid=$!
  # 轮询 health
  local health_url="http://127.0.0.1:$api_port${HEALTH_ENDPOINT:-/health}"
  for _ in $(seq 1 60); do
    kill -0 "$server_pid" 2>/dev/null || { echo "[env.sh] ERROR: server 进程已退出" >&2; exit 4; }
    curl -fsS "$health_url" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -fsS "$health_url" >/dev/null || { echo "[env.sh] ERROR: server 60s 未就绪" >&2; exit 4; }
  echo "[env.sh] server ready (pid=$server_pid)"

  # 启 web dev（Vite，监听 web_port；--strictPort 保证端口占用直接失败而非换端口）
  local web_pid
  nohup env WEB_PORT="$web_port" API_PORT="$api_port" \
    sh -c "${WEB_START_CMD}" > "/tmp/${APP_NAME}-et-$cid-web.log" 2>&1 &
  web_pid=$!
  for _ in $(seq 1 60); do
    kill -0 "$web_pid" 2>/dev/null || { echo "[env.sh] ERROR: web 进程已退出" >&2; exit 4; }
    curl -fsS "http://127.0.0.1:$web_port/" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -fsS "http://127.0.0.1:$web_port/" >/dev/null || { echo "[env.sh] ERROR: web 60s 未就绪" >&2; exit 4; }
  echo "[env.sh] web ready (pid=$web_pid)"

  # electron 模式：起 electron 外壳，VITE_DEV_SERVER_URL 指向 web dev，CDP 端口暴露给 playwright attach
  local electron_pid=""
  if [ "$mode" = "electron" ]; then
    (cd "$ROOT_DIR/app/electron" && bun run build:ts) || { echo "[env.sh] ERROR: electron TS 编译失败" >&2; exit 5; }
    VITE_DEV_SERVER_URL="http://127.0.0.1:$web_port" \
      nohup env VITE_DEV_SERVER_URL="http://127.0.0.1:$web_port" \
      ROCKY_API_PORT="$api_port" ROCKY_DATA_DIR="$data_dir" \
      sh -c 'cd app/electron && bun run dev -- --remote-debugging-port='"$cdp_port" \
      > "/tmp/${APP_NAME}-et-$cid-electron.log" 2>&1 &
    electron_pid=$!
    # 等 CDP 端口就绪（electron 启动较慢，最长 90s）
    for _ in $(seq 1 90); do
      kill -0 "$electron_pid" 2>/dev/null || { echo "[env.sh] ERROR: electron 进程已退出" >&2; exit 4; }
      lsof -ti:"$cdp_port" >/dev/null 2>&1 && break
      sleep 0.5
    done
    lsof -ti:"$cdp_port" >/dev/null 2>&1 || { echo "[env.sh] ERROR: electron CDP 90s 未就绪（port=${cdp_port}）" >&2; exit 4; }
    echo "[env.sh] electron ready (pid=$electron_pid cdp=$cdp_port)"
  fi

  # 写 pidfile（server / web / electron 三行）+ portfile
  printf '%s\n%s\n%s\n' "$server_pid" "$web_pid" "${electron_pid:-}" > "$pidfile"
  printf 'api_port=%s\nweb_port=%s\ncdp_port=%s\n' "$api_port" "$web_port" "${cdp_port:-}" > "$(_portfile "$cid")"

  # 登记进全局注册表（跨 worktree/跨 case 端口占用真相源，_pick_free_port 据此避抢）
  _port_et_register "$cid" "$api_port" "$web_port" "${cdp_port:-}" "$server_pid"

  # 暴露给 executor（stdout 打印即可，executor 读 case.md 提示后自由决定怎么用）
  echo "[env.sh] OK: case=$cid mode=$mode"
  echo "[env.sh]   API_URL=http://127.0.0.1:$api_port"
  echo "[env.sh]   WEB_URL=http://127.0.0.1:$web_port"
  [ -n "$cdp_port" ] && echo "[env.sh]   CDP_URL=http://127.0.0.1:$cdp_port"
}

# ── stop 子命令 ──────────────────────────────────────────────────────────────
cmd_stop() {
  local cid="$1"
  validate_case_id "$cid" || exit 2
  local pidfile portfile data_dir
  pidfile=$(_pidfile "$cid")
  portfile=$(_portfile "$cid")
  data_dir=$(case_data_dir "$cid")

  # pidfile 精确 kill（绝不 pkill -f 宽匹配 — memory pkill-wide-match-kills-other-worktrees）
  if [ -f "$pidfile" ]; then
    # 倒序 kill（electron → web → server，避免父进程早死孤儿化子进程）
    local pids=()
    while IFS= read -r line; do pids+=("$line"); done < "$pidfile"
    local i
    for ((i=${#pids[@]}-1; i>=0; i--)); do
      local p="${pids[$i]}"
      [ -n "$p" ] && kill "$p" 2>/dev/null || true
    done
    sleep 0.3
    # 二次 SIGKILL 清顽固
    for p in "${pids[@]}"; do
      [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
    done
    rm -f "$pidfile"
  fi

  # 清端口残留（孤儿/子进程；_kill_port_orphans 已 cmdline 验证只杀本服务孤儿，绝不误杀）
  if [ -f "$portfile" ]; then
    while IFS= read -r line; do
      case "$line" in
        *_port=*) local port="${line#*=}"; [ -n "$port" ] && _kill_port_orphans "$port" ;;
      esac
    done < "$portfile"
    rm -f "$portfile"
  fi

  # 释放全局注册表（本 case 的端口占用记录）
  _port_et_free "$cid"

  # 删本 case DATA_DIR（一次性，不跨 case 复用）
  if [ -d "$data_dir" ]; then
    rm -rf "$data_dir"
    echo "[env.sh] removed DATA_DIR=$data_dir"
  fi
  echo "[env.sh] OK: case=$cid stopped"
}

# ── case-data-dir 子命令 ────────────────────────────────────────────────────
cmd_case_data_dir() {
  case_data_dir "$1"
}

# ── usage ────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
用法:
  $0 start <case_id> [--mode=headless|electron]
  $0 stop <case_id>
  $0 case-data-dir <case_id>

端口段（与 AT 隔离）: API ${ET_API_PORT_BASE}-${ET_API_PORT_MAX} / WEB ${ET_WEB_PORT_BASE}-${ET_WEB_PORT_MAX} / CDP ${ET_CDP_PORT_BASE}-${ET_CDP_PORT_MAX}
DATA_DIR: \$HOME/.rocky_agent_et_<case_id>（每 case 独立，stop 时清理）
EOF
}

# ── 入口 ─────────────────────────────────────────────────────────────────────
[ $# -ge 1 ] || { usage; exit 1; }
cmd="$1"; shift
case "$cmd" in
  start)        cmd_start "$@" ;;
  stop)         cmd_stop "$@" ;;
  case-data-dir) cmd_case_data_dir "$@" ;;
  -h|--help|help) usage ;;
  *) echo "[env.sh] ERROR: 未知命令 '$cmd'" >&2; usage; exit 1 ;;
esac
