# v0.0.346 变更计划书 — mention 交互修复（触发逻辑 + 文件搜索与工作区搜索共用后端）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD：`specs/prd/v0.0.346-mention-interaction-fix.md`（主项目路径）。版本号 v0.0.346，分支 v0.0.346-mention-fix。

## 架构决策结论（PRD §7 四决策点）

| # | 决策点 | 结论 |
|---|--------|------|
| ① | 搜索核心提取方式 | **独立公共模块** `app/server/src/search/workspace-search-core.ts`（纯函数 `searchWorkspace` + `SEARCH_LIMIT=100`）。`session-workspace-search.ts` 与 `file-provider.ts` 双调用；`IGNORED_NAMES` 从 `session-workspace.ts` 单一源导入（不重复定义）。不走服务调用（无状态纯函数无需 DI）/不走参数化端点（mention 需本地排序分页 + 映射，不适合 HTTP 复用） |
| ② | FileProvider 边界 | **收敛为适配层**：`search()` 调 `searchWorkspace(ctx.workspaceDir, ctx.query)` → 合并 files+dirs 按 relPath 排序 → 按 limit/cursor 分页 → `toMentionItem` 映射。目录条目**复用 type='file' + path=目录相对路径**（display/listView icon 均 'file'，不新增字段、不新增 glyph key） |
| ③ | 缓存索引落位 | **不引入**。实时遍历 + 100 上限早停已控成本（与工作区搜索现状一致，无索引）；共享索引需文件变更失效（watch 集成）复杂度高、收益低。FileProvider 原 5s 超时移除（100 早停保障），与工作区搜索行为对齐 |
| ④ | 防抖统一 | **不强制统一，保持现状**：@ 搜索 200ms（面板内实时反馈），工作区搜索 **500ms**（v0.0.328 已从 300 调 500，见 component-ws-search-box.ts L7）。场景不同，改工作区防抖有回归风险 |

## 触发修复机制（插入文本门控 + 面板状态门控，PRD §2.1）

**双层门控**（单靠插入文本门控有缺陷：面板开着时输入查询字符会把面板关掉，违反 UC-4；必须叠加面板状态门控）：

1. **插入文本门控（触发源）**：`onUpdate` 解构 `transaction` → `getInsertedText(tr)` 提取本次插入字符 → `detectMentionTrigger(ed, insertedText)`：
   - `insertedText` 含 `@` → 扫光标前 50 字符返回 query（触发/重触发；覆盖「@ 键入弹面板」「新 @ 重触发」「@he query 实时」）
   - `insertedText` 不含 `@` → 返回 null（不触发；覆盖「取消后输 1/2/3 不弹」「删除回 @ 位置不弹」「选中 pill 后输入不弹」）
2. **面板状态门控（决定是否关闭）**：`detectTrigger` 用函数式 setTrigger（`prev` = 当前面板状态）：
   ```
   const query = detectMentionTrigger(ed, insertedText);
   setTrigger(prev => query !== null
     ? { query }                          // 含 @ → 触发/重触发（query 实时更新）
     : (prev !== null ? { query: scanMentionQuery(ed) } : null));  // 不含 @ 但面板开着 → 保留面板，仅刷新 query（scanMentionQuery = 扫光标前最近 @ 的 query 纯函数；面板关着 → 真正 null 不触发）
   ```
   实质：**插入文本决定「能否触发」，面板状态决定「要不要关闭」**。面板开着时输入非 @ 字符（UC-4 `@he`、`@a` 细化）→ 面板保留 + query 更新；面板关着时输入非 @ 字符 → 保持 null 不弹。
3. `handleClose`/`handleSelect` 保持 `setTrigger(null)` 不变（取消/选中 = 显式关闭，面板状态为 null，后续非 @ 输入不再触发）。

