# v0.0.241 tech change_log — 内置 file viewer/editor 扩多格式 + 格式化/校验

> 类型：纯前端 UI 改动（web/ 渲染层 lib util + 共享 modal 扩 Props + 挂载层改名）。无 schema / EP / 插件 manifest / 后端 handler / API 契约字段变更（后端 read/save 端点通用不限扩展名，仅注释/范围说明过时）。
> 权威变更契约见同目录 `change_plan.md`（method 级 8 模块 + 4 处偏离已对齐本文档）。PRD：`specs/prd/version_logs/v0.0.241.md`。

## 影响子系统 KB

| KB | 改什么 |
|----|--------|
| `specs/tech/app/frontend/` | `index.md` ① 加「file-format 格式分类 + format/validate 纯函数库」概念行（`lib/file-format.ts` 分类常量 + 7 结构化 format/validate + modal 扩 format Props + view 分流 + hint 状态机）+ ④ 加原则 25（格式分类守门在前端、后端 read/save 不限扩展名 + format/validate 失败不动 draft）；`log.md` v0.0.241 条目（含 XMLValidator 偏离 / i18n 6 vs 7 key 偏离 / 代码↔spec 一致核查 / OUT OF SCOPE）+ frontmatter `updated` |

> 未触其他 tech KB：后端零变更（`session-workspace-file.ts` read/save handler 通用不限扩展名，v0.0.227 已确立）→ `agent/session/` workspace handler 零动；`persistence/` / `plugin_system/` / `config/` 等均不沾。

## 摘要

### ① file-format.ts 格式分类常量库（change_plan 模块 A）

`app/web/src/lib/file-format.ts` NEW——纯前端 UI 侧分类决策（不进 chat-api 后端契约）：

- `FileFormat` type union：12 形态 = `'md' \| 'json' \| 'jsonl' \| 'yaml' \| 'xml' \| 'toml' \| 'csv' \| 'tsv' \| 'txt' \| 'ini' \| 'env' \| 'log'`（11 新 + md 向后兼容）
- `FileFormatCategory`：`'md' \| 'structured' \| 'plain'`（structured=7 格式有 format/validate；plain=4 格式仅查看；md 走原链路）
- `FormatResult` union：`{ ok: true; output: string } \| { ok: false; error: string; line?: number; col?: number }`
- `EXT_TO_FORMAT` 映射表（键全小写，含 `.yml`→yaml 双后缀；不含编程语言后缀）
- `getFileFormat(path)`：basename 取 `lastIndexOf('.')` 防多扩展名误判（`.user.config.json` → `.json`）+ `.env`/`.env.*` 特判返 `'env'` + 大小写不区分
- `getCategory(fmt)`：switch 闭合 12 case，default `'plain'` 兜底
- `isBuiltinEditable(path)`：= `getFileFormat(path) !== null`（便利函数，禁重复实现判定）

### ② 7 结构化 format/validate 纯函数（change_plan 模块 B）

`app/web/src/lib/file-format/{json,jsonl,yaml,xml,toml,csv,tsv}.ts` NEW——每种 `format*(text): FormatResult` + `validate*(text): FormatResult`，纯函数无 IO 无副作用。`index.ts` = dispatcher（`formatText(format,text)` / `validateText(format,text)` 按 format 路由，md/plain 返 unsupported）。

库选型：JSON/JSONL 原生（V8 默认不转义中文）+ YAML 用已装 `yaml` ^2.9.0 + **XML 新装 `fast-xml-parser` ^4.5.0** + **TOML 新装 `smol-toml` ^1.3.0** + CSV/TSV 手写 RFC 4180 引号转义 + 列对齐（末列 `trimEnd` 去尾空白防 git diff 噪音，不改字段数）。两新依赖落 `app/web/package.json`（持续可打包护栏：前端纯 JS 库，packaged 后端不引用 → 无 asar 风险，但必须进 workspace package.json 不能只进根）。

### ③ modal 扩展为通用 file editor（change_plan 模块 E）

`component-modal-md-editor.tsx` Props 加 `format?: FileFormat`（缺省 `'md'` 向后兼容 academy；文件名保留 md-editor 历史，命名泛化留 follow-up）。派生 `category = getCategory(format ?? 'md')` 一次：

- **view 按 category 分流**：md→`PrimitiveMarkdownView`（academy 回归保护）/ structured+plain→`<pre>` 朴素预览（p-18/22 + mono 13px/1.7 + `whitespace-pre-wrap break-words`，无高亮/行号/折叠）
- **edit 格式按钮**：edit + structured 显「格式化」「校验」两 BTN_SECONDARY；plain/md 用 `visibility:hidden` 渲染同尺寸占位（保布局稳定，禁 `display:none`+条件渲染致位移）；view 模式一律不渲染
- **hint 状态机**（优先级链）：`saveError > validateResult.kind==='error' > validateResult.kind==='ok' > idle 默认 hint/versionLabel`

新增 `ValidateState` 三态（idle/ok/error）+ `handleFormat`（失败不动 draft，防洗空坏内容）+ `handleValidate`（不阻塞保存，last-write-wins）。open effect 重置 validateResult 回 idle。

### ④ 挂载层改名 + 拦截点泛化（change_plan 模块 C/D）

