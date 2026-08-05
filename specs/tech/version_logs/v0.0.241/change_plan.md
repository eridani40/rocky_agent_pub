# v0.0.241 变更计划书 — 内置文件 viewer/editor 扩多格式 + 格式化

> 架构期冻结的 method 级契约。行 = 函数/符号。8 列：模块/文件/函数·符号/类型/变更内容/约束/参考/影响行。
> coder 参考 + 决策权 + 偏离汇报（详见 CLAUDE.md「coder 与 change_plan 关系」）。核心约束不可擅自偏离。

## 0. 决策摘要（架构裁决，coder 必须遵守）

### 0.1 组件结构：扩展 + 局部改名（不新造组件）

- **`component-modal-md-editor.tsx` 保留文件名不改**（向后兼容 academy 引用 + i18n `mdEditor.*` key + 既有 UT），**扩展 Props 加 `format?: FileFormat`**（缺省 `'md'`，academy 调用不传 → 行为不变）。spec 标注「文件名 v0.0.227 历史，v0.0.241 扩展为通用 file editor，命名泛化留 follow-up」。
- **workspace 挂载层改名**：`component-ws-md-editor.tsx` → `component-ws-file-editor.tsx`，`ComponentWsMdEditor` → `ComponentWsFileEditor`，`WsMdTarget` → `WsFileTarget`（加 `format` 字段）。仅 `section-workspace-panel.tsx` 一处 import 牵连。
- **理由（对齐用户偏好 `user-prefers-simple-direct-refactor` + 原则#1 简单&架构水准）**：modal 已是 common 共享（academy + workspace 双消费），扩展 Props 即可分流；academy 用法（md + readOnly + versionLabel hint）完全不变；ws 挂载层是 workspace 专属、仅 chat-page 一处 import → 改名牵连最小，命名反映「文件 editor」真实职责。

### 0.2 库选型（新增依赖进 `app/web/package.json`）

| 格式 | 选型 | 进哪个 package.json | 理由 |
|------|------|--------------------|------|
| JSON / JSONL | 原生 `JSON.parse/stringify(_, null, 2)` | 不装库 | V8 默认不转义非 ASCII（中文保留）；零依赖 |
| YAML | `yaml` ^2.9.0（**已装**） | — | parse/dump，block 风格序列化 |
| XML | **新增 `fast-xml-parser` ^4.x** | `app/web/package.json` | 纯 JS、轻量、packaged 友好、活跃维护 |
| TOML | **新增 `smol-toml` ^1.x** | `app/web/package.json` | ~25KB、TS 友好、TOML 1.0、活跃（优于 @iarna/toml 维护放缓） |
| CSV / TSV | 手写（split + 列对齐 + 行列校验） | 不装库 | 逻辑简单不值得装库 |

**packaged 护栏自检**（CLAUDE.md `packaged-spawn-external-binary-exec-path` / 依赖归属#1）：`fast-xml-parser` + `smol-toml` 是前端纯 JS 库，仅 `app/web` 运行时使用；packaged 后端（`app/server`/`app/protocols`/`app/shared`）不会引用 → 无 asar 风险。但**必须**声明在 `app/web/package.json`（不能只在根 package.json）—— electron-builder 只打包各 workspace 自身声明的 deps，根 hoist 侥幸能跑 dev 但 packaged 后会崩 `Cannot find module`。

### 0.3 格式分类常量位置：`app/web/src/lib/file-format.ts`

新建单文件常量库（不进 lib/chat-api，纯前端 UI 侧分类逻辑，与 chat-api 后端契约分离）。

### 0.4 format/validate 纯函数位置：`app/web/src/lib/file-format/`

每种结构化格式一文件（json/jsonl/yaml/xml/toml/csv/tsv），`index.ts` 是 dispatcher 按 format 路由。统一 `FormatResult` 返回形：`{ ok: true; output: string } | { ok: false; error: string; line?: number; col?: number }`。

### 0.5 拦截点：`section-workspace-panel.tsx:174` 改判定

从 `node.path.toLowerCase().endsWith('.md')` 改为 `isBuiltinEditable(node.path)`（查格式分类常量），命中后 `setFileEditorTarget` 附带 `format`。**3 处 page 复用同一 SectionWorkspacePanel**（chat-page / academy section-version-chat / studio section-right-tabs，见 workspace-panel.md §4.4）→ 改一处全覆盖。

---

## 1. 变更行（method 级契约）

