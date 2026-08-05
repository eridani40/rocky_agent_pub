#!/bin/bash
# clean-plugin-policy-drift.sh — v0.0.67 一次性开发 migration 脚本
# 参考: reqs/[working] v0.0.67.plugin_config_refactor/design.md §3 D2/D6
#       reqs/[working] v0.0.67.plugin_config_refactor/req.md（数据清理章节）
#
# 用途：
#   v0.0.67 配置代码化（scopes/*.json 替代落盘 policy）后，清理 dev/test dataDir 的
#   历史落盘 drift。运行时已不读 plugin_policy/（D2），但落盘残留会造成 inventory
#   误导（前端展示、PluginPolicyStore lazy migrate 等）。本脚本一次性清掉 drift。
#
# 范围（详见脚本内 TEST_DATA_DIR / DEV_DATA_DIR 分支）：
#   test dataDir (~/.rocky_agent_test，AT env，无用户 secret)：
#     - 删 plugin_policy/impl/plugin_policy/*.json（全部）
#     - 删 plugin_scope/subagent/（D6 drift，若有）
#     - 保留 plugin_scope/{default,forked,at_scope_*}/（scope 元信息）
#   dev dataDir (~/.rocky_agent_dev，含 zhipu secret)：
#     - 精细清 10 条 drift：
#       default::append_passthrough（manifest 已删）
#       default::system_prompt / forked::system_prompt（implId 不存在）
#       forked::base_builder/store_sink/transcript_reader/orphan_tool_call/
#         empty_message/role_merge/snip_handler（v0.0.49 disable 残留，
#         v0.0.67 代码声明 scopes/forked.json 接管）
#     - 删 plugin_scope/subagent/（D6 drift）
#     - 保留 default::zhipu（apiKey secret，D1：env/dev config 注入未验证前不清）
#     - 保留其他 enabled/order policy（lazy migrate 兼容；v0.0.67 后 PluginManager 不读）
#
# soft-delete 约定（项目 MEMORY）：不 rm，mv 到已 gitignore 的 soft_deleted/。
# 备份后整目录保留审计；幂等：再跑跳过已删项。
#
# 注意（用户原则）：
#   - 这是一次性开发 migration，由用户手动跑（bash scripts/clean-plugin-policy-drift.sh）
#   - 不在运行时启动 / env_start.sh 跑（运行时不碰 ext policy）
#   - 不读不写其他 worktree 的 dataDir
#
# 用法：
#   bash scripts/clean-plugin-policy-drift.sh            # 默认清理 dev + test dataDir
#   bash scripts/clean-plugin-policy-drift.sh --dry-run  # 只打印不删
#   bash scripts/clean-plugin-policy-drift.sh --only=dev # 仅清 dev（或 --only=test）
set -u

# ============ 参数解析 ============
DRY_RUN=0
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --only=dev|--only=test) ONLY="${arg#--only=}" ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *) echo "[clean] 未知参数: $arg（用 --dry-run / --only=dev / --only=test）"; exit 2 ;;
  esac
done

DEV_DATA_DIR="${DEV_DATA_DIR:-$HOME/.rocky_agent_dev}"
TEST_DATA_DIR="${TEST_DATA_DIR:-$HOME/.rocky_agent_test}"
TS=$(date +%Y%m%d-%H%M%S)

# dev drift policy key 白名单（task spec 明确列出，10 条）
DEV_DRIFT_KEYS=(
  "default::append_passthrough"
  "default::system_prompt"
  "forked::system_prompt"
  "forked::base_builder"
  "forked::store_sink"
  "forked::transcript_reader"
  "forked::orphan_tool_call"
  "forked::empty_message"
  "forked::role_merge"
  "forked::snip_handler"
)

echo "[clean] v0.0.67 plugin policy drift 清理（D2 落盘弃用 + D6 subagent drift）"
echo "[clean] dry-run=$DRY_RUN  only=${ONLY:-both}  ts=$TS"
echo ""

# ============ 通用工具 ============
# soft_delete PATH：把文件/目录 mv 到 soft_deleted/v0.0.67-plugin-policy-drift/
soft_delete() {
  local src="$1" backup_root="$2" label="$3"
  if [ ! -e "$src" ]; then
    echo "[clean]   skip (不存在): $label"
    return 0
  fi
  local dest="$backup_root/$label-$(basename "$src")-$TS"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[clean]   DRY-RUN delete: $label ($src → $dest)"
    return 0
  fi
  mkdir -p "$backup_root"
  mv "$src" "$dest"
  echo "[clean]   DELETED: $label → $dest"
}