> 边界确认：UC-4（`@` 弹面板 → 输 `he` query 实时更新）由面板状态门控保障；UC-1/2（取消后输 `123` 不弹）由插入文本门控（null）+ 面板已关（null）保障；UC-3（再输新 `@` 重触发）由插入文本门控保障。scanMentionQuery 是唯一扫描实现（detectMentionTrigger 含 @ 分支与 detectTrigger 面板开着分支共用），不重复实现。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| search-core | `app/server/src/search/workspace-search-core.ts` | `SEARCH_LIMIT` | 新增 | = 100（从 session-workspace-search.ts 迁移） | MUST：单一上限源，两调用方共用 | session-workspace-search.ts L24 | +1 |
| search-core | `app/server/src/search/workspace-search-core.ts` | `WorkspaceSearchOptions` | 新增 | `{ relRoot?: string; limit?: number }`（relRoot 默认 ''；limit 默认 SEARCH_LIMIT） | MUST NOT：新增排除/匹配维度 | 同上 | +5 |
| search-core | `app/server/src/search/workspace-search-core.ts` | `WorkspaceSearchResult` | 新增 | `{ files: string[]; dirs: string[]; truncated: boolean }` | MUST：字段语义与现状一致 | 同上 | +3 |
| search-core | `app/server/src/search/workspace-search-core.ts` | `searchWorkspace(rootDir, q, opts?)` | 新增 | 同步 DFS（readdirSync/statSync/lstatSync）：IGNORED_NAMES 排除；pathMode（q 含 `/` → relChild 完整相对路径匹配，否则 basename）；目录命中推 dirs 不递归其下层；files+dirs ≥ limit 早停返 truncated:true；symlink 目录不递归 | MUST：IGNORED_NAMES 从 `session-workspace.ts` 导入（单一源）；MUST：安全面与现状一致（symlink 目录不跟随出 workspace）；MUST NOT：引入点开头排除 | session-workspace-search.ts walkSearch L31-90 + specs/api/overall/04-agent-session.md §2.6.8 | +60 |
| workspace-search-handler | `app/server/src/handlers/session-workspace-search.ts` | `walkSearch` | 删除 | 本地实现迁入 workspace-search-core.searchWorkspace | MUST：行为零回归（既有 UT 全绿：命中/ignore/100 截断/truncated/symlink/pathMode） | 同上 | -60 |
| workspace-search-handler | `app/server/src/handlers/session-workspace-search.ts` | `handleWorkspaceSearch` | 修改 | realRoot 校验后调 `searchWorkspace(realRoot, q, { relRoot: '' })`；响应 body 结构不变 | MUST：files/dirs/truncated 语义不变；MUST NOT：改端点契约 | 04-agent-session.md §2.6.8 | -8 |
| mention | `app/server/src/mention/types.ts` | `SearchResult` | 修改 | 加 `truncated?: boolean` | MUST NOT：改 items/nextCursor 语义 | specs/tech/mention/provider-interface.md §2 | +2 |
| mention | `app/server/src/mention/providers/file-provider.ts` | `FileProvider.search` | 修改 | 调 `searchWorkspace(ctx.workspaceDir, ctx.query)`；合并 files+dirs 按 relPath 排序；按 offset(limit/cursor) 切片；`truncated` 透传 | MUST：命中集合与工作区搜索一致（同一排除/遍历/上限）；MUST NOT：目录条目新增字段/新 type | PRD §2.2/§3.2 | -15 |
| mention | `app/server/src/mention/providers/file-provider.ts` | `collectWithTimeout` / `collectFiles` / `shouldSkip` | 删除 | 遍历/匹配/超时逻辑由 searchWorkspace 取代；5s 超时移除 | MUST NOT：保留 `name.startsWith('.')` 排除（点开头全放开，仅 IGNORED_NAMES） | PRD §2.3 | -55 |
| mention | `app/server/src/mention/providers/file-provider.ts` | `toMentionItem` | 修改 | 支持目录 relPath：type='file'，display.icon='file'，display.label=basename（目录名），listView.title=basename，subtitle=dirname，icon='file' | MUST：MentionItem 结构零新增字段；MUST：选中/插入/pill 链路不变（type='file' 走既有路径） | provider-interface.md §5 + PRD §3.2 | +4 |
| mention | `app/server/src/handlers/mention.ts` | `handleMentionSearch` | 修改 | 响应透传 `result.truncated`（仅 true 时输出 truncated:true，缺省省略） | MUST：与 workspace 搜索响应风格一致 | GET-search.md §3（doc-modifier 同步） | +3 |
| ui-chat | `app/web/src/components/chat-page/chat-composer-helpers.ts` | `scanMentionQuery(ed)` | 新增 | 从 detectMentionTrigger 抽出**纯扫描逻辑**：扫光标前 50 字符找最近未被空格中断的 @，返回其后的 query（空串 = @ 在末尾；无 @ → null）。供 detectMentionTrigger（含 @ 时）+ detectTrigger 面板开着分支复用 | MUST：单一扫描实现，不重复；MUST：纯函数无副作用 | 现 detectMentionTrigger L35-41 | +8 |
| ui-chat | `app/web/src/components/chat-page/chat-composer-helpers.ts` | `detectMentionTrigger` | 修改 | 签名加 `insertedText: string`（插入文本门控）：`insertedText` 含 `@` → 返回 `scanMentionQuery(ed)`（触发/重触发）；不含 `@` → 返回 null（不触发） | MUST：含 @ 时行为与现逻辑一致（扫 50 字符）；MUST NOT：不含 @ 时返回扫描结果（触发源门控） | PRD §2.1 行为表 | +3 |
| ui-chat | `app/web/src/components/chat-page/chat-composer-helpers.ts` | `getInsertedText(tr)` | 新增 | 遍历 `tr.steps` 提取 ReplaceStep/ReplaceAroundStep 的 slice 文本拼接 | MUST：纯函数无副作用；MUST：从 'prosemirror-transform' 导入 step 类型 | chat-composer-extension.tsx L158 事务先例 | +10 |
| ui-chat | `app/web/src/components/chat-page/component-chat-composer.tsx` | `onUpdate` / `detectTrigger` | 修改 | onUpdate 解构 `transaction` → `getInsertedText` → `detectMentionTrigger(ed, insertedText)`；**detectTrigger 用函数式 setTrigger 做面板状态门控**：`setTrigger(prev => query !== null ? { query } : (prev !== null ? { query: scanMentionQuery(ed) } : null))`——含 @ 触发/重触发；不含 @ 但面板开着保留面板仅刷新 query（UC-4）；面板关着才置 null；handleClose/handleSelect 保持 setTrigger(null) 不变 | MUST：面板开着时输入非 @ 字符不清面板（UC-4）；MUST NOT：改选中插入/pill/saveDraft 链路 | PRD §2.1 行为表 | +8 |
| ui-chat | `app/web/src/components/chat-page/component-mention-popover.tsx` | `SearchState` | 修改 | 加 `truncated?: boolean` | MUST NOT：改 items/nextCursor 语义 | PRD §3.1 | +1 |
| ui-chat | `app/web/src/components/chat-page/component-mention-popover.tsx` | `doSearch` | 修改 | 响应读 `data.truncated` → setState.truncated | MUST：append 翻页保留 truncated 透传 | 同上 | +2 |
| ui-chat | `app/web/src/components/chat-page/component-mention-popover.tsx` | 结果列表渲染 | 修改 | `state.truncated && items.length>0` → 列表底部渲染 `t('mention.searchTooMany')`（不阻塞「加载更多」滚动翻页） | MUST：文案走 i18n；MUST NOT：改键盘导航/选中 | PRD §2.2 文案 | +5 |
| ui-chat | `app/web/src/i18n/locales/zh-CN/chat.json` | `mention.searchTooMany` | 新增 | 「结果超过 100 条，请细化输入」（老板钦定逐字） | MUST：逐字一致；MUST NOT：改 workspace.preview.searchTooMany | PRD §2.2 | +1 |
| ui-chat | `app/web/src/i18n/locales/en/chat.json` | `mention.searchTooMany` | 新增 | "Over 100 results, please refine your input" | MUST：与 zh 同 key | 同上 | +1 |
| tests | `app/server/src/search/__tests__/workspace-search-core.test.ts` | 新增测试 | 新增 | searchWorkspace 直测：basename/pathMode 匹配、目录命中不递归、IGNORED_NAMES 排除、点开头可搜、100 早停 truncated、symlink 目录不递归 | MUST：覆盖 PRD 关键路径 5/6/7/9/10 | PRD §4 | +120 |
| tests | `app/server/src/mention/__tests__/file-provider.test.ts` | 现有测试 | 修改 | 适配层新行为：目录命中条目（type='file'/path=dir）、truncated 透传、点开头目录可命中、与 searchWorkspace 一致性 | MUST：既有分页/cursor/MentionItem 断言保持 | PRD §6-12 | +40 |
| tests | `app/server/src/handlers/__tests__/session-workspace-search.test.ts` | 现有测试 | 修改 | 提取后保持全绿（零行为回归） | MUST：所有既有断言不改语义 | 04-agent-session §2.6.8 | ±0 |
| tests | `app/web/src/components/chat-page/__tests__/chat-composer-helpers.test.ts` | 现有测试 | 修改 | getInsertedText 提取；scanMentionQuery（无 @ null / @ 末尾空串 / @he query）；detectMentionTrigger 插入门控（含 @ 触发 / 不含 @ null） | MUST：覆盖 PRD 用例 UC-1~UC-5 的纯函数侧 | PRD §5 | +45 |
| tests | `app/web/src/components/chat-page/__tests__/component-chat-composer.test.tsx` | 现有测试 | 修改 | **组件级状态门控**：面板开着输入非 @ 字符 → 面板保持 + query 更新（UC-4）；面板关着输入非 @ → 不弹（UC-1/2）；取消后再输新 @ → 重弹（UC-3）；选中 pill 后输入不弹（UC-5） | MUST：组件级验证双层门控，不只依赖纯函数 | PRD §5 | +40 |
| docs | `specs/api/mention/GET-search.md` | 文档 | 修改 | 响应 schema 加 `truncated?: boolean`；§3 响应示例补 truncated；§6 分页补充 truncated 语义（doc-modifier 同步） | MUST：与实现一致 | 本表 mention 行 | ±0 |
| docs | `specs/tech/mention/search-api.md` | 文档 | 修改 | 补充「FileProvider 适配层 + workspace-search-core 共用后端」架构说明（doc-modifier 同步） | MUST：与实现一致 | 本表 search-core 行 | ±0 |
| docs | `specs/tech/mention/provider-interface.md` | 文档 | 修改 | §5 FileProvider 要点更新：排除规则仅 IGNORED_NAMES、目录匹配/不递归、100 上限+truncated、共用核心（doc-modifier 同步） | MUST：与实现一致 | 同上 | ±0 |
| docs | `specs/ui/components/chat-page/mention-popover.md` | 文档 | 修改 | 超限提示渲染 + i18n key（doc-modifier 同步） | MUST：与实现一致 | 本表 ui-chat 行 | ±0 |
| docs | `specs/api/overall/04-agent-session.md` | 文档 | **不改** | workspace 搜索端点契约不变（评估结论：无需改动） | — | PRD §7 评估项 | ±0 |

