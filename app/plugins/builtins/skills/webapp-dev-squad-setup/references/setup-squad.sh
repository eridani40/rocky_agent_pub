#!/usr/bin/env bash
# setup-squad.sh — 一键搭建 webapp 研发 squad（除 hire 外全部自动化）
#
# 用法（两阶段）:
#
#   Phase 1 — 文件基础设施（hire 前，一条命令）:
#     bash setup-squad.sh init <squadRoot> <dataDir> <projectName>
#
#   Phase 2 — agent 植入（hire 后，一条命令）:
#     bash setup-squad.sh agents <squadRoot> <projectName> <leaderName>:<leaderId> <role:id>...
#     示例:
#     bash setup-squad.sh agents /data/squads/01ABC myapp Darvin:01AAA prd:01BBB coder:01CCC coder2:01DDD ...
#
# 注意: hire 必须由 leader 通过 team(action=hire) 工具调用，脚本不能代劳。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
  echo "用法:"
  echo "  Phase 1 (hire 前): bash setup-squad.sh init <squadRoot> <dataDir> <projectName>"
  echo "  Phase 2 (hire 后): bash setup-squad.sh agents <squadRoot> <projectName> <leaderName>:<leaderId> <role:id>..."
  echo ""
  echo "示例:"
  echo "  bash setup-squad.sh init /data/squads/01ABC rocky_agent_prod myapp"
  echo "  bash setup-squad.sh agents /data/squads/01ABC myapp Darvin:01AAA prd:01BBB architect:01CCC ..."
  exit 1
}

[ "$#" -ge 1 ] || usage
PHASE="$1"; shift

