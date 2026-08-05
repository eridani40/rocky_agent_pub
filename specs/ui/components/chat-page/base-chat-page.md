type: component
purpose: chat 主区页级 base（骨架 + slot 注入）
since: v0.0.155
updated: 2026-07-29
consumers: [section-chat-session（v0.0.216 统一装配层，唯一装配消费方；7 个页面经它接入——playground / studio 单聊 / studio 群聊 / academy 班主任 / 教练 / 学生版本会话 / subagent 只读）]

## 1. 职责（管什么 / 不管什么）
**管什么**：chat 主区**纯骨架**——`<$root>` 容器 + topbar（左 slot + 右 slot）+ messages wrapper（含右缘 overlay 定位上下文）+ input bar slot + clear modal（三页同款）+ chrome loading 占位 + fadeIn 动画 wrapper。
**不管什么（INV-E1 纯骨架，装配在 section-chat-session）**：
- 数据装配（chrome / area-hooks / handlers）——统一归 `section-chat-session.md`（v0.0.216 统一装配层），本组件只收已装配 slot。
- 能力门控（群聊无 run 态、readOnly 等）——由 section-chat-session 按后端 capabilities 决定挂哪些 slot 内容。

## Props
- sessionId: string | null
- loading?: boolean
- topbarLeft?: ReactNode
- topbarRight?: ReactNode
- messagesSlot: ReactNode
- rightOverlaySlot?: ReactNode
- inputSlot?: ReactNode
- hideInputBar?: boolean（true 时不渲 inputSlot；readOnly / 无会话态用）
- onClear?: () => void
- clearModalOpen?: boolean
- onClearModalChange?: (open: boolean) => void
- rootTestid?: string
- rootTag?: 'section' | 'main'
- fadeIn?: boolean

## 视觉基线
- root：（主区占满 + 垂直排 + relative 为右缘 overlay 定位上下文）
- messages wrapper：（flex-1 占满中间 + overflow-hidden 让 ComponentMessageStream 内部滚）
- fadeIn 动画：`animate-[fadeIn_0.2s_ease-out]`（studio 页用，仅挂载时播一次）

## 消费方必备能力清单（MANDATORY 验收断言，v0.0.216 固化防再犯）

> 背景：历史模式「部分复用 + 手搓外围 + 硬编码降级」曾致 academy chat「长得一样但功能不一样」（HITL 卡不显示 / picker 缺失）。本清单是**任何 chat 页面的验收断言**：新增/修改 chat 页面时逐项核对。

1. **接入方式唯一**：所有 chat 页面 MUST 经 `section-chat-session` 接入（sessionId 唯一必填），MUST NOT 直接组装 BaseChatPage + area-hooks 自建装配层。
2. **能力缺省全开**：以下能力由 section-chat-session 内置、按后端 capabilities 门控，页面侧不得硬编码关闭/传哑值——
   提问卡（HITL ask）/ 审批卡（tool approval）/ 停止按钮（abort）/ effort picker / 审批模式 picker / model picker（含默认模型项）/ enqueue 排队区 / usage 三件套 + Compact / Clear + 确认 modal / 历史 query minimap / 右上悬浮菜单（记忆/定时）。
3. **能力差异只在后端**：kind 间差异（群聊关 run 态两 picker、只读页无输入区、默认模型来源）全部由 `GET /session/:id/chrome` 的 capabilities/readOnly/defaultModel 表达；前端零 kind 分支。
4. **页面残留仅身份要素**：身份 header / 空态内容 / placeholder / 返回行为 / 布局分栏——除此以外出现在页面装配代码里的会话能力接线 = 违规（code review FAILED 依据）。
5. **新能力单点生效**：新会话能力只在 section-chat-session（+后端 capabilities 表）实现一次，禁止逐页接线。