## 追加问题 4（增量 v0.0.346-2）：@ file item 样式优化（icon 区分 + 路径展示）

> 老板 08-14 09:26 试玩反馈。PRD 追加 §2.4 + 路径 #12/13 + UC-14/15/16 + 验收 13-16。
> 本小节在既有 change_plan 上**增量追加**（不修改既有行）；既有 3 任务已完成不动。

### 决策结论（4 决策点）

| # | 决策点 | 结论 |
|---|--------|------|
| ① | dir 标记方案 | **MentionItem 加 `isDir?: boolean`**（最小侵入）。type 扩展 'dir' 破坏 renderer INV-2「无 type 分支」+ pill 链路，否决；仅 listView.icon 区分无数据标记，前端不可靠推断目录，否决。isDir 为可选字段：file-provider 设置，member/skill/workitem provider 不设（默认 false）；响应加可选字段向后兼容（旧前端忽略、新前端读不到默认文件） |
| ② | display.icon 是否同步区分 | **pill 保持 'file' 图标（display.icon 不动）**。老板只要求面板 item 区分；display.icon 序列化进 message tag 持久化（INV-1），改 pill 影响历史消息渲染一致性 + display 闭集合约束。面板区分走 listView（不持久化），零副作用 |
| ③ | Glyph registry 是否加 folder key | **不加；popover 走 ws-ico 样式（icons.tsx 组件）**。老板要求「类似工作区搜索图标样式」= ws-ico（FolderIcon gold / FileIcon muted），icons.tsx 已有 FolderIcon/FileIcon 直接复用；Glyph registry（primitive-mention-pill.tsx）保持 7 key 零改动（display.icon 仍 'file' 用不到 folder） |
| ④ | 路径展示映射位置 | **provider 输出（subtitle 根路径直接给 '/'）**。对齐 INV-1「provider 产出完整内容，前端零推导零补全」：toMentionItem 中 `subtitle: dirPart === '.' ? '/' : dirPart`（根路径 '/'，非根 dirname）；前端始终渲染 subtitle |