### 模块 A：格式分类常量（新文件 `app/web/src/lib/file-format.ts`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| file-format | app/web/src/lib/file-format.ts | `FileFormat` | 新增 | type union：`'md' \| 'json' \| 'jsonl' \| 'yaml' \| 'xml' \| 'toml' \| 'csv' \| 'tsv' \| 'txt' \| 'ini' \| 'env' \| 'log'`（12 形态 = 11 新 + md） | MUST 含 md（向后兼容）；不含 unsupported（unsupported = `getFileFormat` 返 null） | PRD §2.1 | +3 |
| file-format | app/web/src/lib/file-format.ts | `FileFormatCategory` | 新增 | type union：`'md' \| 'structured' \| 'plain'`（structured=7 格式有 format/validate；plain=4 格式仅查看；md 走原链路） | MUST 与 PRD §2.1 分类一致 | PRD §2.1 | +1 |
| file-format | app/web/src/lib/file-format.ts | `FormatResult` | 新增 | union type：`{ ok: true; output: string } \| { ok: false; error: string; line?: number; col?: number }` | 失败时 line/col 可选（CSV 行号 / JSONL 行号必有；JSON/YAML 等尽力提取） | PRD §3.1 | +3 |
| file-format | app/web/src/lib/file-format.ts | `EXT_TO_FORMAT` | 新增 | `Record<string, FileFormat>` 扩展名 → format 映射表；键全部小写（`'.json'`/`'.yaml'`/`'.yml'`/`'.xml'`/`'.toml'`/`'.csv'`/`'.tsv'`/`'.jsonl'`/`'.txt'`/`'.ini'`/`'.log'`/`'.md'`） | MUST NOT 含编程语言后缀（.py/.js/.java 等，PRD §6）；`.env` 单独处理（见 `getFileFormat`） | PRD §2.1 | +15 |
| file-format | app/web/src/lib/file-format.ts | `getFileFormat(path)` | 新增 | 入参相对 workspaceDir 路径，返 `FileFormat \| null`。算法：① `path.toLowerCase()`；② basename 取 ` getLast(path)`；③ 若 basename === '.env' 或以 '.env.' 开头（如 `.env.local`） → 返 `'env'`；④ 否则查 `EXT_TO_FORMAT[ext]`（ext = basename 中最后一个 `.` 起的子串，含 `.`）；⑤ 未命中返 null（unsupported） | MUST 大小写不区分（PRD §2.1）；`.env.*` 当 env 处理；`getExt` 用 lastIndexOf('.') 防多扩展名误判（`.user.config.json` → `.json`） | PRD §2.1 + memory `spec-writing-hygiene` | +18 |
| file-format | app/web/src/lib/file-format.ts | `getCategory(format)` | 新增 | 入参 `FileFormat`，返 `FileFormatCategory`：`'md'`→`'md'`；`'json'/'jsonl'/'yaml'/'xml'/'toml'/'csv'/'tsv'`→`'structured'`；`'txt'/'ini'/'env'/'log'`→`'plain'` | MUST 闭合（switch 全 12 彀 case，default 返 `'plain'` 兜底）；MUST NOT 漏 'md' 分支 | PRD §2.1 | +10 |
| file-format | app/web/src/lib/file-format.ts | `isBuiltinEditable(path)` | 新增 | 便利函数：`getFileFormat(path) !== null`（命中 11 格式或 md → 走内置 editor；null → 走系统打开） | MUST NOT 与 `getFileFormat` 重复实现判定（直接调用） | workspace-panel §4.4 | +3 |

### 模块 B：format/validate 纯函数（新文件 `app/web/src/lib/file-format/*.ts`）