- **挂载层改名** `component-ws-md-editor.tsx` → `component-ws-file-editor.tsx`（chat-page/）：`WsMdTarget` → `WsFileTarget`（加 `format: FileFormat` 必填字段）+ `ComponentWsMdEditor` → `ComponentWsFileEditor`；向 `<ComponentModalMdEditor>` 透传 `format`，读/存逻辑零改。仅 `section-workspace-panel.tsx` 一处 import 牵连（grep 核实无残留）。
- **拦截点泛化**（`section-workspace-panel.tsx handleOpen`）：判定从 `node.path.toLowerCase().endsWith('.md')` 改为 `node.type==='file' && isBuiltinEditable(node.path)`，命中后 `setFileEditorTarget({ path, fileName, subtitle, format: getFileFormat(node.path) ?? 'md' })`。三处 page 复用同一 SectionWorkspacePanel（chat-page / academy section-version-chat / studio section-right-tabs）→ 改一处全覆盖。

### ⑤ i18n（change_plan 模块 F）

`academy.json`（中英）加 `fileEditor.*` 6 key：`format` / `validate` / `formatFail` / `validateOk`（✓ 格式正确）/ `validateFailLine`（第 {{line}} 行: {{msg}}）/ `validateFail`。保留既有 `mdEditor.*` 不动（modal `useTranslation('academy')` 不变）。

## change_plan ↔ code 偏离（4 处，本文档同步对齐）

| 项 | change_plan 原写 | 代码实际 | 对齐理由 |
|----|------------------|---------|---------|
| 模块 B `validateXml` | `XMLParser.parse` 做校验 | `XMLValidator.validate()`（返 `{err:{msg,line,col}}`） | XMLParser 宽容解析（`<unclosed>` 当自闭合）无法识别未闭合/错配标签 → 校验失效；XMLValidator 同库专为 well-formedness 校验设计。formatXml 仍用 XMLParser（宽容以尽量产出） |
| 模块 E modal import | `from '../../lib/file-format/'`（尾斜杠） | `from '../../lib/file-format/index'`（显式 /index） | bun+vitest 运行时尾斜杠解析失败（tsc 过但运行时 `formatText is not a function`） |
| 模块 F i18n | 「MUST 含全部 7 个 key」（含 `formatOk`） | 6 key（删 `formatOk` 死键） | 状态机 idle\|ok\|error 三态，format 成功走 kind:'ok' 显 `validateOk`，`formatOk` 无消费者（code-review 发现删除） |
| 模块 B `formatCsv` | 未提末列 trimEnd | 末列 `trimEnd` 去尾空白 | padEnd 列对齐后末列无对齐目标，trimEnd 防 git diff / trailing whitespace 噪音（不改字段数） |

详见 `change_plan.md` §3 spec↔code 偏离备忘表（4 行新加，均标 ✅ 已对齐本文档同步）。

## 代码↔spec 一致核查（doc-modifier 阶段 5）

- `component-modal-md-editor.md`：Props.format ✓ / view 分流（md→PrimitiveMarkdownView / 其余→`<pre>`）✓ / 格式按钮（edit+structured 显，visibility:hidden 占位）✓ / hint 状态机（saveError>error>ok>默认）✓ / i18n key 数（spec 未写「7 key」，提及的 validateFailLine/validateFail/validateOk 均与代码一致，无 formatOk）✓
- `component-workspace-panel.md §4.4`：拦截分支（isBuiltinEditable 守门 12 格式 + md / 其余系统打开）✓ + 挂载层改名 `component-ws-file-editor.tsx` ✓ + `WsFileTarget` 加 format 字段 ✓
- `04-agent-session.md §2.6.7`：契约字段（path/content/ok）零改 ✓；注释扩「[v0.0.241] 起前端拦截 11 格式 + md 均走此端点（前端 `isBuiltinEditable` 守门），后端不限扩展名」+ GET 行语义改「内置 file editor」

## 测试范围（UT 为主 — AT/ET 豁免）

UI-only 改动（无 API 契约变更、无 LLM 参与、无落库逻辑变更）→ 对齐 memory `ui-only-ut-skip-at-et`：UT 覆盖即可，AT/ET 豁免。

- UT 重点：`file-format.ts` 分类闭合性（12 格式 + .env.* + 大小写 + unsupported）+ 每种结构化格式 format/validate 成功 + validate 失败带位置（UC-241-JSON/YAML/CSV/JSONL）+ modal（format='md' 回归 / format='json' view 走 `<pre>` + edit 显格式按钮 / format='txt' 无格式按钮 / handleFormat 失败不动 draft / 校验失败仍可保存）+ handleOpen 拦截分支（11 格式命中 + .py/.png unsupported 走 openWorkspaceItem）
- AT 豁免：后端零改 + 纯前端确定性逻辑，不进 AT 持久库
- ET 按需：可顺跑既有 v0.0.227 workspace 冒烟集回归（点 .md 链路不破），不新增 ET case

## 零变更（OUT OF SCOPE）

- 后端 `session-workspace-file.ts` read/save handler（UTF-8 + 路径白名单，通用不限扩展名）
- `POST /workspace/open`（其它扩展名仍走系统应用打开，回归保护）
- `chat-api/workspace-api.ts`（readWorkspaceFile/saveWorkspaceFile 签名零改）
- 命名泛化（modal `md-editor` → `file-editor` + `mdEditor.*` → `fileEditor.*` i18n）留 follow-up（守 academy 向后兼容 + 既有 UT）
