---
type: spec
title: File Op Tools（read/write/edit/glob/grep）
priority: P0
status: active
updated: 2026-08-13
since: v0.0.8
---

# File Op Tools（read / write / edit / glob / grep）

文件操作工具：`read` / `write` / `edit` / `glob` / `grep`。协议参考 Claude Code（Read/Write/Edit/Glob/Grep）。由 tool_execution_engine 调度。
类型（ToolDefinition/Tool）见 `index.md §1`；跨工具共性约定（绝对路径 / read 前置 / 行号剥离 / .gitignore / 专用工具优先）见 `index.md §④`。

## 1. 概述

文件操作是 agent 读写工作区的基础能力。5 个工具，参数名 camelCase（Claude Code 原型 `file_path`→`filePath` 等）。

## 2. read

读文件（文本 / 图片 / PDF / notebook）。

```typescript
interface ReadInput {
  filePath: string;     // 必填，绝对路径
  offset?: number;      // 起始行（从 1）
  limit?: number;       // 行数上限（默认 2000）
  pages?: string;       // PDF 页范围（"1-5" / "3" / "1-5,8,11-13"）；PDF>10 页必填，单次≤20
}
```

**行为**：
- 文本：`cat -n` 格式（行号 + tab + 内容），行号从 1
- 图片（PNG/JPG）：多模态视觉呈现
- PDF：按 pages，文本 + 视觉
- notebook（.ipynb）：cell + outputs
- 空文件：返回提示而非内容
- 默认上限 2000 行，大文件 offset + limit 分页

**错误**：路径不存在 / 目录（read 不能列目录）/ PDF>10 页未给 pages / **offset 越界**（`startIdx ≥ lines.length` → `invalid_input`，isError=true，文案 `offset N out of range (file has M lines): <path>`，M = 内容行数 = `lines.length − (raw.endsWith('\n') ? 1 : 0)`，防 slice 返 `[]` 致空 text block 撞 LLM 400）；`.gitignore` 内文件仍可读。

## 3. write

新建文件 / 全量重写。

```typescript
interface WriteInput {
  filePath: string;   // 必填，绝对路径
  content: string;    // 必填，完整内容（非 diff）
}
```

**行为**：
- 覆盖语义：已存在则**整体覆盖**（非追加/合并）
- **覆盖前必须先 read**（防盲改），否则失败；新建文件无此约束
- 优先 edit 改已存在文件；write 仅新建 / 全量重写
- **新建文件父目录不存在 → 自动 `mkdir -p`（recursive）**：新建文件时若父目录链缺失自动建链（v0.0.203 语义修订——trainer subagent 白名单无 bash，无法手动 mkdir；写 `.rocky/skills/<name>/SKILL.md` 创新 skill 时必需）。`recursive` 对已存在目录是 no-op，既有调用方不受影响（main agent 不感知）

**错误**：覆盖未先 read（"File has not been read yet"）/ 父目录创建失败（权限等）。

## 4. edit

精确字符串替换。

```typescript
interface EditInput {
  filePath: string;
  oldString: string;     // 必填，精确匹配（含缩进/tab）
  newString: string;     // 必填，须与 oldString 不同
  replaceAll?: boolean;  // 默认 false
}
```

**行为**：
- **先 read 后 edit**（硬约束）：未 read 失败
- 精确匹配：oldString 逐字节一致；**剥离 read 的行号前缀**，只匹配真实内容
- 唯一性：replaceAll=false 时 oldString 须**唯一**，多处→失败
- 最小化：oldString 通常 1-3 行，够唯一即可
- replaceAll=true：替换所有出现

**错误**：未 read / oldString 未找到（"String to replace not found"）/ 多处匹配（"Found N matches"）/ oldString===newString。

## 5. glob

glob 模式查文件名。

```typescript
interface GlobInput {
  pattern: string;   // 必填，gitignore 风格（"**/*.ts"）
  path?: string;     // 搜索根（绝对路径）
}
```

**行为**：
- 返回匹配文件路径列表，按 mtime 排序（最近优先）
- glob 语法：`**/*.js` / `src/**/*.ts`
- 默认不遵循 .gitignore（底层 `--no-ignore --hidden`）
- 无匹配 → 空列表（非错误）

**错误**：非法 glob 语法。

## 6. grep

ripgrep 正则检索。

```typescript
interface GrepInput {
  pattern: string;              // 必填，正则（ripgrep 语法）
  path?: string;
  glob?: string;                // 文件名过滤（"*.js"）
  type?: string;                // 语言类型（"js" / "py"）
  outputMode?: "files_with_matches" | "content" | "count";  // 默认 files_with_matches
  ignoreCase?: boolean;         // 对应 -i
  lineNumber?: boolean;         // 对应 -n（content 模式行号）
  afterContext?: number;        // 对应 -A
  beforeContext?: number;       // 对应 -B
  context?: number;             // 对应 -C
  multiline?: boolean;          // 跨行匹配
  headLimit?: number;           // 限制结果数（控 token）
}
```

**行为**：
- 底层 ripgrep（非 grep/rg 命令）
- files_with_matches（默认）：含匹配的文件路径
- content：匹配行（+ lineNumber / 上下文）
- count：每文件匹配数
- glob / type 文件过滤；默认单行，跨行 multiline

**错误**：无匹配 → 空（非错误）；非法正则 → error。

## 7. 工具层 fs 操作标准（v0.0.345 起生效）

- **IO 调用一律 `node:fs/promises` + `await`**：read/write/edit/glob/grep 五工具的 fs 操作全部真异步（libuv 线程池），不阻塞 event loop。工具在主线程串行执行（v0.0.345 已撤 worker pool，无线程池分流）。
- **persistence 层存量 sync 路径用 fs-yield 兜底**（`acquireFsSlot`/`trackFsTime`），不在本规范强制范围——persistence 层继续现状，不迁移。
- **禁止在工具层新增 sync fs 调用**（`readFileSync`/`statSync`/`mkdirSync`/`existsSync` 等）；例外仅限子进程类执行（如 grep 的 `spawnSync('rg')`——子进程执行、非本线程 native fs、带 timeout 强杀）。
- **write/edit 落盘走 `atomicWriteAsync`**（`persistence/fs-io.ts`，tmp→fsync→rename 崩溃原子，异常清理 tmp），与 `atomicWriteSync`（persistence 层存量调用）并存。

## 8. 边界

| 零件 | 归属 |
|---|---|
| read/write/edit/glob/grep 协议（input + 行为 + 错误） | 本文 ✅ |
| 工具层 fs 操作标准（fs.promises 真异步 / 禁新增 sync fs） | 本文 §7 ✅ |
| 通用类型 + 跨工具共性约定 | `index.md` |
| 执行（调度/超时/HITL 钩子/截断） + sharedReadSet 跨工具 read 跟踪 | `tool_execution_engine.md` / `../context/` |

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
