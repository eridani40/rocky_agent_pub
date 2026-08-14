# v0.0.346 change_log — mention 交互修复（触发双层门控 + 文件搜索共用 workspace-search-core）

> 对应需求：`reqs/[working] v0.0.346.mention-interaction-fix.md` + PRD `specs/prd/v0.0.346-mention-interaction-fix.md`（主项目路径）。
> 权威契约：`specs/tech/version_logs/v0.0.346/change_plan.md`（frozen）。
> commit：`11ed28696`（T1 搜索核心提取）/ `157e60169`（T2 FileProvider 适配层）/ `cbe08e2fb`（T2 review 修 Minor）/ `b6d67783b`（T3 前端触发 + popover + i18n）/ `a88402642`（T3 review）/ `1782cc8f8`（T4/T5 追加问题 4：isDir + popover icon/path）/ `d0f982fab`（T4/T5 review）。

## 变更摘要

老板确认方向（PRD §2.2 核心需求）：**@ mention 文件搜索与工作区搜索（session-workspace-search.ts）共用同一搜索后端/排除规则/100 上限+truncated**；同时修复 @ 触发交互缺陷（取消后输数字不弹、面板开着细化 query 不关、再输新 @ 重触发）。

| 决策 | 内容 |
|---|---|
| ① 搜索核心提取 | 独立公共模块 `app/server/src/search/workspace-search-core.ts`（纯函数 `searchWorkspace` + `SEARCH_LIMIT=100`）；`session-workspace-search.ts` 与 `file-provider.ts` 双调用；`IGNORED_NAMES` 从 `session-workspace.ts` 单一源导入 |
| ② FileProvider 边界 | 收敛为适配层：`search()` 调 `searchWorkspace` → 合并 files+dirs 按 relPath 排序 → 分页 → `toMentionItem` 映射。目录条目复用 `type='file'` + `path=目录相对路径`（零新增字段） |
| ③ 缓存索引 | 不引入（实时遍历 + 100 早停已控成本；共享索引需 watch 失效复杂度高收益低）；FileProvider 原 5s 超时移除 |
| ④ 防抖 | 不强制统一：@ 搜索 200ms / 工作区搜索 500ms（v0.0.328 已调），场景不同，改工作区有回归风险 |
| ⑤ 触发修复 | **双层门控**：插入文本门控（`detectMentionTrigger` 只管「能否触发」）+ 面板状态门控（`detectTrigger` 函数式 setTrigger 读 prev 只管「要不要关闭」），两者缺一不可 |

## 实现核对（T1/T2/T3）

| 计划项 | 实现一致性 |
|---|---|
| T1 search-core 提取 | ✅ `workspace-search-core.ts`（122 行）：同步 DFS（readdirSync/statSync/lstatSync）；`IGNORED_NAMES`（node_modules/.git）从 `session-workspace.ts` 导入单一源；pathMode（q 含 `/` → relChild 完整相对路径匹配，否则 basename）；目录命中推 dirs 不递归其下层；files+dirs ≥ limit 早停 truncated:true；symlink 目录不递归（防越权/循环）；**不引入点开头排除**。`session-workspace-search.ts` walkSearch 本地实现删除（-89），handleWorkspaceSearch 改调 `searchWorkspace(realRoot, q, { relRoot: '' })`，端点契约零变化 |
| T2 FileProvider 适配层 | ✅ `file-provider.ts`（84 行）：`searchWorkspace(ctx.workspaceDir, ctx.query)` 直调；合并 `[...dirs, ...files].sort()`（dirs 在前，跨请求 offset 稳定）；`slice(offset, offset+limit)` + nextCursor；truncated 透传（仅 true 携带）；collectWithTimeout/collectFiles/shouldSkip/SEARCH_TIMEOUT_MS 全删零残留；`toMentionItem` 目录条目 type='file' + label/title=basename + subtitle=dirname（'.' → undefined）；`types.ts` `SearchResult.truncated?: boolean`（+2）；`handlers/mention.ts` 响应仅 `result.truncated === true` 输出（缺省省略向后兼容） |
| T3 前端触发 + popover + i18n | ✅ `chat-composer-helpers.ts`：`scanMentionQuery`（从旧 detectMentionTrigger 抽出纯扫描，唯一扫描实现）、`getInsertedText`（遍历 tr.steps 提取 ReplaceStep/ReplaceAroundStep slice 文本）、`detectMentionTrigger(ed, insertedText)`（插入文本门控：含 @ → scanMentionQuery；不含 → null）；`component-chat-composer.tsx`：onUpdate 解构 transaction → getInsertedText → detectMentionTrigger；detectTrigger 函数式 setTrigger 面板状态门控；`component-mention-popover.tsx`：SearchState.truncated + doSearch 读取 + append 保留透传 + 列表底部超限提示（data-action-key="chat.mention.search-too-many"）；i18n：zh「结果超过 100 条，请细化输入」/ en "Over 100 results, please refine your input"（mention.searchTooMany，workspace.preview.searchTooMany 未误动） |