### 变更清单（增量行，追加到既有表）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| mention | `app/server/src/mention/types.ts` | `MentionItem.isDir` | 新增 | `isDir?: boolean`（true = 目录条目；缺省 = 文件，向后兼容） | MUST：可选字段；MUST NOT：改 type 枚举/display 闭集合 | PRD §2.4 + provider-interface.md §3 | +2 |
| mention | `app/server/src/mention/providers/file-provider.ts` | `toMentionItem` | 修改 | 加 `isDir` 入参（合并阶段保留 files/dirs 分离信息）：目录条目 `isDir: true` + `listView.icon='folder'`；文件条目 `isDir` 缺省 + `listView.icon='file'`；`subtitle: dirPart === '.' ? '/' : dirPart`（根路径 '/' 始终展示） | MUST：display.icon 保持 'file'（pill 不区分）；MUST：MentionItem 结构仅加 isDir 可选字段 | PRD §2.4 + 验收 13-16 | +6 |
| mention | `app/server/src/mention/providers/file-provider.ts` | `search` | 修改 | 合并 files+dirs 时**保留 dir 标记**（现 `[...dirs, ...files].sort()` 统一 relPath 丢标记）：改为 items 数组带 isDir 或并行数组，排序/分页后逐条 toMentionItem(relPath, isDir) | MUST：排序稳定（跨请求 offset 一致）+ 命中集合/分页行为不变；MUST NOT：改 searchWorkspace 返回值 | PRD §2.4 | +4 |
| tests | `app/server/src/mention/__tests__/file-provider.test.ts` | 现有测试 | 修改 | 更新断言：目录条目 `isDir: true` + `listView.icon='folder'`；文件条目无 isDir + icon='file'；根路径文件 subtitle='/'；非根 subtitle=dirname | MUST：既有分页/cursor/truncated/一致性断言保持；改「listView.icon 为 file」断言（现 L118-121 全 file）与「subtitle 可 undefined」断言（现 L184-194） | PRD 验收 13-16 | +15 |
| ui-chat | `app/web/src/components/chat-page/component-mention-popover.tsx` | item 渲染 | 修改 | 消费 `listView.icon` + `isDir`：上排 = icon（isDir ? FolderIcon gold : FileIcon muted，复用 icons.tsx，对齐 ws-ico 样式）+ title；下排 = subtitle **始终渲染**（provider 已保证 '/' 或 dirname 非空） | MUST：图标样式对齐工作区搜索（dir text-gold / file text-muted）；MUST NOT：改选中/键盘导航/truncated 提示；MUST：非 file provider（skill/member/workitem）item 无 icon 时保持现状（无图标或 Glyph 兜底） | component-ws-tree-item.tsx L103-108 + icons.tsx | +10 |
| tests | `app/web/src/components/chat-page/__tests__/component-mention-popover.test.tsx` | 现有测试 | 修改 | item 渲染断言：目录条目渲染 FolderIcon（gold）+ 根路径 subtitle '/'；文件条目渲染 FileIcon（muted）+ dirname | MUST：覆盖 UC-14/15/16 | PRD §5 | +25 |
| docs | `specs/api/mention/GET-search.md` | 文档 | 修改 | 响应 schema MentionItem 加 `isDir?: boolean`；file 响应示例补 isDir（目录条目 true / 文件条目缺省）（doc-modifier 同步） | MUST：与实现一致 | 本表 mention 行 | ±0 |
| docs | `specs/tech/mention/provider-interface.md` | 文档 | 修改 | §5 FileProvider 要点：toMentionItem 加 isDir（目录 true/icon folder）、subtitle 根路径 '/'（doc-modifier 同步） | MUST：与实现一致 | 同上 | ±0 |
| docs | `specs/ui/components/chat-page/mention-popover.md` | 文档 | 修改 | item 渲染：icon（isDir 区分 folder/file）+ 路径始终展示（根 '/'）（doc-modifier 同步） | MUST：与实现一致 | 同上 | ±0 |

