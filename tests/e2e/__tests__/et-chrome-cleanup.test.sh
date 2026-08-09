#!/usr/bin/env bash
# tests/e2e/__tests__/et-chrome-cleanup.test.sh — _cleanup_et_chrome / _pid_cmdline_matches 单测（v0.0.272）
#
# 覆盖（task.json T2 验收 + ET 冒烟 blocking C1 修复）：
#   1. 严格删除：/tmp/et<digits>-prof 目录被删；/tmp/chrome-* 等非 et 前缀目录保留
#   2. 后缀验证：et<digits> 无 -prof 后缀不被删；et<digits>-prof.bak 不被删
#   3. pgrep kill：造假 marker chrome 进程（exec -a 模拟 playwright user-data-dir）→ 函数杀进程
#   4. 不误杀：非 marker 进程（cmdline 含 et 字样但非 et[0-9]+-prof）不被杀
#   5. _pid_cmdline_matches：ps 不可用（沙箱）fallback pgrep 反查命中/未命中
#   6. _ORPHAN_MARKERS 含 chrome/playwright/remote-debugging
#
# 说明：本脚本进程 cmdline 不含 et<digits>-prof 字面（marker 只在脚本内容里），
#   避免 _cleanup_et_chrome 的 pgrep 误匹配测试脚本自身（生产 env.sh cmdline 同理安全）。

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0

