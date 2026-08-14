#!/usr/bin/env bash
# cleanup-chrome-debug.sh —— Chrome 调试态残留一次性清理（只读检测 + 指引，不 kill/不写文件）
# 参考: specs/tech/version_logs/v0.0.330/change_plan.md §15（老板残留清理方案）
#
# 背景：browser attach（chrome://inspect 远调模式）close 后，用户 Chrome 可能残留调试态：
#   - 9222 端口监听（lsof 证据）
#   - 「Chrome 正受到自动测试软件的控制」提示条
#   - chrome://inspect/#remote-debugging 里 Allow remote debugging 仍勾选
# 能力边界（change_plan §12 实证）：对用户已开 Chrome 的调试态**无编程关闭 API**（chrome-devtools-mcp
# 无 browser-management 工具；CDP 无关闭调试端口命令；Browser.close 杀整浏览器违反 attach 语义）。
# 本脚本只读检测 + 输出可照做的清理指引；**不自动 kill 用户 Chrome**（丢标签页/会话不可接受）。
#
# 用法: bash scripts/cleanup-chrome-debug.sh

set -u

echo "== Chrome 调试态残留检测 =="

# ① 9222 端口监听检测（仅报告，不 kill）
LISTENING=""
if command -v lsof >/dev/null 2>&1; then
  LISTENING=$(lsof -iTCP:9222 -sTCP:LISTEN 2>/dev/null || true)
fi

if [ -n "$LISTENING" ]; then
  echo ""
  echo "[检测到] 端口 9222 有进程监听（Chrome 调试态残留）："
  echo "$LISTENING" | awk 'NR>1 {print "  " $1 " pid=" $2 " " $9}'
  # 跳过 lsof 表头行（NR>1）+ 只匹配 Chrome/Google 进程（macOS 上 Chrome COMMAND 显示为 Google）
  CHROME_PID=$(echo "$LISTENING" | awk 'NR>1 && $1 ~ /[Gg]oogle|[Cc]hrome/ {print $2; exit}')
  if [ -n "$CHROME_PID" ]; then
    CHROME_CMD=$(ps -p "$CHROME_PID" -o command= 2>/dev/null || true)
    if echo "$CHROME_CMD" | grep -qi "chrome"; then
      echo "  → 监听进程是 Chrome（pid=${CHROME_PID}），属用户浏览器，本脚本不 kill。"
    else
      echo "  → 监听进程疑似 Chrome 相关（pid=${CHROME_PID}），属用户浏览器，本脚本不 kill。"
    fi
  else
    echo "  → 9222 监听进程非 Chrome（其他程序），请自行确认该进程是否可关。"
  fi
else
  echo ""
  echo "[正常] 端口 9222 无监听（无调试态残留）。"
fi

# ② DevToolsActivePort 文件检测（Chrome 开启调试态时写在该处）
echo ""
echo "== DevToolsActivePort 文件检测 =="
FOUND_PORT=""
for f in \
  "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort" \
  "$HOME/.config/google-chrome/DevToolsActivePort" \
  "$HOME/.config/chromium/DevToolsActivePort"; do
  if [ -f "$f" ]; then
    PORT=$(head -n 1 "$f" 2>/dev/null | tr -d '[:space:]')
    # ${VAR} 大括号形式：防 UTF-8 locale 下全角标点被吞进变量名（set -u 报 unbound variable）
    echo "[检测到] ${f} (port=${PORT})"
    FOUND_PORT="$PORT"
  fi
done
if [ -z "$FOUND_PORT" ]; then
  echo "[正常] 未找到 DevToolsActivePort（无调试态残留）。"
fi

# ③ 清理指引（可照做；不自动执行）
echo ""
echo "== 清理指引（如检测到残留，任选其一）=="
echo "  1. 打开 chrome://inspect/#remote-debugging → 取消勾选「Allow remote debugging」"
echo "     → Chrome 自动重启回非调试模式（9222 监听 + 提示条自动消失）"
echo "  2. 若取消勾选不可用（旧版 Chrome）：完全退出 Chrome 后重启（带用户确认，不丢数据）"
echo ""
echo "  验证：bash scripts/cleanup-chrome-debug.sh 再次运行 → 9222 无监听 + 无「自动测试软件」提示条"
echo ""
echo "注意：本脚本只读检测 + 指引，不会 kill 你的 Chrome 进程，也不会改动任何文件。"