## 实现核对（T4/T5：追加问题 4 — @ file item 样式优化，v0.0.346-2）

| 计划项 | 实现一致性 |
|---|---|
| T4 types.ts isDir | ✅ `MentionItem` 加 `isDir?: boolean`（文件头注释：file provider 目录命中 true；缺省 = 文件，向后兼容；member/skill/workitem 不设）；type 枚举 / display 闭集合零改动（display.icon 仍 'file'） |
| T4 file-provider isDir + icon + subtitle | ✅ `toMentionItem(relPath, isDir = false)`：目录 `isDir:true` + `listView.icon='folder'`；文件 isDir 缺省 + `icon='file'`；`subtitle: dirPart === '.' ? '/' : dirPart`——根路径 '/' 始终展示；`display.icon` 保持 'file'（pill 不区分，防历史消息不一致）。合并数组改 `Array<{relPath, isDir}>`（dirs.map isDir:true / files.map isDir:false），显式 relPath 比较器排序（dirs 在前语义保持，排序结果与旧默认字典序实证等价） |
| T5 popover icon + subtitle | ✅ 导入 `FileIcon, FolderIcon` from './icons'（icons.tsx L78/L173，FolderIcon 默认 size=13，popover 传 size={13}）；`item.type === 'file'` 才渲染上排 icon，`const isDir = item.isDir === true` 严格比较（防 undefined 误判），目录 FolderIcon `text-gold` / 文件 FileIcon `text-muted`，`data-testid="mention-item-icon-{dir|file}"`；下排 subtitle `(item.type === 'file' || item.listView.subtitle)`——file 条目无条件渲染（provider 保证 '/' 或 dirname 非空）；非 file provider（skill/member/workitem）无 isDir 不渲染 icon、不崩溃，保持现状 |
| T4/T5 测试 | ✅ `component-mention-popover.test.tsx`（+156，5 条）：①目录 FolderIcon gold + 根路径 '/'（UC-14/15）②文件 FileIcon muted + dirname 路径（UC-14/16）③根目录文件 '/' 始终展示（UC-15）④非 file（skill）无 isDir 不渲染 icon ⑤非 file（member）无 subtitle 不崩溃。mock 策略：真实组件 fetch + `vi.stubGlobal('fetch')` 拦截（bun 下 vi.mock 拦不住模块导入）；jsdom 缺 scrollIntoView 已 polyfill。`file-provider.test.ts`（+24）semantic-flip 断言同步（旧「subtitle 可 undefined」→ 根路径 '/'；目录 isDir:true + icon='folder'） |
| 零改动验证 | ✅ 选中/键盘导航/truncated 提示链路零改动（diff 只动 item 渲染区 +19/-6）；searchWorkspace 返回值零改动（files/dirs/truncated 原样透出），分页/cursor/truncated 行为不变；全量 typecheck 0 error + 全量 UT 10455 绿（review 独立复跑） |

