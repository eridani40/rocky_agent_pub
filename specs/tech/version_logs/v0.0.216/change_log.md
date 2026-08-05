# v0.0.216 变更日志 — chat 区域统一复用架构（chat_unify）

> 发布说明（版本轴）。契约冻结见同目录 `change_plan.md`；per-KB 变更见 `specs/tech/app/frontend/log.md`、`specs/tech/academy/log.md`。

## 交付内容（A–F 六段全落地）

- **A 后端**：新增 `GET /session/:id/chrome`（`services/session-chrome.ts` 三类型 + CAPABILITIES 静态表 + `deriveChromeKind` + `buildSessionChrome`；`handlers/session-chrome.ts` GET-only handler）。权威契约 `specs/api/overall/04a-session-chrome.md`。
- **B 后端**：`model-resolver.ts` 补 academy 三档链（session → classroom.defaultModel → app 默认），`academy-session-model.ts` 创建链改调同一 resolver；`bootstrap-agent-phase.setResolveConfig` 复用 academyContext.classroom 零新增 IO。
- **C 前端**：统一装配层 `section-chat-session.tsx` + `use-chat-chrome.ts` + `chat-actor-strategy.tsx` + `component-chat-session-input.tsx`；`useRunState`/`useSummary` 加 `opts.enabled` 门；删 `section-chat-detail` / `use-model-restore` / `use-subagent-run-refresh`。
- **D studio**：`section-studio-chat.tsx` 薄壳（81 行）；删 `section-member-chat` / `section-squad-chat` / `component-member-chat-input-bar` / `use-studio-chat-chrome` / `squad-chat-helpers`（迁 chat-page/chat-actor-strategy）。
- **E academy**：4 消费方（班主任/教练/版本会话/只读页）全迁 SectionChatSession，能力全开；删 `component-academy-chat-col` / `use-academy-chat-usage`；新增共用身份 header `component-academy-chat-header.tsx`。
- **F 收敛**：列宽持久化单一源 `common/use-persistent-width.ts` + `academy-col-widths.ts`；删 academy `use-resizable-col` + academy 平行版 subagent 树；`component-subagent-tree` 扩可选 props（flat/onOpenNode/openNodeLabel/terminatedLabel）。
- 影响行：产品代码 +1607/-2431（change_plan 估 +1400/-2400 量级吻合）。

## 事后偏差（vs change_plan，均经 review 核实合理）

| 段 | change_plan 写法 | 实际落地 | 理由 |
|---|---|---|---|
| C | `InputModelPicker` 删内部自拉 /config/app 分支（隐含预期） | **保留** | 唯一活跃消费方 academy `component-tuple-cards.tsx`（版本卡 picker）依赖自拉；统一输入区恒传 defaultModelId 永不触发自拉 |
| C | SectionChatSession 内含缺省 header | 缺省 topbarLeft 拆出 `component-chat-session-topbar-left.tsx`（`ChatSessionTopbarLeft`，带 titleOverride 口子） | 单文件单组件 + 宿主可复用（page-chat 注入实时标题） |
| C | `use-subagent-run-refresh` 删除为开放点（丢帧则内部补拉） | 直接删除，无补拉 | 丢帧根因在 reducer 层早已根治（tool_call_* 按 evt.messageId 锚定 + 缺 message 兜底建 assistant message，chat-slice UT 锁定） |
| B | — | `resolveAcademySessionModel` 边界收敛：explicit 不可用时**继续下探 classroom** 档（旧实现短路直落 app 默认） | 与 change_plan「不可用继续下探」一致；旧行为无 UT 锁定，非回归 |
| E | — | 新增 `component-academy-chat-header.tsx`（+spec）；page-academy 删 classroomDefaultModel 透传 1 行 | 4 消费方 topbarLeft 免重复 JSX；prop 随迁移失去消费方防死代码 |
| F | `persistConvWidth` | 实际符号 `writeConvWidth`（use-three-col-layout.ts） | spec 符号漂移，按代码实际 |
| F | subagent 树只加 onOpenNode + 文案注入 | 另加 `flat`/`openNodeLabel` 可选 props + `onSelectSub`/`parentSessionId` 转可选；未导出 SubagentRow/SubagentGroupList；i18n 加 `chat:subagent.observe` | academy 平铺形态所需；缺省零变化 UT 锁定；避免死导出 |
| D | 单聊/群聊薄壳注入自定义 topbarLeft | 群聊走缺省 `ChatSessionTopbarLeft`（chrome.title=squad 名，建队时写入），仅单聊注入自定义 header | 与旧 header（back+title+tag）等价，少一份 JSX |

## 行为口径

- 群聊能力保持 v0.0.152 裁决（无 stop / 无两 picker / 无 enqueue / 无 cron），由 `studio_group` capabilities 表达。
- send actionKey 统一 `chat.message.send`（`studio.message.send` 随 D 段删壳退役）。
- localStorage 列宽 key 全兼容（`academy-*-width` / `conv-panel-width` / per-session ws key 原值读回）。