# ============ test dataDir 清理（安全：全清） ============
clean_test() {
  local data_dir="$TEST_DATA_DIR"
  local impl_dir="$data_dir/plugin_policy/impl/plugin_policy"
  local subagent_dir="$data_dir/plugin_scope/subagent"
  local backup_root="$data_dir/soft_deleted/v0.0.67-plugin-policy-drift"

  echo "=== test dataDir: $data_dir ==="

  if [ ! -d "$data_dir" ]; then
    echo "[clean]   目录不存在，跳过"
    echo ""
    return 0
  fi

  # 1. 清 plugin_policy/impl/plugin_policy/*.json（全部）
  if [ -d "$impl_dir" ]; then
    local count
    count=$(ls "$impl_dir"/*.json 2>/dev/null | wc -l | tr -d ' ')
    echo "[clean]   impl policy 文件数: ${count}"
    if [ "$count" -gt 0 ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        echo "[clean]   DRY-RUN: 将清空 ${impl_dir}/*.json (${count} 个文件)"
      else
        mkdir -p "$backup_root"
        backup_dir="$backup_root/impl-policy-$TS"
        mkdir -p "$backup_dir"
        cp -r "$impl_dir" "$backup_dir/impl-plugin-policy-bak"
        # 全删（已 cp 备份）
        rm -f "$impl_dir"/*.json
        echo "[clean]   DELETED: ${count} 个 impl policy (备份: ${backup_dir})"
      fi
    else
      echo "[clean]   impl policy 已空（幂等跳过）"
    fi
  else
    echo "[clean]   impl policy 目录不存在（幂等跳过）"
  fi

  # 2. 清 plugin_scope/subagent/（D6 drift；test 通常不存在，幂等）
  soft_delete "$subagent_dir" "$backup_root" "test-plugin_scope-subagent"

  # 3. 保留 plugin_scope/{default,forked,at_scope_*}/（scope 元信息）
  echo "[clean]   保留 scope 元信息（plugin_scope/{default,forked,at_scope_*}/）"
  echo ""
}

# ============ dev dataDir 清理（精细：只删 drift 白名单） ============
clean_dev() {
  local data_dir="$DEV_DATA_DIR"
  local impl_dir="$data_dir/plugin_policy/impl/plugin_policy"
  local subagent_dir="$data_dir/plugin_scope/subagent"
  local backup_root="$data_dir/soft_deleted/v0.0.67-plugin-policy-drift"

  echo "=== dev dataDir: $data_dir ==="

  if [ ! -d "$data_dir" ]; then
    echo "[clean]   目录不存在，跳过"
    echo ""
    return 0
  fi

  # 1. 精细清 drift policy（按 key 白名单，保留 default::zhipu 等其他项）
  if [ -d "$impl_dir" ]; then
    echo "[clean]   精细清 drift policy（${#DEV_DRIFT_KEYS[@]} 条）"
    local deleted=0
    local skipped=0
    mkdir -p "$backup_root"
    for f in "$impl_dir"/*.json; do
      [ -f "$f" ] || continue
      # 读 key 字段
      key=$(python3 -c "
import json, sys
try:
    with open('$f') as fh:
        print(json.load(fh).get('key', ''))
except Exception:
    print('')
" 2>/dev/null)
      # 判断是否在白名单
      is_drift=0
      for drift_key in "${DEV_DRIFT_KEYS[@]}"; do
        if [ "$key" = "$drift_key" ]; then
          is_drift=1
          break
        fi
      done
      if [ "$is_drift" -eq 1 ]; then
        # 替换 :: → _ 用作 label（避免文件名冲突）
        label=$(echo "$key" | sed 's/::/_/g')
        if [ "$DRY_RUN" -eq 1 ]; then
          echo "[clean]   DRY-RUN delete: ${key} ($(basename "$f"))"
          deleted=$((deleted + 1))
        else
          mv "$f" "$backup_root/dev-${label}-$TS.json"
          echo "[clean]   DELETED: ${key} ($(basename "$f"))"
          deleted=$((deleted + 1))
        fi
      else
        skipped=$((skipped + 1))
      fi
    done
    echo "[clean]   dev drift 删除: ${deleted} (保留 ${skipped} 项，含 default::zhipu secret)"
  else
    echo "[clean]   impl policy 目录不存在（幂等跳过）"
  fi

  # 2. 清 plugin_scope/subagent/（D6 drift）
  soft_delete "$subagent_dir" "$backup_root" "dev-plugin_scope-subagent"

  # 3. 保留 default::zhipu（apiKey secret，D1：env 注入验证前不清）
  echo "[clean]   保留 default::zhipu policy（apiKey secret；D1 修复 env 注入验证后再清）"
  echo "[clean]   保留其他 enabled/order policy（lazy migrate 兼容；v0.0.67 PluginManager 已不读）"
  echo ""
}

# ============ 主流程 ============
if [ -z "$ONLY" ] || [ "$ONLY" = "dev" ]; then
  clean_dev
fi
if [ -z "$ONLY" ] || [ "$ONLY" = "test" ]; then
  clean_test
fi

echo "[clean] 完成。"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[clean] (dry-run 模式，未实际删除。去掉 --dry-run 真实执行)"
fi