# ══════════════════════════════════════════════════════════════
# Phase 1: init — AGENTS.md + templates + commands + settings + skills
# ══════════════════════════════════════════════════════════════
do_init() {
  [ "$#" -eq 3 ] || { echo "❌ init 需要 3 个参数: <squadRoot> <dataDir> <projectName>"; usage; }

  SQUAD_ROOT="$1"
  DATA_DIR_NAME="$2"
  PROJECT_NAME="$3"

  if [ ! -f "$SCRIPT_DIR/AGENTS.md.template" ]; then
    echo "❌ 找不到模板目录: $SCRIPT_DIR/AGENTS.md.template"
    exit 1
  fi

  echo "🔧 Phase 1: 搭建 squad 基础设施 — $PROJECT_NAME"
  echo "   squadRoot: $SQUAD_ROOT"
  echo ""

  # ── 确保 squadRoot 存在 ──
  mkdir -p "$SQUAD_ROOT"

  # ── AGENTS.md ──
  echo "📝 [1/5] 创建 squad 根 AGENTS.md..."
  sed "s/{projectName}/$PROJECT_NAME/g" "$SCRIPT_DIR/AGENTS.md.template" > "$SQUAD_ROOT/AGENTS.md"
  echo "   ✅ AGENTS.md"

  # ── 目录结构 ──
  mkdir -p "$SQUAD_ROOT/.rocky/agents"
  mkdir -p "$SQUAD_ROOT/.rocky/templates"
  mkdir -p "$SQUAD_ROOT/.rocky/commands"
  mkdir -p "$SQUAD_ROOT/.rocky/skills"

  # ── templates ──
  echo "📝 [2/5] 复制 templates..."
  for f in change-plan-template.md context-template.md task-board-template.md task-template.json verify-checkpoint-template.json; do
    cp "$SCRIPT_DIR/templates/$f" "$SQUAD_ROOT/.rocky/templates/$f"
  done
  echo "   ✅ 5 个模板"

  # ── commands ──
  echo "📝 [3/5] 复制 commands..."
  cp "$SCRIPT_DIR/commands/optimize-agent-prompt.md" "$SQUAD_ROOT/.rocky/commands/"
  echo "   ✅ optimize-agent-prompt.md"

  # ── settings ──
  echo "📝 [4/5] 复制 settings..."
  cp "$SCRIPT_DIR/settings.json.template" "$SQUAD_ROOT/.rocky/settings.json"
  echo "   ✅ settings.json"

  # ── skills ──
  echo "📝 [5/5] 复制 skills..."
  if [ -d "$SCRIPT_DIR/skills" ]; then
    count=0
    for d in "$SCRIPT_DIR/skills"/*/; do
      [ -d "$d" ] || continue
      name=$(basename "$d")
      cp -r "$d" "$SQUAD_ROOT/.rocky/skills/$name"
      count=$((count + 1))
    done
    echo "   ✅ $count 个 skills"
  else
    echo "   ⚠️ references/skills 不存在，跳过"
  fi

  # ── 验证 ──
  echo ""
  echo "🔍 验证..."
  local tmpl_cnt cmd_cnt skill_cnt residual
  tmpl_cnt=$(find "$SQUAD_ROOT/.rocky/templates" -type f 2>/dev/null | wc -l | tr -d ' ')
  cmd_cnt=$(find "$SQUAD_ROOT/.rocky/commands" -type f 2>/dev/null | wc -l | tr -d ' ')
  skill_cnt=$(find "$SQUAD_ROOT/.rocky/skills" -maxdepth 1 -type d 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
  residual=$(grep -o "{projectName}" "$SQUAD_ROOT/AGENTS.md" 2>/dev/null | wc -l | tr -d ' ')

  echo "   AGENTS.md:     $([ -f "$SQUAD_ROOT/AGENTS.md" ] && echo '✅' || echo '❌')"
  echo "   templates:     $([ "$tmpl_cnt" -eq 5 ] && echo "✅ ($tmpl_cnt/5)" || echo "⚠️ ($tmpl_cnt/5)")"
  echo "   commands:      $([ "$cmd_cnt" -eq 1 ] && echo "✅ ($cmd_cnt/1)" || echo "⚠️ ($cmd_cnt/1)")"
  echo "   settings:      $([ -f "$SQUAD_ROOT/.rocky/settings.json" ] && echo '✅' || echo '❌')"
  echo "   skills:        $([ "$skill_cnt" -ge 1 ] && echo "✅ ($skill_cnt)" || echo '⚠️ (0)')"
  echo "   占位符残留:     $([ "$residual" -eq 0 ] && echo '✅ 无' || echo "⚠️ $residual 处")"

  echo ""
  echo "✅ Phase 1 完成！"
  echo ""
  echo "📌 下一步: hire + Phase 2"
  echo "   1. team(action=hire) hire 13 个 mate（leader 工具调用，不能脚本化）"
  echo "   2. bash setup-squad.sh agents <squadRoot> <projectName> <leaderName>:<leaderId> <role:id>..."
}

# ══════════════════════════════════════════════════════════════
# Phase 2: agents — 植入 leader + mate 个人 AGENTS.md
# ══════════════════════════════════════════════════════════════
do_agents() {
  [ "$#" -ge 3 ] || { echo "❌ agents 需要: <squadRoot> <projectName> <leaderName>:<leaderId> <role:id>..."; usage; }

  SQUAD_ROOT="$1"
  PROJECT_NAME="$2"
  shift 2

  AGENTS_DIR="$SQUAD_ROOT/.rocky/agents"
  mkdir -p "$AGENTS_DIR"

  echo "🔧 Phase 2: 植入 agent 个人 AGENTS.md"
  echo ""

  # role 模板映射: coder2/coder3 → coder.template.md; leader name → leader.template.md
  resolve_template() {
    local role="$1"
    case "$role" in
      coder|coder2|coder3) echo "coder" ;;
      *) [[ -f "$SCRIPT_DIR/agents/${role}.template.md" ]] && echo "$role" || echo "leader" ;;
    esac
  }

  implanted=0
  errors=0

  for pair in "$@"; do
    # 解析 name:id
    name="${pair%%:*}"
    memberId="${pair#*:}"

    if [ -z "$memberId" ] || [ "$memberId" = "$pair" ]; then
      echo "   ❌ 格式错误: $pair（应为 name:memberId）"
      errors=$((errors + 1))
      continue
    fi

    template_name=$(resolve_template "$name")
    template_file="$SCRIPT_DIR/agents/${template_name}.template.md"

    if [ ! -f "$template_file" ]; then
      echo "   ❌ 模板不存在: $template_file"
      errors=$((errors + 1))
      continue
    fi

    target="$AGENTS_DIR/${name}-${memberId}.md"
    sed "s/{projectName}/$PROJECT_NAME/g" "$template_file" > "$target"
    echo "   ✅ ${name}-${memberId}.md"
    implanted=$((implanted + 1))
  done

  echo ""
  echo "🔍 验证..."
  local total
  total=$(find "$AGENTS_DIR" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  local residual
  residual=$(grep -rl "{projectName}" "$AGENTS_DIR" 2>/dev/null | wc -l | tr -d ' ')

  echo "   agent 文件:     $total 个（期望 14: 1 leader + 13 mate）"
  echo "   占位符残留:     $([ "$residual" -eq 0 ] && echo '✅ 无' || echo "⚠️ $residual 个文件")"

  if [ "$errors" -gt 0 ]; then
    echo ""
    echo "⚠️ 有 $errors 个错误，请检查上方日志"
  fi
  echo ""
  echo "✅ Phase 2 完成！整个 squad 环境已就位。"
  echo ""
  echo "📌 最终验证:"
  echo "   team(action=list) → 确认 14 人"
}

# ── 路由 ──
case "$PHASE" in
  init)   do_init "$@" ;;
  agents) do_agents "$@" ;;
  *)      echo "❌ 未知命令: $PHASE（应为 init 或 agents）"; usage ;;
esac
