---
type: spec
title: Mention Resolver —— 按 session kind 派生 provider 集合
priority: P0
status: active
updated: 2026-07-05
since: v0.0.68
---

# Mention Resolver —— 按 session kind 派生 provider 集合

> 管什么：`resolveMentionProviders(sessionKind, ctx) → ProviderName[]` 抽象——给定 session 的 biz/role/derivation，返回该 session **可见的 mention provider name 列表**。client（popover tab 显示）+ server（搜索校验/过滤）共用同一张映射表。
> 不管什么：provider 接口本身（→ `provider-interface.md`）；search API（→ `search-api.md`）；UI 渲染（→ `specs/ui/components/chat-page/`）。
> 消费者：web ChatComposer（派生 `enabledProviders`）/ MentionPopover（派生 tab 列表）；server `handlers/mention.ts`（搜索前校验 provider ∈ 允许集合）。

## 1. 设计动机（D8）

v0.0.45 上线 mention 子系统时只内置 file+skill 两个 provider，且**所有 sessionType 共享同一 provider 集合**（spec `search-api.md §6 未决事项 3`）。v0.0.68 新增 WorkItemProvider + MemberProvider 后，**不同 session kind 应启用不同 provider 集合**：

- playground 主聊 / subagent readonly：仅 file + skill（不暴露 squad 工作项/成员）
- squad 群聊：file + skill + workitem + member（讨论工作项、@成员）
- leader / mate 单聊：file + skill + workitem（讨论工作项，但不能 @member——单聊对端就是该 member，没必要 @它）

若硬编码到各调用点，client 与 server 易漂移（client 显示了 tab 但 server 拒绝，或反之）。D8 抽出**单一映射表**，client + server 双侧共用：

```
            ┌───────────────────────────┐
            │  resolveMentionProviders  │ ← 单一映射表
            │   (sessionKind, ctx)      │
            └─────┬─────────────────┬───┘
                  │                 │
        ┌─────────▼──────┐  ┌───────▼─────────┐
        │ client         │  │ server          │
        │ popover tab 列表│  │ search 校验/过滤│
        └────────────────┘  └─────────────────┘
```

## 2. 函数签名

```typescript
/** session kind 输入（resolver 不查 store，只看 kind 字段） */
interface SessionKind {
  biz: BizType;          // 'playground' | 'studio'
  role: Role;            // 'rocky' | 'leader' | 'mate' | 'squad' | 'subagent'（squadChat session 的 role 是 'squad'）
  derivation: 'main' | 'subagent';
}

/**
 * 按 session kind 派生 mention provider 集合。
 * @returns 该 session 可用的 provider name 列表（顺序稳定，影响 tab 排列）
 */
function resolveMentionProviders(kind: SessionKind): ProviderName[];
```

**约束**：
- **纯函数**（不查 store、无 IO），便于 client+server 共用、可单测
- **稳定顺序**：返回顺序 = popover tab 排列顺序（file → skill → workitem → member）
- **ctx 不传入 store**：当前映射表只依赖 kind 字段；后续若需按 squad 配置开关 provider，再扩签名

## 3. 映射表（用户已确认 v0.0.68）

| biz | role | derivation | providers |
|---|---|---|---|
| playground | rocky | main | `[file, skill]` |
| playground | subagent | subagent | `[file, skill]` |
| studio | squad | main | `[file, skill, workitem, member]` |
| studio | leader | main | `[file, skill, workitem]` |
| studio | mate | main | `[file, skill, workitem]` |
| studio | subagent | subagent | `[file, skill]` |
| 其他/兜底 | * | * | `[file, skill]` |

> @member 仅 squad 群聊可用——单聊对端就是该 member，@它无意义；playground/subagent 不接 squad 上下文。

## 4. 实现位置

`app/shared/mention-resolver.ts`（前后端共用，shared 包无 React/runtime 依赖）：