### 追加影响面

- **破坏性变更**：无。mention 端点响应加可选字段 `isDir`（向后兼容）；MentionItem 结构加可选字段；既有 3 任务交付物零改动。
- **依赖顺序**：types.ts isDir → file-provider（toMentionItem/search 保留 dir 标记）→ popover 渲染 → UT。server 契约（#4）先行，web 消费（#5）依赖 #4。
- **风险点**：
  1. file-provider `search` 合并逻辑从「relPath 数组」改「带 isDir 标记」——排序稳定性必须保持（`[...dirs, ...files].sort()` 的 dirs 在前语义若改要等价），否则 cursor 分页跨请求 offset 不一致。
  2. popover 非 file provider（skill/member/workitem）item 无 isDir/无 folder icon——渲染必须兜底（有 icon 渲染 icon，无则现状），不能因 isDir undefined 崩溃。
  3. 既有 UT「listView.icon 为 file」「subtitle 可 undefined」断言会随 isDir/subtitle '/' 变更——必须同步更新（semantic-flip 纪律：改语义 grep 全部断言）。
- **ET 复验**：**需要**（UI 交互改动默认）。ET case 追加/复用：输入 `@auth` → item 上排 icon（文件夹 gold/文件 muted 可区分）+ 下排路径；输入 `@README`（根路径文件）→ 下排显示 `/`。