> 统一约定：所有 `format*`/`validate*` 是**纯函数**（无副作用、无 IO、入参 text 出参 FormatResult）。失败时尽量带 line/col 反馈给 hint 区。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| file-format | app/web/src/lib/file-format/json.ts | `formatJson(text)` | 新增 | 原生 `JSON.parse(text)` → `JSON.stringify(obj, null, 2)`（2 空格缩进）。成功返 `{ok:true, output}`；失败 catch 解析错误（V8 SyntaxError message 含 `at position N`）→ 算行号 line | MUST 用原生（不装库）；MUST NOT 用 replacer 反转义（V8 默认保留中文，PRD §3.2 备注）；MUST 在 catch 里从 message 正则提取 position → 算 line/col | PRD §3.2 JSON 行 | +18 |
| file-format | app/web/src/lib/file-format/json.ts | `validateJson(text)` | 新增 | 原生 `JSON.parse(text)`，成功 `{ok:true, output:text}`（output 不变，仅校验）；失败同 `formatJson` 的错误提取逻辑（复用内部 helper） | MUST NOT 修改文本（仅校验）；line/col 提取与 formatJson 复用同一 helper | PRD §3.2 | +12 |
| file-format | app/web/src/lib/file-format/jsonl.ts | `formatJsonl(text)` | 新增 | 按 `\n` split 行（保留空行），逐行 `JSON.parse` → `JSON.stringify(_, null, 2)` → 多行对象内嵌换行需 flatten 或保留缩进？**决策**：每行 pretty 后内部换行不破坏「一行一对象」语义 → 改用 `JSON.stringify(obj)` 单行紧凑 + 数组项缩进可选。**最终**：每行 `JSON.stringify(obj)`（紧凑）+ 全局 `\n` 拼接。失败报 `{ok:false, error, line: i+1}` | MUST 空行跳过（不报错，允许文件末尾空行）；MUST 失败时 line = 1-indexed | PRD §3.2 JSONL 行；UC-241-JSONL-LINE | +16 |
| file-format | app/web/src/lib/file-format/jsonl.ts | `validateJsonl(text)` | 新增 | 同 formatJsonl 的逐行 parse 逻辑，但不重写输出（`{ok:true, output:text}`） | MUST 复用 formatJsonl 的行解析 helper（DRY） | PRD §3.2 | +8 |
| file-format | app/web/src/lib/file-format/yaml.ts | `formatYaml(text)` | 新增 | `YAML.parse(text)` → `YAML.stringify(obj, { indent: 2, lineWidth: 0 })`（block 风格，避免 flow 折叠）。成功返 `{ok:true, output}`；失败 catch `YAMLParseError`（带 `linePos:[line,col]`） | MUST 用已装 `yaml` ^2.9.0；lineWidth=0 防止长字符串 flow 折叠；line/col 从 `err.linePos` 提取 | PRD §3.2 YAML 行 | +14 |
| file-format | app/web/src/lib/file-format/yaml.ts | `validateYaml(text)` | 新增 | `YAML.parse(text)`，成功 `{ok:true, output:text}`；失败同 formatYaml 错误提取 | MUST 复用 formatYaml 错误提取 | PRD §3.2 | +6 |
| file-format | app/web/src/lib/file-format/xml.ts | `formatXml(text)` | 新增 | `new XMLParser({ignoreAttributes:false}).parse(text)` → `new XMLBuilder({format:true, indentBy:'  ', ignoreAttributes:false}).build(obj)`。成功 `{ok:true, output}`；失败 catch 报错（fast-xml-parser 错误 message 含行信息） | MUST 用 `fast-xml-parser` ^4.x（**新增依赖**）；ignoreAttributes:false 保留属性节点 | PRD §3.2 XML 行 | +16 |
| file-format | app/web/src/lib/file-format/xml.ts | `validateXml(text)` | 新增 | `XMLValidator.validate(text, { allowBooleanAttributes: false })`，成功（返 `true`）`{ok:true, output:text}`；失败（返 `{err:{msg,line,col}}`）取 err.msg + line + col。**偏离原计划**：计划用 `XMLParser.parse` 做校验，实际改用 `XMLValidator.validate()` | **偏离已对齐（本文档同步）**：XMLParser 是「宽容」解析（`<unclosed>` 当自闭合），无法识别未闭合/错配标签 → 校验失去意义；XMLValidator 同库专为 well-formedness 校验设计，返结构化 `{err:{line,col}}` 更符合「校验」预期。formatXml 仍用 XMLParser（宽容以尽量产出，校验失败也能格式化）。`fast-xml-parser` 同时 export 三者 | PRD §3.2 | +16 |
| file-format | app/web/src/lib/file-format/toml.ts | `formatToml(text)` | 新增 | `TOML.parse(text)` → `TOML.stringify(obj)`。成功 `{ok:true, output}`；失败 catch `TomlError`（带 line/col） | MUST 用 `smol-toml` ^1.x（**新增依赖**，import 名 `* as TOML`）；line/col 从 err 提取 | PRD §3.2 TOML 行 | +12 |
| file-format | app/web/src/lib/file-format/toml.ts | `validateToml(text)` | 新增 | `TOML.parse(text)`，成功 `{ok:true, output:text}`；失败同 formatToml 错误提取 | MUST 复用 formatToml | PRD §3.2 | +5 |
| file-format | app/web/src/lib/file-format/csv.ts | `parseCsvRows(text, delim)` | 新增 | 内部 helper：按 `\n` split 行 + 手写 CSV 字段解析（支持 `"..."` 引号包裹 + `""` 转义 + `,` 分隔）；返 `string[][]` | MUST 支持 RFC 4180 引号转义；MUST NOT 用第三方 csv 库 | PRD §3.2 CSV 行 | +24 |
| file-format | app/web/src/lib/file-format/csv.ts | `formatCsv(text)` | 新增 | `parseCsvRows(text, ',')` → 计算每列 maxWidth → 每字段右 pad 到 maxWidth+1 → 重新 join。成功 `{ok:true, output}` | MUST 列对齐（PRD §3.2 CSV「列对齐 pretty」）；MUST NOT 改变字段数（仅空格填充）；末列右侧无对齐目标，**trimEnd 去掉 pad 引入的尾部空白**（防 git diff / trailing whitespace 噪音，不改字段数） | PRD §3.2 CSV；UC-241-CSV-FMT | +14 |
| file-format | app/web/src/lib/file-format/csv.ts | `validateCsv(text)` | 新增 | `parseCsvRows(text, ',')` → 取首行字段数 K → 逐行对比，不一致返 `{ok:false, error:'第 N 行字段数为 M，与首行 K 不符', line: N}`；全一致 `{ok:true, output:text}` | MUST line = 1-indexed；MUST 报首行字段数对比 | PRD §3.2 CSV；UC-241-CSV-FMT | +12 |
| file-format | app/web/src/lib/file-format/tsv.ts | `formatTsv(text)` | 新增 | 复用 csv.ts 的 `parseCsvRows(text, '\t')` + 列对齐逻辑（分隔符 `\t`）；或独立实现按 `\t` split | MUST 复用 csv.ts helper（DRY，避免重复列对齐算法） | PRD §3.2 TSV 行 | +8 |
| file-format | app/web/src/lib/file-format/tsv.ts | `validateTsv(text)` | 新增 | 复用 csv.ts 的行列校验逻辑（分隔符 `\t`） | MUST 复用 csv.ts helper | PRD §3.2 | +6 |
| file-format | app/web/src/lib/file-format/index.ts | `formatText(format, text)` | 新增 | dispatcher：按 format 路由到 `formatJson/formatJsonl/formatYaml/formatXml/formatToml/formatCsv/formatTsv`；`md/plain` 形态返 `{ok:false, error:'该格式不支持格式化'}`（不应被调用，调用方按 category 守门） | MUST 闭合 switch；default 返 unsupported 错误 | PRD §3.1 | +14 |
| file-format | app/web/src/lib/file-format/index.ts | `validateText(format, text)` | 新增 | dispatcher：同 formatText 路由到 `validate*`；`md/plain` 返 unsupported | MUST 与 formatText 路由对齐 | PRD §3.1 | +12 |