```typescript
export type MentionProviderName = 'file' | 'skill' | 'workitem' | 'member';

const PROVIDER_MATRIX: Record<string, MentionProviderName[]> = {
  'playground/rocky/main':       ['file', 'skill'],
  'playground/subagent/subagent':['file', 'skill'],
  'studio/squad/main':           ['file', 'skill', 'workitem', 'member'],
  'studio/leader/main':          ['file', 'skill', 'workitem'],
  'studio/mate/main':            ['file', 'skill', 'workitem'],
  'studio/subagent/subagent':    ['file', 'skill'],
};

export function resolveMentionProviders(kind: SessionKind): MentionProviderName[] {
  const key = `${kind.biz}/${kind.role}/${kind.derivation}`;
  return PROVIDER_MATRIX[key] ?? ['file', 'skill'];
}
```

**约束**：
- 不放 `app/server/` 或 `app/web/`（单边），否则对边要复制粘贴 → 漂移
- 不放 mention 子系统内部（`app/server/src/mention/`）—— client 也要用，必须 shared

## 5. 消费点

### 5.1 client（web）

`chat-page/component-chat-session-input.tsx`（统一输入区，7 处 chat 消费方共用）的 `<ChatComposer enabledProviders={...} />` 由 resolver 派生（biz/role 取自 chrome，derivation 恒 'parent'——只读页无输入区）：

```typescript
// 旧（硬编码）
<ChatComposer enabledProviders={['file', 'skill']} />

// 新（resolver 派生）
const enabledProviders = resolveMentionProviders({ biz, role, derivation });
<ChatComposer enabledProviders={enabledProviders} />
```

ChatComposer 内部 `PROVIDER_LABELS` 同步扩到 4 项（file/skill/workitem/member），未识别 provider name 仍过滤掉（防御性）。

### 5.2 server（search handler）

`handlers/mention.ts handleMentionSearch` 在调 `searchMentions` 前用 resolver 校验 `provider` 入参 ∈ 允许集合：

```typescript
// 1.5. 解析 session kind（read-only，不增 IO——session 已在 step 4 fetch，但本处提前到 step 1.5）
//      若 provider ∉ resolveMentionProviders(kind) → 404 ProviderNotFoundError
//      （不返 403，避免泄露 provider 存在性；与既有「未注册 provider → 404」语义一致）
```

**实现细节**：handler 当前在 `searchMentions` 内部才查 session（step 4）。resolver 校验需要 session kind——选择：(a) handler 提前查 session 一次（多一次 IO）；(b) service 接收 session 后用 resolver 校验。架构推荐 (b)（service 内已有 session，零额外 IO），handler 不变。

## 6. 测试覆盖

- UT `app/shared/mention-resolver.test.ts`：6 个矩阵 key 各一条 + 兜底 default 一条
- AT `tests/api/mention/resolver_session_kind_tc1`：leader 单聊调 `?provider=member` → **404**（`ProviderNotFoundError`，与既有「未注册 provider → 404」语义一致；不返 403，避免泄露 provider 存在性——见 `specs/api/version_logs/v0.0.68.md §1.1`）
- ET `tests/e2e/squad_chat_mention/mention_popover_providers_tc1`：4 session kind 各进一次 → popover tab 列表与映射表一致

> **拒绝码口径（D8 决策 + resolver_reject_code）**：未授权 provider 试探统一返 **404**（`ProviderNotFoundError`）。本节早期草稿写「400/403」是 spec 不一致点，已对齐 `specs/api/version_logs/v0.0.68.md §1.1` 的 404 口径——不泄露 provider 存在性。

## 7. 未决事项

1. **per-squad provider 开关**：当前矩阵全局静态；后续若某个 squad 想关 workitem provider，需扩签名加 `squadConfig` 入参（v0.0.68 不做）
2. **provider 顺序与 i18n**：当前 `file→skill→workitem→member` 顺序硬编码；i18n 只换 label，不换顺序