## 影响面评估

- **模块**：search-core（新）+ workspace-search-handler + mention（types/provider/handler）+ ui-chat（composer/popover/i18n）+ tests + docs。
- **破坏性变更**：无。workspace 搜索端点契约零变化（行为零回归，既有 UT 保护）；mention 端点响应**新增可选字段** truncated（向后兼容）；MentionItem 结构零字段变化。
- **依赖顺序**：search-core 提取 → session-workspace-search 改造 → file-provider 适配层 → mention handler → 前端 popover/i18n → UT。触发修复（ui-chat composer）与搜索升级无代码依赖，可并行。
- **风险点**：
  1. FileProvider 从「5s 超时 + 仅文件匹配」变「无超时 + 文件+目录匹配」——@ 面板行为变化符合 PRD；大 workspace 由 100 早停保障。
  2. `getInsertedText` 依赖 prosemirror-transform 的 step 类型——若 Tiptap v3 transaction.steps 结构异常需 coder 在 change_log 记录偏离（可用 `tr.docChanged` + 前后文本对比兜底）。
  3. IME 输入：composition 提交整段含 @ 会触发——符合「@ 键入触发」语义，可接受。
  4. **触发双层门控是本次交互修复的核心机制**：插入文本门控（detectMentionTrigger 返回 null/query）只管「能否触发」，面板状态门控（detectTrigger 函数式 setTrigger 读 prev）只管「要不要关闭」——两者缺一不可。单用插入文本门控会破坏 UC-4（面板开着输 he 被关）；单用面板状态门控无法区分「取消后输 123」（该不弹）与「面板开着输 he」（该更新 query）。coder 实现时严禁把两层合并成一层（如直接在 detectMentionTrigger 内读外部 state），否则 UC-1/UC-4 必有一个回归。
- **环境**：worktree 首次使用需 `bun install`（node_modules 独立）；dev.env 不存在但架构期不起 dev（UT 用 vitest 即可）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