### 模块 C：拦截点扩展（`app/web/src/components/chat-page/section-workspace-panel.tsx`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-workspace | app/web/src/components/chat-page/section-workspace-panel.tsx | import statement（file-format + 改名挂载层） | 修改 | 新增 `import { getFileFormat, isBuiltinEditable } from '../../lib/file-format'`；改名 import：`ComponentWsMdEditor, type WsMdTarget` → `ComponentWsFileEditor, type WsFileTarget`（from `'./component-ws-file-editor'`） | MUST 同步改名引用（grep 全替换，memory `rename-refs-batch-sed-verify`） | workspace-panel.md §4.4 | +2/-2 |
| ui-workspace | app/web/src/components/chat-page/section-workspace-panel.tsx | `mdEditorTarget` state | 修改 | 改名 `fileEditorTarget`；type `WsMdTarget \| null` → `WsFileTarget \| null`（含 format 字段） | MUST 同步 setFileEditorTarget 调用点改名 | workspace-panel.md §4.4 | +1/-1 |
| ui-workspace | app/web/src/components/chat-page/section-workspace-panel.tsx | `handleOpen(node)` | 修改 | 拦截判定从 `node.path.toLowerCase().endsWith('.md')` 改为 `node.type==='file' && isBuiltinEditable(node.path)`；命中后 `setFileEditorTarget({ path, fileName: node.name, subtitle: node.path, format: getFileFormat(node.path) ?? 'md' })`；未命中走 `openWorkspaceItem`（行为不变） | MUST 用 `isBuiltinEditable` 守门（不再硬编码 `.md`，PRD §5 决策5）；MUST 附带 format（缺省 'md' 兜底，但 isBuiltinEditable 命中时 format 必非 null） | workspace-panel.md §4.4；PRD §5 | +4/-2 |
| ui-workspace | app/web/src/components/chat-page/section-workspace-panel.tsx | JSX `<ComponentWsMdEditor .../>` | 修改 | 标签改名 `<ComponentWsFileEditor .../>`；target prop 名同步（`target={fileEditorTarget}`） | MUST 同步改名 | workspace-panel.md §4.4 | +1/-1 |

### 模块 D：ws 挂载层泛化 + 改名（`component-ws-md-editor.tsx` → `component-ws-file-editor.tsx`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-workspace | app/web/src/components/chat-page/component-ws-file-editor.tsx | 文件改名 | 新增 | `component-ws-md-editor.tsx` → `component-ws-file-editor.tsx`（旧文件 git mv，**禁止保留旧文件**，memory `delete-old-code-fully-when-replacing`） | MUST git mv（保留 history）；MUST NOT 留旧文件僵尸 | workspace-panel.md §4.4 | rename |
| ui-workspace | app/web/src/components/chat-page/component-ws-file-editor.tsx | `WsFileTarget` interface | 修改 | `WsMdTarget` → `WsFileTarget`；新增 `format: FileFormat` 字段（必填，调用方在 handleOpen 已传） | MUST 加 format 字段（modal Props 需要）；MUST NOT 改 path/fileName/subtitle 三字段 | modal-md-editor.md Props | +2/-1 |
| ui-workspace | app/web/src/components/chat-page/component-ws-file-editor.tsx | `ComponentWsFileEditor` | 修改 | `ComponentWsMdEditor` → `ComponentWsFileEditor`；向 `<ComponentModalMdEditor>` 透传 `format={target.format}`；其余（readWorkspaceFile/saveWorkspaceFile/toast）完全不变 | MUST 透传 format；MUST NOT 改读/存逻辑（后端零改）；modal 标签名保持 `ComponentModalMdEditor`（modal 不改名） | workspace-panel.md §4.4；PRD §6（后端零改） | +3/-1 |
| ui-workspace | app/web/src/components/chat-page/component-ws-file-editor.tsx | default export | 修改 | `export default ComponentWsMdEditor` → `export default ComponentWsFileEditor` | MUST 同步改名 | — | +1/-1 |
| ui-workspace | app/web/src/components/chat-page/component-ws-md-editor.tsx | 旧文件 | 删除 | git mv 后旧路径不存在 | MUST 确认 grep 无残留引用（`grep -r 'ws-md-editor\|WsMdTarget\|ComponentWsMdEditor'`） | memory `rename-refs-batch-sed-verify` | -123 |

