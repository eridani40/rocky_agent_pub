# section-chat-session（统一 chat 会话区）

> 层级: section
> 文件: app/web/src/components/chat-page/section-chat-session.tsx（+ component-chat-session-input.tsx 输入区组合 / component-chat-session-topbar-left.tsx 缺省身份 header / use-chat-chrome.ts 数据 hook / chat-actor-strategy.tsx 渲染策略）
> since: v0.0.216 · 由 section-chat-detail 演进（section-chat-detail.tsx 删除）
> 技术权威: specs/tech/app/frontend/[P0]chat_session_assembly.md；接口权威: specs/api/overall/04a-session-chrome.md

## 职责

**自给型统一 chat 会话区**：任何页面只需传 `sessionId` 即获得与主聊天同等的全部会话能力。内部自挂全部数据 hooks（useChatChrome + useMessages + useRunState + useUsage + useSummary + useSessionPanelFanout + useLoadMore）+ 全部 handlers（send/abort/compact/clear/enqueueCancel/model/effort/approvalMode），能力**缺省全开**，按后端 `GET /session/:id/chrome` 返回的 `capabilities` 门控。

**边界（不做什么）**：
- 不管页面身份要素——身份 header（`topbarLeft` render-prop）/ 空态内容（`emptyStateSlot`）/ placeholder / onBack 由消费方注入（每页残留 ≈6~25 行）。
- 不管布局容器——列宽/分栏/三栏引擎归宿主页（宿主高度链约束见 `academy-page/_overview.md §2`）。
- 不管会话列表 / workspace 面板 / 看板。

**核心不变量（防再犯）**：
1. **前端零 kind 字面分支**——渲染差异只依 `chrome.capabilities` / `chrome.members` / `chrome.readOnly` 数据驱动，组件内禁止出现 `biz === 'academy'` 类判断。
2. **禁止硬编码降级**——消费方不得再传 `pendingToolCall={null}` / `enqueueItems={[]}` 类哑值（这些 props 已不存在）。
3. **能力增量单点生效**——新会话能力（新卡片/新 picker）只改本组件（+capabilities 表），7 页自动生效。

## Props

```ts
interface SectionChatSessionProps {
  /** 唯一必填口子；null = 无会话（渲 emptyStateSlot，不拉 chrome） */
  sessionId: string | null;
  /** 已装配 chrome 注入（宿主已拉过时防双拉，如 studio router）；缺省内部自拉 */
  chrome?: SessionChromeView;
  /** 身份 header render-prop；缺省渲 chrome.title(+tag) + readOnly badge。
   *  缺省实现导出为 ChatSessionTopbarLeft（component-chat-session-topbar-left.tsx），
   *  含 titleOverride 口子供宿主注入实时标题（page-chat 用 store 列表标题——AI 自动命名即时可见，chrome 为 GET-once 快照） */
  topbarLeft?: (chrome: SessionChromeView) => ReactNode;
  /** 存在即渲返回键（消费方传 actionKey 语义，见 _conventions §12.8） */
  onBack?: () => void;
  backActionKey?: string;
  /** 前端强制只读；实效 readOnly = prop ∪ chrome.readOnly */
  readOnly?: boolean;
  placeholder?: string;
  /** 空态内容（messages 空 && 无 run 时）；缺省渲通用空文案 */
  emptyStateSlot?: ReactNode;
  /** mention pill 预填（studio 看板 @ 入口） */
  prefill?: MentionAttrs[];
  fadeIn?: boolean;
  rootTag?: 'section' | 'main';
  /** 消息流变化回调（training-observe 消息驱动任务刷新残留）；禁止用于回收 messages 自建 minimap（minimap 已内置） */
  onMessagesChange?: (messages: Message[]) => void;
}
```

## 状态 / 交互（capabilities 门控矩阵）

内置能力与门控字段（capabilities 静态表定义见 api `04a-session-chrome.md §4`）：

| 能力 | 门控 | readOnly 时 |
|---|---|---|
| 提问卡/审批卡（HITL） | `hitl` | 不出现（输入区整体隐藏） |
| 停止按钮 + run 态订阅 | `runState` | 不出现 |
| enqueue 排队区 | `enqueue` | 不出现 |
| effort picker / 审批模式 picker | `effortPicker` / `approvalPicker` | 不出现 |
| model picker（含「默认模型」项=chrome.defaultModel） | 恒有（输入区内） | 不出现 |
| usage 三件套 + CompactBtn | `usage` / `compact` | usage+Compact 保留 |
| ClearBtn + clear modal | `clear` | 隐藏 |
| minimap + 右上悬浮菜单 | `minimap` / `floatMenu`（cron 项按 `cron`） | 保留 |
| 群聊渲染策略（白名单 filter + a2a actor + max-w-760） | `groupRender`（配 members） | — |

- 卡片/按钮出现消失不得引起输入区位移（`10-tool-permission.md §10.3` 占位固定口径）。
- chrome loading 期间渲 BaseChatPage loading 占位；error → 空态 + console.warn。
- 可见文案：全部沿用既有组件契约（pending-question-card / pending-approval-card / usage-panel / effort-picker / approval-mode-picker 各自 spec），本组件不新增文案。

## 消费方接入清单（7 页）

| 消费方 | 残留职责 |
|---|---|
| page-chat（playground） | conv-panel/三栏/workspace + emptyStateSlot（欢迎 hero） |
| studio 单聊/群聊（section-studio-chat 薄壳） | topbarLeft（MemberAvatar/title+tag）+ prefill + onBack |
| academy 班主任 / 教练 | topbarLeft（avatar header）+ placeholder（教练另有 onMessagesChange） |
| academy 学生版本会话 | topbarLeft + placeholder（minimap/usage 全内置，父级不再回收 messages） |
| academy subagent 只读 | topbarLeft + onBack（chrome.readOnly 自动 true） |

## 复用关系

- 组合：BaseChatPage / BaseChatInputBar / ComponentMessageStream / ComponentChatRightOverlay / ComponentChatFloatMenu / ComponentEmptyState / 各 picker / HITL 卡。
- 取代并删除：section-chat-detail、component-academy-chat-col、use-academy-chat-usage、section-member-chat、section-squad-chat、component-member-chat-input-bar、use-studio-chat-chrome、use-model-restore。
