---
type: index
title: Mention 子系统总起
priority: P0
status: active
updated: 2026-07-07
since: v0.0.45
---

# Mention 子系统总起

## ① 是什么

mention 子系统 = **@ 提及系统的完整技术栈**——从 provider 注册 + 搜索到消息 content 内嵌 XML tag。用户在输入区输入 `@` 唤起多 tab 搜索面板（文件 / skill / workitem / member），选中结果插入 mention pill，消息以**单字符串**（含 `<mention .../>` 内嵌 tag）落库，LLM 收到 `<mention>` payload（含 address + display 全属性）。

| 核心概念 | 一句话 |
|---|---|
| **MentionProvider** | 搜索接口契约：`search(ctx: SearchCtx) → MentionItem[]`（provider 不感知 session 语义，只看 workspaceDir） |
| **MentionProviderRegistry** | server-side 轻量 Registry：按 name 注册 provider，search 时路由到对应 provider（→ `provider-interface.md`） |
| **MentionItem** | 搜索结果单元：`{ type, address?, display, listView }`（address = 稳定句柄；display = `{icon,label,badge?}` 呈现快照；v0.0.86 重构） |
| **MessageContent** | 消息 content = `string`，mention 以单行 XML tag 内嵌（v0.0.86 全属性 flat：address + display 同串持久化；→ `message-content.md`） |
| **SearchCtx** | 搜索上下文：从 sessionId 解析 workspaceDir / memberId / squadId（→ `search-api.md`） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| mention provider 注册 + 搜索 + 结果结构 | HTTP 端点路由 / middleware（→ `specs/api/`） |
| 消息 content 结构化 + 落库 + LLM 拼接 | agent loop / context engine（→ `../agent/`） |
| pill 数据结构（label / payload / type） | 前端 pill 渲染组件（→ `specs/ui/components/chat-page/`） |
| workspaceDir 解析逻辑（session→dir） | session 状态机 / workspace 管理（→ `../agent/session/`） |

## ③ 与系统的关系

```
   app/web（ChatComposer）
     │  @ 触发 → GET /mention/search
     ▼
   server/handlers/mention-search.ts
     │  sessionId → SearchCtx（workspaceDir / bizType / sessionType）
     ▼
   MentionProviderRegistry
     ├── FileProvider（workspace 文件搜索，含 node_modules/.git 排除）
     └── SkillProvider（SkillResolver 全量枚举 + 模糊匹配）
     │
     ▼
   MentionItem[] → 前端渲染 tab + 列表
     │  用户选中
     ▼
   MessageContent[] → POST /session/:id/messages → 落库 + LLM payload 拼接
```

**对外协作点**：前端 `ChatComposer` 调 search API 获取候选；`postMessage` 发结构化 content；server `buildSessionConfigFromDeps` 读 content 拼 LLM payload。

## ④ 核心设计原则（跨文件不变量）

1. **Provider 不感知 session 语义，只看 workspaceDir**——provider 接口只接收 `SearchCtx`（workspaceDir + query + limit/cursor），不直接读 Session / SquadStore / MemberStore。SearchCtx 由 handler 层从 sessionId 解析。→ `search-api.md`
2. **Pill 即内容本身，不是 UI 装饰**——mention pill 不是「文本的视觉包装」，而是消息 content 的一等公民（内嵌 `<mention .../>` tag）。落库存 string、回放渲染 pill、给 LLM 拼 prompt，三者从**同一份字符串**派生（INV-1）。→ `message-content.md`
3. **轻量 Registry，不挂 plugin EP**——mention provider 用独立 Registry（静态注册），不走 plugin ExtensionPoint。理由：plugin system 无前端 UI 贡献能力；扩展机制后续按需设计。→ `provider-interface.md`
4. **~~核心=地址，不嵌 name~~（v0.0.68 决策）→ display 持久化自洽（v0.0.86 翻转）**——address 是稳定句柄（落库后不变），display 是发送时刻快照（同串内嵌、随消息落库）。renderer 解析**同一字符串**取 display → pill，零 provider/store 调用。**display 不走 metadata 旁路存储**——address + display 全属性作为 message content 字符串的一部分 flat 落库，server 零处理透传。→ `message-content.md §2 §6`
5. **前端完全 type-agnostic（INV-2）**——renderer 只按统一 `{icon,label,badge}` 渲染，无 `if(type===...)` 分支。加新 type = provider 给新 icon key + Glyph registry 注册 SVG，渲染逻辑零改动。→ `specs/ui/components/chat-page/mention-pill.md`

