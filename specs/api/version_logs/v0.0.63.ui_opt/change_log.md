# v0.0.63.ui_opt API 变更日志 — squad/member chat model 显式传 API 复用（per-call override + member.model 持久化）

> version: 1.0 · 2026-07-04
> 一句话定位：本版本**无新 HTTP 端点**——仅修订 `11-squad.md §127` 的「常规 Studio UI 不需要显式传 model」表述（现状描述 → 行为允许描述），反映前端 squad 群聊 / member 单聊头部 ModelPicker 已挂载、可显式传 model 的实际行为。
> 权威：`specs/api/overall/11-squad.md §127`（已就地修订）；端点契约主体在 `11a-squad-endpoints.md`（未动）。
> 关联：prd `specs/prd/version_logs/v0.0.63.ui_opt.md`（输入文档，§3.4 F4 / §5.2 T1）+ tech `specs/tech/version_logs/v0.0.63.ui_opt/change_log.md` §5（F4a/F4b 架构 + 文件位置）+ ui `specs/ui/version_logs/v0.0.63.ui_opt/change_log.md`（topbar 视觉基线同步）。

---

## 1. 修订 11-squad.md §127（model 解析回退链说明）

**变更前**（v0.0.33.2 落地时表述）：
> provider override 与 model override 可用于测试；**常规 Studio UI 不需要显式传 model**。

**变更后**（v0.0.63.ui_opt 反映前端实际行为）：
> provider override 与 model override 可用于测试；**常规 Studio UI 可显式传 model**——
> - **member 单聊**：改 `member.model` 持久化（via `PATCH /squad/:id/member/:mid` body `{model: 'providerId/modelId'}`，inherit 清 `model=''` 走回退链）。
> - **squad 群聊**：作 **per-call override** 进 `POST /session/:id/messages` body 的 `providerId/modelId`，**不**改 `squad.modelDefault`（前端 `modelOverride` 本地 state，发送时塞进 body）。

**回退链不变**：`body override → member.model → squad.modelDefault → app 默认`（v0.0.33.2 已支持 body override）。

## 2. 端点契约零变更

复用的既有端点（行为已支持，本版本前端只是挂上 ModelPicker trigger 把 model 塞进去）：

| 端点 | 用途 | 契约位置 |
|---|---|---|
| `PATCH /squad/:id/member/:mid` body `{model?: string}` | member 单聊改 member.model 持久化 | `11a-squad-endpoints.md §2.2`（`model?` 列为可变字段） |
| `POST /session/:id/messages` body `{content, providerId?, modelId?}` | squad 群聊 per-call override（不改 squad 配置） | `04-agent-session.md §3.2` + `11-squad.md §3.2` |
| `GET /session/:id/usage` | ComponentUsagePanel 接（fetchOnce Promise.all 合并） | `04-agent-session.md`（既有） |
| `POST /session/:id/compact` / `POST /session/:id/clear` | CompactBtn / ClearBtn | `04-agent-session.md`（既有） |

> 后端代码零改动；本版本纯前端 UI 修复（F1-F5，详见 PRD §3 + tech change_log）。

## 3. 版本

v0.0.63.ui_opt（squad/member chat model 显式传 API 复用——§127 表述修订反映前端 ModelPicker 已挂载；端点契约零变更，回退链不变。AT 不跑——用户明确豁免，纯 UI 改动 UT only）。