## 实现偏差（编码/评审期，以代码为准）

1. **T2 review Minor 修复**（`cbe08e2fb`）：file-provider.ts L15 死 import `join`（L66 是数组 `.join()` 方法，非 `path.join` 函数）——已从 node:path import 移除，tsc + UT 复跑全绿。
2. **T3 面板开着 @ 被删时关面板的 null 守卫偏离**（coder3 汇报，review 确认合理必要）：change_plan 面板状态门控伪码写「不含 @ 但面板开着 → `{ query: scanMentionQuery(ed) }` 保留面板仅刷新 query」；实现加 null 守卫——`scanMentionQuery(ed)` 返回 null（用户删掉 @）→ **直接关面板**（返回 null）而非强塞 `{ query: null }`（后者破坏 `MentionTrigger` 类型 `{query: string}` 且语义错误）。行为：面板开着时输入非 @ 字符且光标前仍有 @ → 保留面板刷新 query（UC-4 不变）；@ 已被删除 → 关面板（合理收敛）。
3. **T3 知悉项（非阻塞，后续版本处理）**：① handleSelect 内 `textBefore.match(/@(\S*)$/)` 与 scanMentionQuery 同模式但用途不同（选中删除定位需 atPos，scanMentionQuery 只返 query 无位置），属 pre-existing 历史代码，不构成「唯一扫描实现」违反；② composer 319 行 / popover 306 行超 300 线规则（改动前已 297/291 接近上限，历史欠账），建议后续版本拆分（如 popover 抽 search-list 子组件）。

## 触发双层门控机制（本次交互修复核心，v0.0.346 起生效）

1. **插入文本门控（触发源）**：`detectMentionTrigger(ed, insertedText)`——`insertedText` 含 `@` → 返回 `scanMentionQuery(ed)`（触发/重触发，query 实时）；不含 `@` → 返回 null（不触发）。
2. **面板状态门控（决定是否关闭）**：`detectTrigger` 函数式 `setTrigger(prev => ...)`——含 @ → `{ query }`；不含 @ 但面板开着（prev !== null）→ `scanMentionQuery(ed)` 非 null 则保留面板仅刷新 query（UC-4）、null 则关面板（偏差 2）；面板关着 → 真正 null（不触发）。
3. `handleClose`/`handleSelect` 保持 `setTrigger(null)` 不变（取消/选中 = 显式关闭）。

UC 覆盖：UC-1/2（取消后输 `123` 不弹）由插入文本门控（null）+ 面板已关（null）保障；UC-3（再输新 `@` 重触发）由插入文本门控保障；UC-4（`@` 弹面板 → 输 `he` query 实时更新）由面板状态门控保障；UC-5（选中 pill 后输入不弹）由 handleSelect setTrigger(null) 保障。

## 标准沉淀

- **搜索核心单源**：workspace 搜索与 @ mention 文件搜索共用 `workspace-search-core.searchWorkspace`（一套排除规则 IGNORED_NAMES / 一套遍历 / 一套 100 上限），后续新增消费方一律走该核心，禁止各自实现遍历逻辑。
- **truncated 响应风格**：达上限早停 → 响应带 `truncated: true`（仅 true 时输出，缺省省略向后兼容）；前端超限提示不阻塞分页翻页。

## 关键文件（编码产出）

