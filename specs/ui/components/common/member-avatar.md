# member-avatar

> 层级: primitive
> 文件: app/web/src/components/common/member-avatar.tsx

## 职责
渲染**色块 + 首字母**风格的方形圆角头像，下方可选附名字 label，右下可选 presence 状态点。跨页复用。边界：纯展示，无状态/回调；不依赖任何业务 store。

## Props
- name: string
- role: MemberAvatarRole
- id?: string
- size?: 'sm' | 'md' | 'lg' | 'xl'
- showName?: boolean
- showPresence?: MemberAvatarPresence
- testId?: string

## 状态 / 交互
- 纯展示，无交互。
- **色块底色**：
  - `user` → `var(--fg-2)`（中性灰，同 playground UserAvatar）
  - `squad` → `var(--brand-grad)`（三色渐变，全站仅 R logo + squad 头像两处，regulation 01 §1.8）
- **文字色**：`user → text-surface`（深底浅字）；其他 → （渐变/彩色底上白字）。
- **font**：（INV-4 无 font-serif，v0.0.165 衬线字全站下线）。
- **presence 点**：`showPresence !== undefined` 时右下渲染 10×10 圆点，`var(--presence-{status})` 底 + `var(--surface)` 2px 描边；size='sm' 时忽略（顶栏 inline 头像太小放不下）。

## 视觉基线
- **尺寸档**（regulation 02 §3）：
  - `sm`：14×14rounded-xs，无外层列、无名字 label、无 presence（顶栏 inline）
  - `md`（默认）：28×28rounded-lg + 外层 w-9 列（chat 三区布局对齐）
  - `lg`：48×48rounded-lg（**v0.0.165 从 34px→48px，服务坐席卡）

## 复用关系
- 被组合: `chat-page/chat-actor-strategy`（群聊 a2a sender / 单聊 member 头像，经 ComponentMessageStream resolveActor）/ `studio-page/section-studio-chat`（单聊 topbar 身份）/ 坐席卡 / member-panel
