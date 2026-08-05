#!/usr/bin/env bash
# snapshot-dev.sh — 从「正在运行的 dev 前端」dump 各主页面的完整自包含 HTML + 截图。
# 参考对称脚本: scripts/run-dev.sh（先跑它把 dev 起来，再跑本脚本连上去抓）
#
# 用法：
#   ./scripts/run-dev.sh          # 终端 A：把 dev 跑起来（server + web + electron）
#   ./scripts/snapshot-dev.sh     # 终端 B：抓当前各页面 → dev-snapshots/
#   ./scripts/snapshot-dev.sh reqs/v0.0.87.ui_style/dump   # 指定输出目录
#
# 端口从 dev.env 读（WEB_PORT/API_PORT，与 run-dev.sh 同源），缺省兜底 8788/3710。
# 原理：Vite dev 把 CSS 以 <style> 注入 DOM，page.content() 抓的是渲染后 live DOM，
#      自包含、浏览器直接打开即可还原当前页面（外链字体需联网，截图作保底）。
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${1:-dev-snapshots}"

# 从 dev.env 读端口（缺省兜底）
WEB_PORT=8788; API_PORT=3710
if [ -f ./dev.env ]; then set -a; . ./dev.env; set +a; fi
WEB_URL="http://127.0.0.1:${WEB_PORT}"
API_URL="http://127.0.0.1:${API_PORT}"

# dev 前端在跑吗？
if ! curl -sf "$WEB_URL" >/dev/null 2>&1; then
  echo "[snapshot-dev] ERROR: $WEB_URL 无响应，请先在另一终端跑 ./scripts/run-dev.sh" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"; OUT_DIR="$(cd "$OUT_DIR" && pwd)"
echo "[snapshot-dev] web=$WEB_URL api=$API_URL out=$OUT_DIR"

python3 - "$WEB_URL" "$API_URL" "$OUT_DIR" <<'PY'
import sys, os, time
from playwright.sync_api import sync_playwright

URL, API, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
# 主区视图（nav aria-label → 文件名）。testid 已废弃（v0.0.197 起），定位走 aria-label。
# playground 是默认落地页，仍点一下确保在该页。
VIEWS = [("Playground", "playground"), ("Studio", "studio"), ("Academy", "academy"),
         ("SKILLS", "skill"), ("连接器", "connector"), ("应用设置", "settings-app")]

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    pg = ctx.new_page()
    # 浏览器无 Electron preload 注入的 window.api，注入最小桩兜底（dev 走 vite proxy，相对路径 fetch）。
    pg.add_init_script(f"if(!window.api){{window.api={{serverUrl:'{API}',quit:()=>{{}}}};}}")
    pg.goto(URL, wait_until="domcontentloaded")
    time.sleep(2)
    for label, name in VIEWS:
        try:
            pg.click(f'aside button[aria-label="{label}"]', timeout=5000)
        except Exception as e:
            print(f"  [skip] {name}: 点不到 nav（{e}）")
        time.sleep(1.8)  # 等该页数据加载/渲染稳定
        with open(os.path.join(OUT, f"{name}.html"), "w", encoding="utf-8") as f:
            f.write(pg.content())
        pg.screenshot(path=os.path.join(OUT, f"{name}.png"), full_page=False)
        print(f"  [ok] {name}: {name}.html + {name}.png")
    b.close()
print(f"\n[snapshot-dev] done → {OUT}")
PY