### 模块 E：modal editor 扩展（`app/web/src/components/common/component-modal-md-editor.tsx`）

> **modal 文件名不改**（向后兼容 academy + i18n + UT），仅扩展 Props + 内部分流。academy 调用（不传 format）→ 缺省 'md' → 行为完全不变。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-common | app/web/src/components/common/component-modal-md-editor.tsx | import（file-format + format/validate） | 修改 | 新增 `import type { FileFormat, FileFormatCategory } from '../../lib/file-format'`；`import { getCategory } from '../../lib/file-format'`；`import { formatText, validateText } from '../../lib/file-format/index'`（**显式 /index**） | **偏离已对齐（本文档同步）**：原计划写尾斜杠 `'../../lib/file-format/'`（TS module resolution 风格），bun + vitest 运行时尾斜杠解析失败（tsc 过但运行时 `formatText is not a function`）；改显式 `/index` 后 dev+test+packaged 均通过。type 用 type-only import 防 packaged 值导入（同 workspace 不强制，但 type-only 更稳） | — | +3 |
| ui-common | app/web/src/components/common/component-modal-md-editor.tsx | `Props.format` | 修改 | 新增可选字段 `format?: FileFormat`（缺省 `'md'`）；JSDoc 标注「v0.0.241 新增：决定 view 分流 + edit 模式是否显示格式按钮；缺省 'md' 向后兼容 academy」 | MUST 可选（缺省 'md'）；academy 调用不传 | modal-md-editor.md Props | +2 |
| ui-common | app/web/src/components/common/component-modal-md-editor.tsx | `category` 派生常量 | 新增 | 函数顶部 `const fmt = format ?? 'md'`；`const category = getCategory(fmt)`（md/structured/plain）；后续 view 分流 + 按钮显隐都用 category | MUST 一次性派生（避免多次调用 getCategory） | PRD §2.1 | +2 |
| ui-common | app/web/src/components/common/component-modal-md-editor.tsx | md-body view 分流 | 修改 | view 模式渲染分支：`category === 'md'` → 现有 `<PrimitiveMarkdownView source={draft} />`（不动）；其余（structured+plain）→ `<pre className="px-[22px] py-[18px] font-mono text-[13px] leading-[1.7] text-fg whitespace-pre-wrap break-words">{draft}</pre>` | MUST md 走 PrimitiveMarkdownView（不动）；其余走 `<pre>`（PRD §2.2，朴素无高亮/行号/折叠） | PRD §2.2 | +5/-1 |
| ui-common | app/web/src/components/common/component-modal-md-editor.tsx | `validateResult` state | 新增 | `useState<{kind:'idle'} \| {kind:'ok'} \| {kind:'error'; msg: string}>({kind:'idle'})`；open 变化重置回 idle（与 setDraft/setMode 同 effect） | MUST open 切换时重置（避免上次校验结果残留） | PRD §3.1 | +3 |
| ui-common | app/web/src/components/common/component-modal-md-editor.tsx | `handleFormat()` | 新增 | 取 draft → `formatText(fmt, draft)` → ok 则 `setDraft(output)` + `setValidateResult({kind:'ok'})`；fail 则 `setValidateResult({kind:'error', msg: ...})`（**不动 draft**，PRD §3.1 防洗空坏内容） | MUST NOT 在 fail 时改 draft（PRD §3.1 关键不变量「解析失败不可格式化」）；MUST 用 formatText dispatcher | PRD §3.1；UC-241-JSON-FULL | +12 |
| ui-common | app/web/src/components/common/component-modal-md-editor.tsx | `handleValidate()` | 新增 | 取 draft → `validateText(fmt, draft)` → ok `setValidateResult({kind:'ok'})`；fail `setValidateResult({kind:'error', msg: errmsg 含 line/col})` | MUST NOT 阻塞保存（PRD §3.1「不阻塞保存」）；MUST 在 msg 拼「第 N 行: ...」格式（i18n template） | PRD §3.1；UC-241-JSONL-LINE | +10 |
| ui-common | app/web/src/components/common/component-modal-md-editor.tsx | md-foot「格式化」「校验」按钮 | 修改 | edit 模式 + `category === 'structured'` → 显示「格式化」「校验」两 BTN_SECONDARY 按钮（在「关闭」左侧或保存左侧，coder 定位）；`category !== 'structured'` → 用 `visibility:hidden` 渲染同尺寸占位（保布局稳定，PRD §3.1 布局稳定性硬规则）；view 模式一律不渲染 | MUST 用 `visibility:hidden` 占位（禁 `display:none` + 条件渲染，会致相邻元素位移）；MUST 仅 edit + structured 显示 | PRD §3.1 + UC-241-PLAIN；CLAUDE.md「布局稳定性」| +14 |
| ui-common | app/web/src/components/common/component-modal-md-editor.tsx | md-foot hint 区 | 修改 | hint 文案优先级链：`saveError`（既有）→ `validateResult.kind==='error'` 显 msg → `validateResult.kind==='ok'` 显「✓ 格式正确」 → `validateResult.kind==='idle'` 显既有 hint / versionLabel 模板 | MUST 优先级正确（saveError 最高，校验错误次之，成功正向反馈再次，idle 默认）；MUST NOT 在 plain/md 格式显示校验结果（按钮都没渲染，state 不会变） | PRD §3.1 | +6/-1 |
| ui-common | app/web/src/components/common/component-modal-md-editor.tsx | open effect 重置 | 修改 | `useEffect([open, initialValue])` 内新增 `setValidateResult({kind:'idle'})`（与 setMode('view')/setDraft 同 reset） | MUST open 重开时清校验态 | PRD §3.1 | +1 |

