# v0.0.301 — a2a 信封消息去掉左侧发送者头像 — PRD

> version: 1.0 · 引入版本 v0.0.301 · 类型：**小 UI 调整（纯前端展示）** · 最后更新：2026-08-08
> 权威输入：leader 派单 T1（v0.0.301）+ `states/v0.0.301/context.md`
> 概念权威源（本 PRD 必须对齐，不发明概念）：
> - `specs/ui/components/chat-page/component-a2a-envelope.md`（a2a 信封折叠组件契约）
> - `specs/ui/components/chat-page/section-chat-session.md`（chat 会话区 + groupRender/member 单聊渲染矩阵）
> - `specs/ui/components/common/member-avatar.md`（MemberAvatar 组件契约）

## 目录

| 章节 | 文件 | 说明 |
|------|------|------|
| §1 目标 + 动机 | 本文 | 信封消息左侧头像冗余 |
| §2 范围 | 本文 | 只改 a2a actor 分支 avatar 渲染 |
| §3 功能设计 | 本文 | avatar=null + 布局占位保持 |
| §4 关键用户路径（MANDATORY） | 本文 | 群聊 / 单聊 两条链路 |
| §5 PRD ↔ ui/tech spec 对齐 | 本文 | 引用已有概念，不发明 |
| §6 验收标准 | 本文 | 无头像 + 信封展开正常 + 零回归 |

---

## 1. 目标 + 动机

### 1.1 问题

studio 的 squad（群聊 + member 单聊）内，收到 a2a 消息时以「信封折叠」展示（收起态 = 信封 icon + senderName，点击展开 = 灰色气泡正文）。当前在信封左侧还渲染了发送者的 `MemberAvatar` 头像，与信封组件本身的 senderName 信息**重复**，视觉冗余。

### 1.2 目标

去掉 a2a 信封消息左侧的发送者头像，**仅保留信封 + 信封展开逻辑**：
- a2a 信封消息左侧不再渲染 MemberAvatar
- 信封折叠/展开交互保持不变
- senderName 仍显示（信封行内，不依赖头像）
- human user 及其他消息（assistant answer / tool / 群聊普通用户消息）头像**零回归**

---

## 2. 范围

### 2.1 改动面

1. **`chat-actor-strategy.tsx`**：a2a inbox 分支（`resolveGroupActor` 群聊 L66-70 + `resolveMemberActorFactory` 单聊 L103-109）不再渲染 MemberAvatar → `avatar: null`
2. **布局占位**：确认左侧头像位不因去掉头像而塌陷（见 §3.2）

### 2.2 明确不做（边界）

- 不改 `component-a2a-envelope.tsx`（信封组件本身零改动：收起/展开/senderName/气泡全部保留）
- 不改 `isA2aInbox` / `a2aRefOf` / `memberSideResolver`（a2a 判定与左右侧逻辑不变）
- 不改 human user / assistant answer / tool 消息的 actor 渲染
- 不改后端 / API（纯前端 UI 调整）
- 不新增 AT 持久 case（确定性 UI 改动，UT + ET 视觉确认即可，见 §6）

---

## 3. 功能设计

### 3.1 actor 解析变更（核心）

`resolveGroupActor`（群聊）与 `resolveMemberActorFactory`（单聊）的 **a2a inbox 分支**返回 `avatar: null`，其余字段（`name` / `showNameAsPrefix`）**保持不变**：

```ts
// 群聊 a2a 分支（resolveGroupActor 内）
if (isA2aInbox(msg)) {
  const ref = a2aRefOf(msg)!;
  return {
    avatar: null,            // ← 变更：不再渲染 MemberAvatar
    name: ref.name,          // 保留：信封组件 senderName 数据源
    showNameAsPrefix: true,  // 保留（但 message-stream 对 a2a 不渲染前缀行，见 §3.3）
  };
}

// 单聊 a2a 分支（resolveMemberActorFactory 内）
if (isA2aInbox(msg)) {
  const ref = a2aRefOf(msg)!;
  return {
    avatar: null,            // ← 变更
    name: ref.name,          // 保留
    showNameAsPrefix: true,  // 保留
  };
}
```

**为什么 avatar=null 可行**：`component-message-stream.tsx` L226/L236 的渲染表达式是 `{actor ? actor.avatar : <DefaultXxxAvatar/>}` —— **actor 对象存在时渲染 `actor.avatar`，为 null 则不渲染头像节点**（不会 fallback 到默认头像）。这正好满足「a2a 行无头像」，同时 human user / assistant 分支 `avatar` 仍为非 null 的 MemberAvatar，零回归。

### 3.2 布局稳定性（MANDATORY）

当前消息行左侧布局（assistant 侧 L236-237）：

```tsx
{actor ? actor.avatar : <DefaultAgentAvatar/>}
<div className="flex-1 ...">…</div>
<div className="w-9 shrink-0" aria-hidden />   {/* 右侧占位 */}
```

去掉 avatar 后，左侧头像位**消失**，信封将贴左对齐。信封行本身是 `inline-flex`（视觉紧凑），贴左无碍；但需确认：
- 消息行 flex 布局不因左侧无元素而异常（`gap-2.5` 对无子项不产生多余间距）
- **message-stream 渲染 a2a 信封时，`actor.avatar` 为 null 直接不渲染节点**，不额外加占位 div（信封行内高度本来紧凑，无需 w-9 占位对齐——对齐语义由信封自身承载）

