---
name: dump-dev-html
description: 用 playwright-cli 从正在运行的 dev 前端抓任意页面/状态的自包含 HTML + 截图 + snapshot，供 UI 分析、demo 视觉基线、换肤对比。用于"抓当前页面 html"、"dump 会话态"、"截图分析 UI"。
---

# dump-dev-html

抓 dev 前端的页面现状。**首选方案 = playwright-cli 视觉方案**，一条命令拿 snapshot（导航用）+ 整页 HTML（还原用）+ 截图（保底），不写脚本、不维护选择器。

## 前提
- dev 在跑：`./scripts/run-dev.sh`（web 在 `dev.env` 的 WEB_PORT，默认 8788）。**注意 run-dev.sh 会连带起 electron**；只抓页面时 electron 窗口可关，headless chromium 连的是 vite web（8788），不受影响。
- `playwright-cli` 可用（`brew` 全局已装，或 `npx playwright cli`）。

## 核心用法（playwright-cli，推荐）
```bash
playwright-cli open http://127.0.0.1:8788     # 开浏览器（headless 独立 session）
playwright-cli snapshot                        # 拿 aria-label 结构 + 元素 ref（导航依据，不看截图）
playwright-cli click <ref>                     # 切页/进状态（按 snapshot 的 ref 点）
playwright-cli screenshot --filename=x.png     # 截图（保底）
playwright-cli snapshot --filename=x.yml       # 存结构
playwright-cli --raw eval "document.documentElement.outerHTML" > x.html   # 整页自包含 HTML
playwright-cli close
```

- **切页**：nav-rail 按钮按 snapshot 里的 ref 点（如 `button "Studio" [ref=e12]`），或用 CSS `aside button[aria-label="Studio"]`。**testid 已废弃（v0.0.197），定位走 aria-label / 可见文案**（AGENTS.md 契约）。
- **进对话态**：playground 默认是 idle 空态；先 `snapshot` 找会话项 ref，点进去才有 chat-topbar + 消息流。
- **整页 HTML**：`document.documentElement.outerHTML` 抓渲染后 live DOM（Vite 把 CSS 以 `<style>` 注入），自包含、浏览器直接打开即还原。

## 换肤 / 视觉判定
- dump 的 HTML 多数颜色走 `var(--color-*)` → 在 `</body>` 前注入 `:root{--color-*:新值}` override 即整页换肤；硬编码 hex 盖不掉。
- 视觉判定用 `tests/e2e/vision_check.py compare <impl> <design> '<checks_json>'`（checks 每项 `{"id":1,"dimension":"color","check":"..."}`），**不看截图、不调 MCP**（AGENTS.md 铁律）。

## 已废弃（勿用）
- ❌ `scripts/snapshot-dev.sh` 批量脚本（过度工程，已随本 skill 简化删除）
- ❌ 手写 Python playwright 脚本骨架（被 playwright-cli 取代）
- ❌ `nav-<view>` / `conv-item-<id>` testid 定位（已废弃）
