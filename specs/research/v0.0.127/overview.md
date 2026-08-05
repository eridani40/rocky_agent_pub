---
title: v0.0.127 ET 重构调研 — 总览
type: research-overview
feature: et_refactor
version: v0.0.127
updated: 2026-07-13
---

# v0.0.127 ET 重构 — 调研总览

## 定位（来自 req.md）

ET 从「真端到端」转成「**前端集成测试**」——给定后端响应测 UI 行为：
- **record**：真跑（server + LLM + 浏览器），录浏览器↔server 全栈交互 = API 请求→响应 + SSE 事件序列
- **replay**：浏览器重放操作，API/SSE 用录制（mock 后端，不真调 server）
- AT 测后端 API、ET 测前端 UI，分工互补不重叠

## 4 项调研产出

| # | 主题 | 产出文件 | 核心结论 |
|---|------|---------|---------|
| 1 | 基建 B SSE stub 可行性 | `infrastructure-b-sse-stub.md` | **退 A（server stub 扩展）** — Playwright `page.route`/HAR 原生不支持 SSE 流式响应；可改基建为 A（server 内 stub，扩展 AT 现有 `/test/stub` 协议到入站 API/SSE 级）|
| 2 | ET case 全量盘点 | `case-inventory.md` | 46 case：迁 39 / 并 5 / 弃 2；按 13 模块分类 + 每模块迁移映射 |
| 3 | 录制格式设计 | `recording-format.md` | AT recordings/ 模型（manifest.json + http.jsonl + sse.jsonl）；api+seq 双键 replay 匹配；与 AT 共用 codec 库 |
| 4 | server stub 扩展方案（A） | `server-stub-extension.md` | 扩展 `record-replay-registry.ts` 增加 `http`/`sse` 通道；新增 `createServerRouteInterceptor`（router.ts 入站拦截）；stub 协议加 `/test/stub/http-step` |

## 关键决策点（PRD/架构需先答）

1. **基建 B vs A**：调研结论倾向 **A**（详见 `infrastructure-b-sse-stub.md` §5）。理由：SSE 流式响应 Playwright 无原生支持，HAR 规范不含流；A 复用 AT 现有 record/replay 基建（已 3 通道），扩展成本低、与 AT 一致性高。
2. **SSE replay 时序**：录制时序 vs 回放时序是否保真？req 决策 5 选「api+seq」匹配（同 api 第几次调用），但 SSE **帧间时序**仍需策略（保真/即时回放）。
3. **case.yaml DSL 扩充**：req 决策 1 要求 ET step 词汇表（navigate/click/type/screenshot/assert），需定义语义（与 AT 的 requests/wait/poll 共存还是 ET 独有）。

## 文件清单（本调研产出）

```
specs/research/v0.0.127/
├── overview.md                       # 本文件（总览）
├── infrastructure-b-sse-stub.md      # 调研 1：基建 B 可行性
├── case-inventory.md                 # 调研 2：case 全量盘点
├── recording-format.md               # 调研 3：录制格式设计
└── server-stub-extension.md          # 调研 4：server stub 扩展（退 A 方案）
```

## 调研边界

- 只读 + 文档分析，未实际跑代码/spike（基建 B 的实际验证由 coder 后续阶段做）
- refs/ 无专门 Playwright ET 框架参考（claude-code=openclaw=node+vitest；crewAI=python；multica=openclaw fork）——基建可行性靠 Playwright API 能力分析
- 不含 PRD/架构最终结论（由 architect 在 PRD/架构阶段拍板，本调研只给依据）
