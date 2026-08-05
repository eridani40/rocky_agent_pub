#!/usr/bin/env bash
#
# claude-to-qoder.sh
#
# 把 .claude/ 配置机械转换成 .qoder/ 配置（+ 项目根 AGENTS.md）。
# 每次运行先清理上次生成的产物，再全新生成。
#
# 只读 .claude/，只写 .qoder/ 的派生子目录 + 根 AGENTS.md。
# 绝不修改 .claude/ 下任何文件。
# 绝不动 .qoder/ 里非派生的东西（repowiki/、settings.local.json、worktrees/）。
#
# 转换规则：
#   1. .claude/CLAUDE.md          -> AGENTS.md（项目根）
#   2. .claude/agents/    (树)    -> .qoder/agents/
#   3. .claude/skills/    (树)    -> .qoder/skills/
#   4. .claude/templates/ (树)    -> .qoder/templates/
#   5. .claude/commands/  (树)    -> .qoder/commands/
#   文本内容改写：
#     - 路径引用 .claude  -> .qoder
#     - 文件名引用 CLAUDE.md -> AGENTS.md
#     - 删除所有含 superpowers 的整行（frontmatter skills 条目 + 正文提示）
#     - 仅 .qoder/agents/ 下：删除 frontmatter 指定模型行（^model:）
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/.claude"
DST="$ROOT/.qoder"

# 派生子目录：clean 时删除、重新生成的对象
DERIVED_DIRS=(agents skills templates commands)
# 需要做文本改写的扩展名
TEXT_EXT="md sh json py txt yaml yml"

log() { printf '  %s\n' "$*"; }

if [[ ! -d "$SRC" ]]; then
  echo "错误：找不到源目录 $SRC" >&2
  exit 1
fi

echo "[1/4] 清理 .qoder/ 派生目录（保留 repowiki/ settings.local.json worktrees/）"
mkdir -p "$DST"
for d in "${DERIVED_DIRS[@]}"; do
  if [[ -e "$DST/$d" ]]; then
    rm -rf "${DST:?}/$d"
    log "removed .qoder/$d"
  fi
done
# 上次生成的 AGENTS.md 由下一步直接覆盖，无需单独删

echo "[2/4] 复制目录树 .claude/ -> .qoder/"
for d in "${DERIVED_DIRS[@]}"; do
  if [[ -d "$SRC/$d" ]]; then
    cp -R "$SRC/$d" "$DST/$d"
    log "copied $d/"
  fi
done

echo "[3/4] 复制 CLAUDE.md -> AGENTS.md"
if [[ -f "$SRC/CLAUDE.md" ]]; then
  cp "$SRC/CLAUDE.md" "$ROOT/AGENTS.md"
  log "AGENTS.md"
else
  log "跳过：.claude/CLAUDE.md 不存在"
fi

echo "[4/4] 文本改写（路径 / 文件名 / 剔除 superpowers）"

# 组装用于匹配文本文件的 find 条件
FIND_EXPR=()
first=1
for ext in $TEXT_EXT; do
  if [[ $first -eq 1 ]]; then
    FIND_EXPR+=(-name "*.$ext")
    first=0
  else
    FIND_EXPR+=(-o -name "*.$ext")
  fi
done

rewrite_file() {
  local f="$1"
  # macOS/BSD sed 需要 -i ''；三条规则一次跑完
  sed -i '' \
    -e 's#\.claude#.qoder#g' \
    -e 's#CLAUDE\.md#AGENTS.md#g' \
    -e '/[Ss]uperpowers/d' \
    "$f"
}

count=0
# 派生子目录内的文本文件
while IFS= read -r -d '' f; do
  rewrite_file "$f"
  count=$((count + 1))
done < <(find "${DERIVED_DIRS[@]/#/$DST/}" -type f \( "${FIND_EXPR[@]}" \) -print0 2>/dev/null)

# 根 AGENTS.md
if [[ -f "$ROOT/AGENTS.md" ]]; then
  rewrite_file "$ROOT/AGENTS.md"
  count=$((count + 1))
fi

log "改写文件数：$count"

# 仅 .qoder/agents/ 下：去掉 frontmatter 指定模型行（^model:）
if [[ -d "$DST/agents" ]]; then
  model_count=0
  while IFS= read -r -d '' f; do
    if grep -q '^model:' "$f"; then
      sed -i '' -e '/^model:/d' "$f"
      model_count=$((model_count + 1))
    fi
  done < <(find "$DST/agents" -type f -name "*.md" -print0 2>/dev/null)
  log "去除指定模型行的 agent 文件数：$model_count"
fi

echo "完成。生成目标：$DST/{$(IFS=,; echo "${DERIVED_DIRS[*]}")} + AGENTS.md"
