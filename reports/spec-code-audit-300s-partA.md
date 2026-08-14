# spec↔code 同步审计 A：v0.0.301–323（15 个版本）

> 方法：逐版本读 change_log/change_plan → 找对应 spec → grep 生产代码核实（渲染树/装配引用，不只信文件存在）。
> 只审计不改：偏差记录于此，是否修由 leader 拍板。审计日期 2026-08-13。

## 总览

| 结论 | 版本 |
|------|------|
| ✅ 全同步 | 305, 306, 307, 315, 318, 320, 321, 323（8 个） |
| ⚠️ 有偏差 | 301, 302, 309, 310, 316, 317, 319（7 个） |

## 偏差明细表

| 版本 | 改动点 | spec 状态 | 具体偏差 | 建议修法 |
|------|--------|-----------|----------|----------|
| 301 | a2a 信封去头像 | ❌ PRD 落后 | PRD §3.1 写 `avatar: null`；代码实为 `w-9 shrink-0 invisible` 包裹原 MemberAvatar（位置保真）；ui spec（section-chat-session.md）已跟随代码，但 PRD 未改、也无 change_log 记录该偏离 | PRD v0.0.301 是历史版本日志可不改；但建议补 v0.0.301/change_log.md 记「null→invisible 包裹」偏离（当前该目录只有 change_plan） |
| 302 | KvConfigService 读缓存 | ❌ spec 落后 | 代码 kv-config-service.ts 有 `cache` 二级 Map + ensureGroupCache/invalidateGroup；spec `[P0]app_config.md` §5 只描述裸 KV 读写，零缓存提及；config KB log.md 无 v302 记录 | app_config.md §5 补缓存机制段（lazy fill + 整组失效 + write-through invalidate）；log.md 补行 |
| 302 | jsonlPut append 优化 | ❌ spec 落后 | 代码 fs-jsonl.ts 有模块级 `tailCache`（热路径零读 appendFileSync）+ appendSegmentLine；spec `[P0]fs_crud_store_engine.md` §3.4 仍只描述「append 尾段」抽象语义，无 tailCache/零读优化；persistence KB log.md 无记录 | fs_crud_store_engine.md §3.4 补 tailCache 机制（命中条件/失效时机/无持久化）；log.md 补行 |
| 305 | squad_meta 聚合+广播+sidebar 升级 | ✅ | squad-aggregate-service/broadcaster/event-types 三件套代码齐；`[P1]squad_aggregate.md` + index 导航齐；SSE 白名单+白名单测试齐；前端 use-squad-meta/sidebar 排序+pin/seats 聚合/i18n 三 key 全部与 spec 一致 | — |
| 306 | markdown 有序列表重置检测 | ✅ | 代码 prevNum 检测齐；行为记于 component-modal-md-editor.md（PrimitiveMarkdownView 渲染内核段）；primitive-markdown-view 无独立 spec 但消费方 spec 已覆盖 | （可选）为 primitive-markdown-view 建独立 spec，现行为寄生在消费方文档 |
| 306 | conv-item hover pin 按钮 | ✅ | 代码 onTogglePin 按钮（未注入不渲染）；_overview.md §56 双入口（hover pin + 右键）同一回调已记录 | — |
| 307 | worker pool 异步化 | ✅ | worker-pool/ 5 文件+engine-worker-dispatch 代码齐；tool_execution_engine.md 串行+worker 化+零件表三处已记录 | — |
| 309 | readSet 快照传入修复 | ⚠️ spec 轻落后 | 代码 submit 传 `Array.from(ctx.readSet)` + worker `new Set(req.readSet)`；spec 只有「readSet 跨 worker apply」半句，快照传入机制（D1）未落 spec | tool_execution_engine.md 零件表行补「readSet 快照传入（submit Array.from + worker 端初始化）」 |
| 310 | send_message 信封化 | ❌ spec 落后 | 代码 ViewElement 第 4 kind `send-message-envelope`（message-flatten + build-render-rows + types/message）；a2a-envelope.md 已记 out 方向/三态；但 **_data-flow.md 管线 §2 仍写 ViewElement 仅 3 种**（user-text/agent-answer/tool-call-item），groupToolBatches 段未提信封天然断裂 | _data-flow.md 管线阶段补第 4 kind + batch 断裂说明 |
| 315 | 解散弹窗大小写修复 | ✅ | 代码 `FIELD_LABEL.replace(' uppercase','')` 与 component-squad-delete.md 记录一致 | — |
| 316 | 配置面板统一保存 | ❌ spec 落后（工具 section） | studio 侧 5 个 spec 全齐（受控化）；page-app-settings-merged/observability 齐；**但 3 个工具 section spec（web-search/web-fetch/see-image _overview）仍写「保存按钮禁用直到选 type」旧 item 级语义，无 forwardRef/onDirtyChange/去 save 按钮**；**section-bash-config 完全无 spec（代码存在）** | 3 个 _overview.md 补 v316 受控化段；为 section-bash-config 新建 spec |
| 317 | SaveBar 全局规范 | ❌ spec 落后（4 处） | ① member-panel.md 仍写「右下角悬浮保存」，代码已改底部 SaveBar+reset；② section-channel-form.md 无 SaveBar/dirty 记录（代码 SaveBar variant=detail）；③ providers spec 无 provider-detail SaveBar/saving 记录（且 component-provider-detail 无独立 spec）；④ SectionLogsConfig（section-logs-config.tsx）无 spec，仅存在于 change_plan_supplement | ① member-panel 保存段改写；② channel-form 补 SaveBar/dirty 段；③ providers 补 detail SaveBar；④ 为 SectionLogsConfig 建 spec |
| 318 | 配置同步 | ✅ | section-config-sync.md + component-config-tree.md 齐（含 SHA-256 偏离指针）；纯前端后端零改动与 spec 一致 | — |
| 319 | 团队同步 | ⚠️ spec 轻落后 | API 契约 11d-squad-team-sync.md 齐；UI section-team-sync.md 齐；**但 tech/squad KB 无 team-sync 服务层 spec**（export/import/ImportKeyStore/validateZipEntries 只存在于 change_plan+change_log） | 新建 `[P1]team_sync.md`（服务层+路径安全+TTL）入 squad KB，index 补导航 |
| 320 | 文件预览区 | ✅ | section-preview-area.md 全组件族齐（含 Provider 上移偏离/fallback 降级）；preview_hooks.md 齐；chat-link-viewer.md 退役说明齐；API change_log 齐 | — |
| 321 | 导出选择器+leader 实名 | ✅ | section-team-sync.md 选择器流程齐；component-export-team-picker-modal.md 齐；squad_templates.md 实名特例+restoreAgentFileName 齐 | — |
| 323 | 悬浮胶囊 | ✅ | section-preview-area.md §5.6 胶囊化（常驻/按钮序/图标 edit-2+check-circle）与代码一致 | — |

## 偏差统计

| 类型 | 数量 | 明细 |
|------|------|------|
| spec 落后（代码改了 spec 没改） | 9 | 302×2、309、310、316×3（工具 section）、317×4、319 |
| spec 缺失（代码有 spec 无） | 3 | section-bash-config（316）、SectionLogsConfig（317）、team-sync 服务层 KB（319） |
| PRD 落后/偏离未记录 | 1 | 301（avatar null vs invisible 包裹） |
| spec 超前（spec 写代码没有） | 0 | 退役组件 spec 均带 DEPRECATED 标记且消费方引用已清（tab-save-bar/group-save-bar/chat-link-viewer） |

## 备注

- 退役组件（component-tab-save-bar/group-save-bar/chat-link-viewer/ws-file-editor）spec 均已写「废弃→指向新组件」，代码侧零残留引用，无 spec 超前问题。
- v301-310 大多只有 change_plan 无 change_log（301/302/309/310/315/323），编码期偏离（301 null→invisible）缺事后记录。