## ⑤ 关键决策记录

### 做了的

| 决策 | 理由 |
|---|---|
| 轻量 Registry（不走 plugin EP） | plugin system 是纯 server-side，无前端 UI 贡献能力；首版 2 provider 足够 |
| 结构化 content 数组（text + mention） | pill 是一等公民，不是文本装饰；落库/回放/LLM 三统一 |
| BizType / SessionType 全局 alias | 消除 5+ 处内联 union，新增 `'rocky'` 供 SearchCtx 使用 |
| server 归一化（接收时兼容 string） | 向后兼容旧客户端；落库统一结构化 |

### 不做的（本版本）

| 不做 | 理由 |
|---|---|
| `/` `#` 触发字符 | 仅做 `@`，后续按需扩展 |
| `.gitignore` 默认开启 | 走 dev config 开关，默认关；file provider 仅排除 `node_modules` + `.git` |
| 扩展 plugin system 到前端 | ROI 不足；首版 2 provider 够用 |
| 第三方 mention provider 贡献机制 | 内置 FileProvider + SkillProvider 足够 |
| mention pill 内 markdown 渲染 | pill 是原子节点，内部不做 markdown |

### editor 选型决策

**选择：Tiptap（基于 ProseMirror）**

| 维度 | Tiptap | Slate | Lexical | contenteditable 自研 |
|---|---|---|---|---|
| bundle size | ~150KB（core + starter-kit） | ~100KB | ~120KB | 0（自研） |
| 学习成本 | 中（ProseMirror schema 概念） | 中 | 中-高 | 高（focus/selection/undo 全自研） |
| pill/chip 自定义节点 | 一等公民（`Node.create` + `atom: true`） | 支持（inline void） | 支持（decorator node） | 需自研 |
| 键盘导航开箱即用 | 中（需配合 suggestion extension） | 弱 | 弱 | 需全自研 |
| 社区活跃度 | 高（GitHub 28k+ stars，活跃维护） | 中（维护频率下降） | 中（Meta 内部使用为主） | N/A |
| React 契合度 | 高（`@tiptap/react` 官方绑定） | 高（slate-react） | 高（@lexical/react） | 高（自研） |

**选择理由**：Tiptap 的 `Extension` 机制 + `suggestion` 插件原生支持 `@` 触发 + 浮动面板 + 键盘导航，与 mention 需求高度契合。`atom: true` 的 inline node 天然实现 pill 整颗删除。ProseMirror schema 保证 pill 节点的序列化/反序列化健壮性。bundle size 代价（~150KB）在桌面端可接受。

## ⑥ 本目录导航

| 文件 | 管什么（一句话） | 链接 |
|---|---|---|
| `provider-interface.md` | MentionProvider 接口 + SearchCtx + MentionItem + FileProvider/SkillProvider/WorkItemProvider/MemberProvider 实现要点 | [link](provider-interface.md) |
| `message-content.md` | MessageContent 结构化数组 + 落库格式 + LLM 拼接 + 向后兼容 | [link](message-content.md) |
| `search-api.md` | server 端 mention-search service 设计（sessionId → workspaceDir 解析） | [link](search-api.md) |
| `resolver.md` | D8 按 session kind 派生 provider 集合（client+server 共用映射表） | [link](resolver.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `../version_logs/vX.Y/change_log.md`。