### 模块 F：i18n key 新增（chat namespace + academy namespace，4 个文件中英文）

> 新增 `fileEditor.*` key（**保留既有 `mdEditor.*` 不动**，避免破 academy 现有引用 + 既有 UT）。modal-md-editor.tsx 内 `useTranslation('academy')` 不变；新格式按钮文案走 academy namespace `fileEditor.*` 子树（与 mdEditor.* 同 namespace，不引入跨 namespace 切换）。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| i18n | app/web/src/i18n/locales/zh-CN/academy.json | `fileEditor` object | 新增 | 新增 `fileEditor` 子树（与 `mdEditor` 同级）：`{ "format": "格式化", "validate": "校验", "formatFail": "格式错误，无法格式化", "validateOk": "✓ 格式正确", "validateFailLine": "第 {{line}} 行: {{msg}}", "validateFail": "{{msg}}" }` | **偏离已对齐（本文档同步）**：原计划写「MUST 含全部 7 个 key」（含 `formatOk`「已格式化」），实际 6 个 key（删 `formatOk`）。**理由**：hint 状态机只有 idle|ok|error 三态，format 成功走 `kind:'ok'` 显 `validateOk`（「✓ 格式正确」），`formatOk` 是死键（无消费者，code-review 发现删除）；format 失败走 `kind:'error'` 显 `formatFail`。中英 key 须一一对应（memory `i18n-key-add-checklist`） | PRD §3.1；memory `i18n-key-add-checklist` | +8 |
| i18n | app/web/src/i18n/locales/en/academy.json | `fileEditor` object | 新增 | 同上英文版：`{ "format": "Format", "validate": "Validate", "formatFail": "Format error, cannot format", "validateOk": "✓ Valid", "validateFailLine": "Line {{line}}: {{msg}}", "validateFail": "{{msg}}" }`（6 key，与 zh-CN 一一对应） | MUST 与 zh-CN key 一一对应（缺 key 渲染成【资源X不存在】，memory `i18n-key-add-checklist`） | memory `i18n-key-add-checklist` | +8 |

> **chat.json 不动**：modal-md-editor.tsx 用 academy namespace（`useTranslation('academy')`），既有 `chat.json` 的 `workspace.mdEditor.*`（loading/loadFail/saved/hint）由挂载层 `component-ws-file-editor.tsx` 用（`useTranslation('chat')`），保持不变。

### 模块 G：库依赖声明（`app/web/package.json`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| deps | app/web/package.json | `dependencies` | 修改 | 新增 `"fast-xml-parser": "^4.5.0"` + `"smol-toml": "^1.3.0"`（版本号 coder 装时取 latest 4.x / 1.x） | MUST 进 `app/web/package.json`（禁只进根 package.json，CLAUDE.md 持续可打包护栏#1）；MUST 跑 `bun install` 更新 lockfile | CLAUDE.md 持续可打包护栏#1；memory `packaged-spawn-external-binary-exec-path` | +2 |

### 模块 H：组件 spec 更新（编码前置产出 — coder 在编码前按 _conventions.md 落/更新）

> 不新建 spec 文件——modal 扩展不拆新组件，挂载层改名也不新造。仅**更新 2 个既有 spec**。coder 编码前完成（spec 先于实现）。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| spec-ui | specs/ui/components/common/component-modal-md-editor.md | Props + 职责章节 | 修改 | ① Props 表加 `format?: FileFormat` 字段（缺省 'md'，v0.0.241 新增）；② 职责段补「v0.0.241 扩展为通用 file editor（文件名保留 md-editor 历史）」；③ md-body view 分流（md → PrimitiveMarkdownView / 其余 → `<pre>`）；④ md-foot 新增「格式化」「校验」按钮（edit + structured 显示，其余 visibility:hidden）；⑤ hint 状态机（saveError > validateResult.error > validateResult.ok > 默认）；⑥ 新增「视觉基线」沿用 `demo/09-version-edit.html`（无新设计稿，PRD §8） | MUST coder 编码前置产出（先 spec 后实现，CLAUDE.md 概念先行）；MUST NOT 重命名文件（保留 component-modal-md-editor.md，命名泛化留 follow-up） | PRD §2.2/§3.1/§7；_conventions.md §9 | +35 |
| spec-ui | specs/ui/components/chat-page/component-workspace-panel.md | §4.4 拦截分支 | 修改 | ① 标题从「`.md` 拦截走内置 editor / 其余系统打开」改为「`isBuiltinEditable` 拦截走内置 file editor（11 格式 + md）/ 其余系统打开」；② 分支表更新：md 文件 / 结构化格式 / 纯文本类 → 内置 editor（附带 format）；其它扩展名 / 文件夹 → 系统打开 / 展开；③ 引用挂载层改名 `component-ws-file-editor.tsx`；④ 拦截判定改为 `isBuiltinEditable(path)`（不再 `.md` 硬编码） | MUST coder 编码前置更新（CLAUDE.md「spec↔code 一致」）；MUST 标 [v0.0.241] 版本标签 | PRD §5；workspace-panel.md §4.4 | +12/-3 |