note() { echo "  - $*"; }
ok()   { PASS=$((PASS+1)); echo "  ✓ PASS: $*"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ FAIL: $*"; }

# source lib（含函数定义；lib 无入口，安全）
. "$SCRIPT_DIR/lib/et-chrome-cleanup.sh"

# ── 测试 1：严格模式删除（et<digits>-prof 删；chrome-* 等保留）──────────────────
echo "[test 1] 严格模式删除"
REAL_ET="/tmp/et900001-prof"; REAL_CHROME="/tmp/chrome-et900001-abc"
mkdir -p "$REAL_ET" "$REAL_CHROME"
_cleanup_et_chrome >/dev/null 2>&1
if [ -d "$REAL_ET" ]; then bad "et<digits>-prof 目录未被删: $REAL_ET"; else ok "et<digits>-prof 目录已删"; fi
if [ -d "$REAL_CHROME" ]; then ok "chrome-* 非 et 前缀目录保留"; else bad "chrome-* 目录被误删"; fi
rm -rf "$REAL_ET" "$REAL_CHROME"

# ── 测试 2：后缀/前缀严格验证（真实目录 + 真实函数删除行为）────────────────────
echo "[test 2] et 前缀 + -prof 后缀双验证（真实目录 + 真实函数删除行为）"
REAL_NO_SUFFIX="/tmp/et900002"; REAL_NON_PREFIX="/tmp/chrome-et900002-abc"; REAL_SUFFIX_OVER="/tmp/et900002-prof.bak"
mkdir -p "$REAL_NO_SUFFIX" "$REAL_NON_PREFIX" "$REAL_SUFFIX_OVER" "/tmp/et900003-prof"
_cleanup_et_chrome >/dev/null 2>&1
[ -d "$REAL_NO_SUFFIX" ] && ok "et<digits> 缺 -prof 保留" || bad "et<digits> 被误删"
[ -d "$REAL_NON_PREFIX" ] && ok "chrome-* 非 et 前缀保留" || bad "chrome-* 被误删"
[ -d "$REAL_SUFFIX_OVER" ] && ok "et<digits>-prof.bak 后缀超保留" || bad "et<digits>-prof.bak 被误删"
[ ! -d "/tmp/et900003-prof" ] && ok "et<digits>-prof 真实删除" || bad "et<digits>-prof 未被删"
rm -rf "$REAL_NO_SUFFIX" "$REAL_NON_PREFIX" "$REAL_SUFFIX_OVER" "/tmp/et900003-prof"

# ── 测试 3：pgrep kill 造假 marker chrome 进程（C1 修复主路径）──────────────────
echo "[test 3] pgrep kill marker chrome 进程"
# 造假 playwright chrome（exec -a 设 argv[0] = chrome --user-data-dir=/tmp/et272-prof）
bash -c 'exec -a "chrome --user-data-dir=/tmp/et272-prof --no-sandbox" sleep 60' &
FAKE_MARKER=$!
sleep 0.5
if pgrep -f 'et[0-9]+-prof' | grep -qx "$FAKE_MARKER"; then
  ok "pgrep 能扫到 marker 进程 pid=$FAKE_MARKER"
else
  bad "pgrep 扫不到 marker 进程（ps 沙箱 fallback 失效）"
fi
# 跑函数 → 应 kill marker 进程 + 删 /tmp/et272-prof（先建目录验证删除）
mkdir -p /tmp/et272-prof
_cleanup_et_chrome >/dev/null 2>&1
if ! kill -0 "$FAKE_MARKER" 2>/dev/null; then ok "marker chrome 进程已被 kill"; else bad "marker chrome 进程未 kill"; fi
if [ ! -d /tmp/et272-prof ]; then ok "/tmp/et272-prof 目录已删"; else bad "/tmp/et272-prof 目录未删"; fi
kill -9 "$FAKE_MARKER" 2>/dev/null || true

# ── 测试 4：不误杀非 marker 进程（cmdline 含 et 字样但非 et[0-9]+-prof）─────────
echo "[test 4] 不误杀非 marker 进程"
bash -c 'exec -a "node-et272leak --user-data-dir=/tmp/et272leak-prof" sleep 60' &
FAKE_LEAK=$!
sleep 0.5
_cleanup_et_chrome >/dev/null 2>&1
if kill -0 "$FAKE_LEAK" 2>/dev/null; then ok "非 marker 进程（et272leak-prof）未被杀"; else bad "非 marker 进程被误杀"; fi
kill -9 "$FAKE_LEAK" 2>/dev/null || true

# ── 测试 5：_pid_cmdline_matches（ps fallback pgrep 反查）───────────────────────
echo "[test 5] _pid_cmdline_matches（ps 不可用 fallback pgrep 反查）"
bash -c 'exec -a "chrome --user-data-dir=/tmp/et272-prof --no-sandbox" sleep 60' &
FAKE_M=$!
sleep 0.5
if _pid_cmdline_matches "$FAKE_M" 'et[0-9]+-prof'; then ok "marker 进程 pid 命中"; else bad "marker 进程 pid 未命中"; fi
if _pid_cmdline_matches "$FAKE_M" 'et[0-9]+-leak'; then bad "错误 marker 误命中"; else ok "非目标 marker 不命中"; fi
kill -9 "$FAKE_M" 2>/dev/null || true

# ── 测试 6：_ORPHAN_MARKERS 扩充（chrome/playwright/remote-debugging 命中）─────
echo "[test 6] _ORPHAN_MARKERS 含 chrome 三 marker"
# 不 source env.sh（其入口有 exit，source 会终止本脚本）；直接 grep 源文件验证值。
MARKERS=$(grep -oE "^_ORPHAN_MARKERS=.*" "$SCRIPT_DIR/env.sh" | head -1)
for m in chrome playwright remote-debugging; do
  if echo "$MARKERS" | grep -q "$m"; then ok "_ORPHAN_MARKERS 含 $m"; else bad "_ORPHAN_MARKERS 缺 $m"; fi
done

# ── 测试 7：set -e 防护（非 marker et*-prof 目录排序最后时函数必须返回 0）────────
echo "[test 7] set -e 防护：非 marker et*-prof 目录存在时函数返回 0"
# 构造「glob 排序最后的是非 marker」：et999999-prof.bak（非 marker，排序在 et999998-prof 之后）
# → 旧代码 for 循环最后一条命令 [[ ]] 不匹配返回 1 → 函数返回 1 → set -e 中断（v0.0.272 r2 bug）
mkdir -p /tmp/et999998-prof /tmp/et999999-prof.bak
_cleanup_et_chrome >/dev/null 2>&1
RC=$?
[ "$RC" -eq 0 ] && ok "_cleanup_et_chrome 返回 0（set -e 不中断）" || bad "_cleanup_et_chrome 返回 $RC（set -e 中断风险）"
[ -d /tmp/et999998-prof ] && bad "marker 目录未删" || ok "marker 目录已删"
[ -d /tmp/et999999-prof.bak ] && ok "非 marker .bak 保留" || bad "非 marker .bak 被误删"
rm -rf /tmp/et999998-prof /tmp/et999999-prof.bak

# ── 汇总 ─────────────────────────────────────────────────────────────────────
echo "----------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
