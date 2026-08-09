#!/usr/bin/env bash
# tests/e2e/lib/et-chrome-cleanup.sh — ET playwright chrome 孤儿清理函数（v0.0.272）
#
# 背景：ET chrome 是 executor 跑 playwright-cli 才起的（playwright launchPersistentContext 的
#   user-data-dir=/tmp/et<digits>-prof），env.sh start 拿不到 pid → pidfile 三行（server/web/
#   electron）不含 chrome → stop 用 marker 扫描兜底。被 env.sh source，定义：
#   _cleanup_et_chrome / _pid_cmdline_matches。
#
# 安全边界（change_plan 裁决 8 + ET 冒烟回归 C1）：
#   - marker=et<digits>-prof 是 playwright user-data-dir 专属命名，用户主 Chrome 不可能用；
#   - 绝不宽匹配进程名（用户主 Chrome 也是 chrome 名）——只按 et<digits>-prof 精确扫；
#   - /tmp/et*-prof 删除：ls 遍历 + et 前缀 + -prof 后缀双验证才删，绝不宽删 /tmp/chrome-* 等。
#   - 进程扫描用 pgrep -f（macOS 原生，按 cmdline ERE 匹配）——seatbelt 沙箱 ps 不可用
#     （exit 126 operation not permitted，memory rocky-mac-seatbelt-ps-restricted），
#     pgrep 实测可用且自动排除自身（v0.0.272 ET 冒烟回归 blocking 修复）。
#
# 用法（env.sh cmd_stop 在 pidfile kill 之后调用，避免父进程先死孤儿化子进程）：
#   _cleanup_et_chrome

# 清理 ET playwright chrome 孤儿：①pgrep -f 扫 et<digits>-prof marker chrome kill（不依赖端口）
#   ②删 /tmp/et*-prof（严格模式）。pgrep -f 返回的 pid 已按 cmdline 匹配 marker（无需二次验证）；
#   两轮 kill（TERM → SIGKILL）清顽固。
# set -e 防护（v0.0.272 r2 修复）：末尾 for 循环若最后遍历的是非 marker 目录（如 et272leak-prof
#   不匹配 ^et[0-9]+-prof$），[[ ]] 返回 1 → && 短路 → 函数返回 1 → 调用方（env.sh cmd_stop 的
#   set -euo pipefail）中断、跳过端口清理。显式 return 0 保证无论最后遍历什么目录都正常退出。
_cleanup_et_chrome() {
  local p d base
  # ① pgrep -f 扫 et<digits>-prof marker chrome kill（TERM → SIGKILL 两轮清顽固）
  for p in $(pgrep -f 'et[0-9]+-prof' 2>/dev/null || true); do
    echo "[env.sh] 清理 ET chrome 孤儿 pid=$p"; kill "$p" 2>/dev/null || true
  done
  sleep 0.3
  for p in $(pgrep -f 'et[0-9]+-prof' 2>/dev/null || true); do
    kill -9 "$p" 2>/dev/null || true
  done
  # ② 删 /tmp/et*-prof（严格模式：ls 遍历 + et 前缀 + -prof 后缀双验证才删，绝不宽匹配）
  for d in /tmp/et*-prof; do
    [ -e "$d" ] || continue
    base=$(basename "$d")
    [[ "$base" =~ ^et[0-9]+-prof$ ]] && { echo "[env.sh] 清理 $d"; rm -rf "$d"; }
  done
  return 0
}

# 判断 pid 的 cmdline 是否匹配 marker（ET 端口清理 _kill_port_orphans 的 cmdline 验证用）。
# 优先 ps（有 ps 的环境精确拿 pid 的 cmdline）；ps 不可用/无输出 fallback pgrep -f 全量反查
# （seatbelt 沙箱 ps exit 126，pgrep 可用）。
# 注意：谓词函数，返回 0 = 匹配 / 1 = 不匹配 是**正常语义**——调用方必须在条件上下文
# （if / && || 列表）使用（set -e 对条件上下文的失败命令不触发，bash 语义）。勿在此补 return 0。
_pid_cmdline_matches() {
  local pid="$1" marker="$2"
  ps -o command= -p "$pid" 2>/dev/null | grep -qE "$marker" && return 0
  pgrep -f "$marker" 2>/dev/null | grep -qx "$pid"
}
