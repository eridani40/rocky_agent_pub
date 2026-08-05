#!/usr/bin/env bash
# check-server-build-assets.sh — build 期静态资源镜像自检（T4）
# 参考: specs/tech/version_logs/v0.0.153/change_plan.md T1+T4
#       specs/tech/agent/context/[P0]prompt_content_files.md §2
#       CLAUDE.md「持续可打包护栏」新类型：编译期资源复制缺失
#
# 背景：tsc -b 只编译 .ts，不会把 prompts/content 下的 .md 正文 /
# migration/handlers 下的 .yaml 迁移脚本复制进 dist——这两类资源都靠
# package.json build 脚本手动 cp。cp 步骤本身若漏了新增文件（新增 .md/.yaml
# 忘记补进 cp glob，或压根忘记加 cp），packaged 环境读不到文件、静默降级，
# dev 环境却因为直接读 src 而全绿——本脚本在 build 收尾时镜像比对 src→dist，
# 揪出这类「新增文件忘记进 dist」的缺口。
#
# 做法：不硬编码文件名清单——find 递归枚举 src 侧文件，逐个核对 dist 侧
# 同相对路径文件是否存在。新增 .md/.yaml 资源自动纳入校验，无需同步改本脚本。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT/app/server"

# 全局缺失标记（>0 = 存在缺失项）；check_mirror 内部置位，不因单次缺失中断，
# 继续检查完剩余文件后统一在主流程汇总失败。
missing=0

# check_mirror <src_dir> <dist_dir> <pattern>
# 递归枚举 src_dir 下匹配 pattern 的文件，核对 dist_dir 下同相对路径文件存在。
# 用 find -print0 + read -d '' 防文件名含空格出错。
check_mirror() {
  local src_dir="$1"
  local dist_dir="$2"
  local pattern="$3"

  if [ ! -d "$src_dir" ]; then
    echo "MISSING: source dir not found: $src_dir" >&2
    missing=1
    return
  fi

  while IFS= read -r -d '' src_file; do
    local rel="${src_file#"$src_dir"/}"
    local dist_file="$dist_dir/$rel"
    if [ ! -f "$dist_file" ]; then
      # 注意：变量后紧跟全角中文标点须用 ${var} 显式括号——macOS 默认 /bin/bash（3.2 古董版本）
      # 在 set -u 下会把多字节字符的前几个字节误并入变量名，报「dist_file乱码: unbound variable」。
      echo "MISSING: ${dist_file}（源: ${src_file}）" >&2
      missing=1
    fi
  done < <(find "$src_dir" -type f -name "$pattern" -print0)
}

# 两组镜像比对：prompt content 正文（.md）+ migration handler 脚本（.yaml）
check_mirror "src/prompts/content" "dist/prompts/content" "*.md"
check_mirror "src/migration/handlers" "dist/migration/handlers" "*.yaml"

if [ "$missing" -ne 0 ]; then
  echo "[check-server-build-assets] FAILED: dist 静态资源缺失（见上方 MISSING 行），build 未完整复制 src 资源到 dist" >&2
  exit 1
fi

echo "[check-server-build-assets] OK: src→dist 静态资源镜像齐全"
exit 0
