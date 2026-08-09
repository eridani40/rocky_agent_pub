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
  /** mention pill 预填（studio 看板 @ 入口）；**v0.0.267 起仅在无草稿时注入**（草稿优先，见「输入区草稿」） */
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
| member 单聊 a2a 信封折叠 | 恒有（member 单聊内置） | — |

- **member 单聊 a2a 消息渲染**：member 单聊（非群聊）中，a2a inbox 消息走**左侧（assistant 侧）**，以信封折叠展示（收起态 = 信封 icon + senderName，展开态 = 灰色气泡正文，见 `component-a2a-envelope.md`）。`memberSideResolver` 不再将 a2a 特判到 user 侧。**[v0.0.301] a2a 信封行左侧头像为原 MemberAvatar 对象 invisible**（actor 解析 a2a 分支返回 `w-9 shrink-0 invisible` 包裹原头像，位置 100% 保真、信封不贴左；human user / 对端普通回复头像不受影响）。
- **群聊 a2a 消息渲染**：群聊（`groupRender`）中 a2a inbox 消息同样走共享内核 `isA2aInbox` 分支，以信封折叠展示在左侧（与单聊同一 `component-a2a-envelope.md` 契约）。**[v0.0.301] 与单聊一致，a2a 信封行左侧头像为原 MemberAvatar 对象 invisible**（`resolveGroupActor` a2a 分支返回 `w-9 shrink-0 invisible` 包裹原头像，信封位置不动；human user 头像保留）。
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

## 输入区草稿（v0.0.267）

输入区（`ChatComposer`）内建**草稿缓存**：每个 session 的未发送输入内容按 `sessionId` 内存级缓存（`chat-slice.drafts`，无 persist），切走再切回完整恢复（文本 + mention pill + 多行）。接线在 ChatComposer 内部（`use-chat-draft.ts` hook），**本组件零改动**——7 页消费方单点生效：

- **草稿 > prefill 优先级**：mount 时有草稿（`drafts[sessionId]` 非空）→ 恢复草稿、忽略 `prefill`；无草稿 → 走既有 prefill/initialContent 注入。草稿 = 用户未完成输入强意图，prefill = 外部跳转弱意图。
- **编辑即写**：onUpdate 实时写缓存（含空内容清除）；**发送后清除**：handleSubmit 内 `onSend` 后显式 `clearDraft`（不残留已发送内容）。
- **覆盖范围**：playground / studio 单聊群聊 / academy×4 全部经本组件接入的聊天页；subagent 只读页（readOnly）无输入区，不缓存不恢复。

详见 `chat-composer.md`「输入草稿缓存」节 + `app/web/src/store/chat-slice.ts`（drafts/saveDraft/clearDraft）。

## 复用关系

- 组合：BaseChatPage / BaseChatInputBar / ComponentMessageStream / ComponentChatRightOverlay / ComponentChatFloatMenu / ComponentEmptyState / 各 picker / HITL 卡。
- 取代并删除：section-chat-detail、component-academy-chat-col、use-academy-chat-usage、section-member-chat、section-squad-chat、component-member-chat-input-bar、use-studio-chat-chrome、use-model-restore。
