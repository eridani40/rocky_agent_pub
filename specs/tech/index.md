---
type: index
title: Tech Specs 总起
priority: P0
updated: 2026-07-15
---

# Tech Specs 总起

## ① 是什么

本目录是 Agent 框架的**技术设计规范权威源**——定义「系统能做什么、各子系统是什么、怎么协作」。每个子系统目录是一个 OKF 知识库（KB）：`index.md` 总起 + `log.md` 变更 + 若干 spec 文件（frontmatter + 正文=现状）。代码是 specs 的实现；需求讨论、issue 分析先读 specs 不先读代码。

| 核心概念 | 一句话 |
|---|---|
| **agent/** | Agent 核心：接口/主循环/上下文/记忆/会话/LLM 接入/工具/技能/可观测（11 子 KB）|
| **squad/** | 多 agent 团队：leader/mate/charter/workitem/OKF+store 双层/自主性/**panorama DSL 看板** |
| **multi_agent/** | subagent 派生基础设施：scope=EP + agent 工具 + 模板 + a2a 协议 |
| **app/** | 应用编排：envs/frontend/package/start_up（Electron + web + server）|
| **plugin_system/** | 可扩展性基座：Extension Point + 插件声明/发现/安装/配置/威胁模型 |
| **persistence/** | 数据落地基座：SchemaDef + CrudStore 契约 + FS/SQLite engine |
| **config/** | 配置逻辑 schema：App/Dev/Plugin config + overlay 增量模型 + connectors |
| **mention/** | @ mention 系统：provider 注册 + 搜索 + 消息 content 结构化 |
| **migration/** | 启动期数据迁移主控：MigrationManager + ledger + handler registry + 文件锁 + `GET /bootstrap/status`（v0.0.150）|
| **testing/** | 测试基建双轨：AT 真实调 API 框架（case.yaml DSL + 429 skip + dev config copy，v0.0.190 起）+ ET agent 玩 app 范式（playwright-cli，v0.0.188 起）——均不录制不回放真调 LLM |
| **convention / docs_guide / deps** | 全局约定（命名/ID/时间）+ 撰写指南（必备章节/边界归属）+ 模块依赖图 |

## ② 边界

| 管 | 不管（→ 别处） |
|---|---|
| 技术架构 / 接口契约 / 数据模型 / 设计决策 | 产品需求 / 用户路径（→ `specs/prd/`）|
| 「怎么实现、组件/接口是什么」 | API 调用契约（→ `specs/api/`）|
| 代码路径 `文件.方法()` 指路 | UI 契约 / testid（→ `specs/ui/`）|
| 跨版本变更（→ `version_logs/`） | 参考竞品（→ 仓库根 `refs/`）|

## ③ 与系统的关系

```
   specs/prd（产品要什么）──→ specs/tech（怎么造）──→ specs/api（怎么调）/ specs/ui（怎么观测）
                                  │
       ┌────────────┬─────────────┼─────────────┬────────────────┐
       ▼            ▼             ▼             ▼                ▼
   agent(11子KB)  squad        app         plugin_system     persistence/config/multi_agent
   接口/循环/上下文 团队          编排          扩展基座          数据/配置/派生
       │
   底经 persistence（CrudStore）/ config（schema）/ plugin_system（EP）—— 子系统按依赖组合，详 deps.md
```

**对外协作点**：tech specs 是**概念权威源**——PRD 引用的组件/接口须与 tech 一致（概念先行，新概念先落 tech 再进 PRD）；coder 按 tech 编码；doc-modifier 维护 tech 现状 + log。

## ④ 核心设计原则（跨子系统不变量）

1. **概念先行**——tech specs 是概念权威；新概念先落 tech 再进 PRD，禁止 PRD 凭空发明。
2. **现状在文件、变更在 log**——spec 正文只描述「当前是什么」，版本史进 per-KB `log.md` + 跨版本 `version_logs/`。
3. **零件唯一归属**——跨子系统零件按「唯一归属」切分（见 docs_guide §4），spec 间不重叠。
4. **代码路径精确**——描述流程用 `文件.方法()→文件.方法()`，精确到源文件+方法。
5. **OKF 组织**——每子系统目录=一个 KB（index + log + frontmatter + 相对链接 + 坏链容忍），方法见 `.claude/skills/okf-skill/`，消费规范见 `.claude/skills/doc_specs/references/tech-spec-rules.md`。

## ⑤ 本目录导航

| 子系统 | 管什么（一句话） | 链接 |
|---|---|---|
| agent | Agent 核心（11 子 KB：loop/context/memory/session/llm/tools/skills/...）| [agent/index](agent/index.md) |
| squad | 多 agent 团队 | [squad/index](squad/index.md) |
| scheduling | 公共调度引擎（heartbeat + cron 共用）· v0.0.58 抽出 | [scheduling/index](scheduling/index.md) |
| multi_agent | subagent 派生 | [multi_agent/index](multi_agent/index.md) |
| app | 应用编排（envs/frontend/package/start_up）| [app/index](app/index.md) |
| plugin_system | 插件/扩展基座 | [plugin_system/index](plugin_system/index.md) |
| persistence | 数据落地（CrudStore）| [persistence/index](persistence/index.md) |
| config | 配置 schema | [config/index](config/index.md) |
| mention | @ mention 系统（provider + search + content 结构化） | [mention/index](mention/index.md) |
| migration | 启动期数据迁移主控（MigrationManager + ledger + handler registry + 文件锁 + GET /bootstrap/status）· v0.0.150 | [migration/index](migration/index.md) |
| testing | 测试基建双轨（AT 真实调 API + ET agent 玩 app，不录制不回放）· v0.0.190 | [testing/index](testing/index.md) |
| dev-logs | dev 调试日志（opt-in）| [dev-logs/index](dev-logs/index.md) |

**顶层参考文件**：[convention.md](convention.md)（命名/ID/时间）· [docs_guide.md](docs_guide.md)（撰写指南）· [deps.md](deps.md)（模块依赖图）

> 变更历史见各 KB `log.md`；跨版本发布说明见 `version_logs/vX.Y/change_log.md`。