| 文件 | 变更 |
|---|---|
| `app/server/src/search/workspace-search-core.ts` | 新增（+122，搜索核心纯函数） |
| `app/server/src/handlers/session-workspace-search.ts` | walkSearch 删 + 改调核心（-89） |
| `app/server/src/mention/providers/file-provider.ts` | 适配层收敛（-109 → 84 行） |
| `app/server/src/mention/types.ts` | SearchResult.truncated（+2） |
| `app/server/src/handlers/mention.ts` | 响应透传 truncated（+4） |
| `app/web/src/components/chat-page/chat-composer-helpers.ts` | scanMentionQuery/getInsertedText/detectMentionTrigger（+33） |
| `app/web/src/components/chat-page/component-chat-composer.tsx` | 双层门控接线（+38） |
| `app/web/src/components/chat-page/component-mention-popover.tsx` | truncated 消费 + 超限提示（+61） |
| `app/web/src/i18n/locales/{zh-CN,en}/chat.json` | mention.searchTooMany（各 +1） |
| 测试 | workspace-search-core.test.ts（+167）/ file-provider.test.ts（+131）/ chat-composer-helpers.test.ts（+197）/ component-chat-composer.test.tsx（+242） |
| `app/server/src/mention/types.ts`（T4） | MentionItem.isDir?: boolean（+2） |
| `app/server/src/mention/providers/file-provider.ts`（T4） | toMentionItem(relPath, isDir=false) + 合并数组 isDir 标记 + 显式排序（112 行） |
| `app/web/src/components/chat-page/component-mention-popover.tsx`（T5） | FolderIcon/FileIcon 渲染 + subtitle 条件（+19/-6；组件 323 行，知悉项） |
| 测试（T4/T5） | component-mention-popover.test.tsx（+156，5 条）/ file-provider.test.ts（+24，semantic-flip 同步） |

## 文档同步（doc-modifier，本版本）

- **`specs/api/mention/GET-search.md`**：响应 schema `SearchResponse` 加 `truncated?: boolean`；§3 补 file provider 截断响应示例（含目录条目 type='file' 说明）；§6 分页补 truncated 语义（仅 true 输出 / 前端超限提示 / 翻页保留透传）。
- **`specs/tech/mention/search-api.md`**：§5 性能考量 FileProvider 段重写为「workspace-search-core 适配层」架构说明（共用遍历/排除/上限、目录命中不递归、5s 超时移除、点开头不再排除）；§6 未决事项 1/4 标 v0.0.346 决策（防抖不统一 / 缓存索引不引入）。
- **`specs/tech/mention/provider-interface.md`**：§1 `SearchResult` 加 `truncated?: boolean`；§5 FileProvider 实现要点更新（排除规则仅 IGNORED_NAMES、目录匹配/不递归、100 上限+truncated、共用 workspace-search-core、目录条目 type='file'）。
- **`specs/ui/components/chat-page/mention-popover.md`**：新增「超限提示（v0.0.346）」小节（truncated 数据源 / 渲染条件 / i18n key 双语文案 / 与 workspace.preview.searchTooMany 不同 key）。
- **`specs/api/overall/04-agent-session.md`**：**不改**（workspace 搜索端点契约不变，评估结论）。

### 问题 4 增量同步（v0.0.346-2，doc-modifier）

- **`specs/api/mention/GET-search.md`**：MentionItem 加 `isDir?: boolean`（目录命中 true，缺省=文件）；截断响应示例补目录条目（`isDir:true` + `listView.icon='folder'`）+ 根路径条目 `subtitle='/'`；version 1.3→1.4。
- **`specs/tech/mention/search-api.md`**：§5 FileProvider 段补 isDir/icon 细节（目录 isDir:true + listView.icon='folder'；文件缺省 + 'file'；subtitle 根路径 '/' 始终展示；display.icon 保持 'file'）。
- **`specs/tech/mention/provider-interface.md`**：§3 MentionItem 加 `isDir?: boolean` + 字段决策表加 isDir 行；§5 FileProvider 要点更新（toMentionItem(relPath, isDir=false)、目录 isDir:true + icon='folder'、根路径 '/'、display.icon 保持 'file'）。
- **`specs/ui/components/chat-page/mention-popover.md`**：新增「icon + 路径展示（v0.0.346-2）」小节（FolderIcon gold text-gold / FileIcon muted text-muted、subtitle 始终渲染、非 file provider 兜底）。