---

## 2. 文件级变更清单（设计粒度 — 与上行 method 级 roll-up 一致）

| 文件 | 操作 | 变更内容摘要 |
|------|------|---------|
| app/web/src/lib/file-format.ts | 新增 | `FileFormat`/`FileFormatCategory`/`FormatResult` type + `EXT_TO_FORMAT` 常量 + `getFileFormat`/`getCategory`/`isBuiltinEditable` 函数（~70 行） |
| app/web/src/lib/file-format/json.ts | 新增 | `formatJson` + `validateJson`（原生 JSON.parse/stringify + position→line/col 提取） |
| app/web/src/lib/file-format/jsonl.ts | 新增 | `formatJsonl` + `validateJsonl`（逐行 parse + 行号反馈） |
| app/web/src/lib/file-format/yaml.ts | 新增 | `formatYaml` + `validateYaml`（已装 yaml ^2.9.0） |
| app/web/src/lib/file-format/xml.ts | 新增 | `formatXml` + `validateXml`（**新装 fast-xml-parser**） |
| app/web/src/lib/file-format/toml.ts | 新增 | `formatToml` + `validateToml`（**新装 smol-toml**） |
| app/web/src/lib/file-format/csv.ts | 新增 | `parseCsvRows` helper + `formatCsv` + `validateCsv`（手写 RFC 4180 引号 + 列对齐） |
| app/web/src/lib/file-format/tsv.ts | 新增 | `formatTsv` + `validateTsv`（复用 csv.ts helper，分隔符 `\t`） |
| app/web/src/lib/file-format/index.ts | 新增 | `formatText(format, text)` + `validateText(format, text)` dispatcher |
| app/web/src/lib/file-format/__tests__/file-format.test.ts | 新增 | UT：getFileFormat 分类覆盖（11 格式 + .env.* + 大小写 + unsupported）+ getCategory 闭合性 + isBuiltinEditable |
| app/web/src/lib/file-format/__tests__/{json,jsonl,yaml,xml,toml,csv,tsv}.test.ts | 新增 | UT：每种结构化格式 pretty 成功 + validate 成功 + validate 失败带位置 + UC 场景覆盖 |
| app/web/src/components/chat-page/section-workspace-panel.tsx | 修改 | import 改名（file-format + ComponentWsFileEditor）；handleOpen 拦截改 isBuiltinEditable + 附 format；state 改名 fileEditorTarget；JSX 标签改名 |
| app/web/src/components/chat-page/component-ws-md-editor.tsx | 删除（git mv → ws-file-editor） | 整文件改名（旧路径不保留） |
| app/web/src/components/chat-page/component-ws-file-editor.tsx | 新增（git mv 来源） | `ComponentWsFileEditor` + `WsFileTarget`（加 format 字段）+ 透传 format 给 modal |
| app/web/src/components/common/component-modal-md-editor.tsx | 修改 | Props 加 format；md-body view 分流；md-foot 加「格式化」「校验」按钮（visibility:hidden 占位）+ validateResult 状态机 + handleFormat/handleValidate |
| app/web/src/components/academy-page/__tests__/component-modal-md-editor.test.tsx | 修改 | 补充 UT：format='json' 时 view 走 `<pre>` / edit 显示格式按钮 / format 缺省（'md'）走 PrimitiveMarkdownView（回归保护）；既有 md 用法 UT 不动 |
| app/web/src/i18n/locales/zh-CN/academy.json | 修改 | 新增 `fileEditor.*` 6 key（中） |
| app/web/src/i18n/locales/en/academy.json | 修改 | 新增 `fileEditor.*` 6 key（英） |
| app/web/package.json | 修改 | dependencies 加 `fast-xml-parser` + `smol-toml` |
| specs/ui/components/common/component-modal-md-editor.md | 修改 | Props + 职责 + view 分流 + 格式按钮 + hint 状态机（coder 编码前置产出） |
| specs/ui/components/chat-page/component-workspace-panel.md | 修改 | §4.4 拦截分支扩展为 11 格式 + md（coder 编码前置产出） |

---

## 3. spec↔code 偏离备忘（架构期已发现，coder 按代码实际 + 汇报，doc-modifier 阶段 5 统一修）