> 说明：user 侧 L210 有 `w-9 shrink-0` 占位（右侧头像位）与 L226 头像配合；assistant 侧 L261 也有 `w-9 shrink-0`（右侧预留）。a2a 走 assistant 侧，**只去左侧头像节点本身**，右侧 `w-9` 占位与整体 flex 结构不动（零回归最小 diff）。

### 3.3 senderName 与展开逻辑（保留，验证点）

- 信封组件 `ComponentA2aEnvelope senderName={actor?.name ?? ''}` 的 **senderName 数据源是 `actor.name`，不是头像** —— 头像去掉不影响 senderName 显示。
- 收起/展开交互完全在信封组件内部（本地 `useState`），与 message-stream 的 actor.avatar 渲染**解耦**，零影响。
- `showNameAsPrefix` 在 message-stream L239 对 a2a 消息有 `!isA2aInbox(msg)` 守卫（a2a 不渲染前缀行），保留即可，无需改动。

---

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

### 路径 1：studio 群聊中收到 a2a 消息（信封无头像）

- 链路：进入 studio squad 群聊 → 其他 agent 发来 a2a 消息 → 消息以信封形式出现在左侧 → **信封左侧无发送者头像** → 点击信封 → 展开灰色气泡正文（senderName + 正文可见）→ 再点击 → 收起
- 关键断言：a2a 信封行左侧无 MemberAvatar；信封 icon + senderName 可见；点击展开/收起正常

### 路径 2：studio member 单聊中收到 a2a 消息（信封无头像）

- 链路：进入 studio member 单聊 → 收到 a2a 消息 → 信封显示在左侧 → 左侧无头像 → 点击展开 → 正文正常
- 关键断言：同路径 1（单聊分支）

### 路径 3：human user 消息零回归（头像保留）

- 链路：群聊/单聊中用户自己发送消息 → 右侧 user 头像（`MemberAvatar role='user'`）仍显示
- 关键断言：human user 消息头像与改动前一致

### 路径 4：assistant answer / 对端消息零回归（头像保留）

- 链路：群聊中 assistant answer 被过滤（群聊白名单）；单聊中对端 member 的普通回复（非 a2a）→ 左侧对端头像仍显示
- 关键断言：非 a2a 消息头像渲染不变

### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | studio 群聊 → 收到 a2a 消息 → 看信封行左侧 | 信封行左侧**无头像**；信封 icon + senderName 可见 |
| UC-2 | 点击信封 → 展开 → 再点击 | 展开态灰色气泡正文可见（senderName + 正文）；再点收起 |
| UC-3 | 群聊中自己发消息 / 单聊中看对端回复 | 头像照常显示，与改动前一致（零回归） |

---

## 5. PRD ↔ ui/tech spec 对齐

| PRD 引用概念 | 权威来源 | 对齐状态 |
|---|---|---|
| `ComponentA2aEnvelope` 信封组件 | `specs/ui/components/chat-page/component-a2a-envelope.md` | ✅ 组件零改动，仅其左侧不再有头像 |
| `resolveGroupActor` / `resolveMemberActorFactory` actor 解析 | `chat-actor-strategy.tsx`（spec 见 `section-chat-session.md` 渲染矩阵） | ✅ 只改 a2a 分支 avatar → null |
| `MemberAvatar` | `specs/ui/components/common/member-avatar.md` | ✅ 组件本身不改，仅 a2a 场景不实例化 |
| 群聊渲染策略（groupRender + a2a actor） | `section-chat-session.md`「capabilities 门控矩阵」groupRender 行 | ✅ 策略结构不变 |
| member 单聊 a2a 信封折叠 | `section-chat-session.md`「member 单聊 a2a 消息渲染」 | ✅ 信封折叠保留，仅去头像 |

**无新概念发明**：avatar 置 null 是既有 actor 解析产物的合法取值（`avatar: ReactNode` 可空），非新组件/新属性。

---

## 6. 验收标准

1. ✅ studio 群聊 a2a 信封消息左侧**不渲染** MemberAvatar（无头像节点）
2. ✅ studio member 单聊 a2a 信封消息左侧**不渲染** MemberAvatar
3. ✅ 信封折叠/展开交互不变（收起 = 信封 icon + senderName；点击展开 = 灰色气泡正文；再点收起）
4. ✅ senderName 仍显示（信封行内，来自 actor.name）
5. ✅ human user 消息头像不变（右侧 `MemberAvatar role='user'`）
6. ✅ 单聊对端 / 其他非 a2a 消息头像不变（零回归）
7. ✅ 布局稳定：a2a 信封行贴左显示正常，无多余间隙/塌陷；用户侧 `w-9` 占位与整体 flex 结构不动
8. ✅ 相关 UT 全绿（chat-actor-strategy / component-message-stream / component-a2a-envelope 测试随改动同步更新）
9. ✅ ET 视觉确认：a2a 信封无头像 + 展开正常（纯 UI 改动，无 AT 需求）