| 项 | 当前 spec 状态 | 本版本实际 | 处理 |
|----|--------------|----------|------|
| `component-workspace-panel.md §4.4` | 标题/分支表只列 `.md` 拦截 | 扩到 11 格式 + md | coder 编码前置更新 spec（模块 H）✅ 已对齐 |
| `component-modal-md-editor.md` | 命名/契约绑定「md」 | 扩展为通用 file editor（保留文件名） | coder 编码前置更新 spec（模块 H）✅ 已对齐；命名泛化（md-editor → file-editor）留 follow-up |
| `04-agent-session.md §2.6.7` | 注释提「服务内置 md viewer/editor」 | 实际服务 11 格式（前端拦截决定） | 后端契约字段零改，仅注释/范围说明过时 → doc-modifier 阶段 5 补「11 格式前端拦截均走此端点」✅ 已对齐（本文档同步） |
| `00-app-guide.md` | workspace 操作路径只提 md | 11 格式均内置查看/编辑/格式化/校验 | doc-modifier 阶段 5 补操作路径 ✅ 已对齐（本文档同步） |
| 挂载层文件名 `component-ws-md-editor.tsx` | spec §4.4 引用此名 | 改名 `component-ws-file-editor.tsx` | coder 编码前置更新 spec 引用（模块 H）✅ 已对齐 |
| `WsMdTarget` type | spec §4.4 引用 | 改名 `WsFileTarget` + 加 format 字段 | coder 编码前置更新 spec（模块 H）✅ 已对齐 |
| **change_plan 模块 B `validateXml` 行** | 原写用 `XMLParser.parse` 做校验 | 代码用 `XMLValidator.validate()`（返 `{err:{msg,line,col}}`） | ✅ 已对齐（本文档同步）：XMLParser 宽容无法识别未闭合标签；XMLValidator 专为校验设计 |
| **change_plan 模块 E modal import 行** | 原写 `from '../../lib/file-format/'`（尾斜杠） | 代码用 `from '../../lib/file-format/index'`（显式 /index） | ✅ 已对齐（本文档同步）：bun+vitest 运行时尾斜杠解析失败（tsc 过但运行时 undefined） |
| **change_plan 模块 F i18n 行** | 原写「MUST 含全部 7 个 key」（含 `formatOk`） | 代码 6 个 key（删 `formatOk` 死键） | ✅ 已对齐（本文档同步）：状态机 idle\|ok\|error 三态，format 成功走 kind:'ok' 显 validateOk，formatOk 无消费者 |
| **change_plan 模块 B `formatCsv` 行** | 未提末列 trimEnd | 代码末列 `trimEnd` 去尾空白（padEnd 列对齐后末列无对齐目标） | ✅ 已对齐（本文档同步）：加注释说明 trimEnd 防 git diff 噪音、不改字段数 |

---

## 4. 测试范围（UT 为主 — AT/ET 豁免）

> 本版本 = **UI-only 改动**（无 API 契约变更、无 LLM 参与、无落库逻辑变更）→ 对齐 memory `ui-only-ut-skip-at-et`：纯前端无 API 契约变更，UT 覆盖即可，AT/ET 豁免。

- **UT 重点**：
  - `file-format.ts`：分类常量闭合性（11 格式 + md + unsupported + .env.* + 大小写）
  - 每种结构化格式：format 成功 + validate 成功 + validate 失败带位置（UC-241-JSON-FULL/YAML-FMT/CSV-FMT/JSONL-LINE）
  - `modal-md-editor.tsx`：format='md'（回归保护，既有 UT 不破）+ format='json'（view 走 `<pre>` + edit 显示格式按钮 + visibility:hidden 占位）+ format='txt'（无格式按钮，UC-241-PLAIN）+ handleFormat 失败不动 draft + 校验失败仍可保存（UC-241-SAVE-INVALID）
  - `handleOpen` 拦截分支：11 格式命中 + .py/.png unsupported 走 openWorkspaceItem（UC-241-REG）
- **AT 豁免**：后端零改 + 纯前端确定性逻辑，不进 AT 持久库（PRD §4 备注 + CLAUDE.md 持久化测试用例库铁律）。
- **ET 按需**：可顺跑既有 v0.0.227 workspace 冒烟集回归（点 .md 文件链路不破），不新增 ET case。

---

## 5. 单文件行数预算（CLAUDE.md ≤300 行硬规则）

- `file-format.ts` ~70 行 ✓
- `file-format/*.ts` 每个 ≤30 行（含 helper）✓
- `component-modal-md-editor.tsx` 现 165 行 + 扩展 ~45 行 = ~210 行 ✓
- `component-ws-file-editor.tsx` 现 123 行 + 改名 + 加 format 透传 ~5 行 = ~128 行 ✓
- `section-workspace-panel.tsx` 现状接近 300 行（既有 ~292 行）→ coder 注意改动后不超限，若超限需把 handleOpen 抽出 hook（独立决策，本计划不强制）

---

## 6. 版本

**v0.0.241** — 内置 viewer/editor 扩 11 格式 + md（共 12）；7 结构化加 format/validate；4 纯文本仅查看/编辑；后端零改；新装 `fast-xml-parser` + `smol-toml`（前端纯 JS 库，packaged 无 asar 风险）。详见本计划书 + `specs/prd/version_logs/v0.0.241.md`。
