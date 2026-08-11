# v0.0.328 变更计划书 — .env/.example 等纯文本文件打开支持

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD 权威：`specs/prd/version_logs/v0.0.328-text-file-open.md`

## 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| 唯一改动入口 | `getFileFormat(path)` 是全链路唯一文件类型判定——白名单扩充后 `getFileFormat !== null` → open-local-path ④ 分支自动走进预览区，零改分流链路 | `file-format.ts` L126-139 `getFileFormat`；`open-local-path.ts` L140 `if (fmt !== null) { onEditor(mk(fmt)); return; }` |
| .env 已支持 | L131 `name === '.env' \|\| name.startsWith('.env.')` → 'env'。`.env.example` 也命中（以 `.env.` 开头）→ 'env'（非 'txt'，语义正确） | `file-format.ts` L131-133 |
| 无扩展名文件现状 | `dot < 0 → return null`（L136）。Dockerfile/Makefile/LICENSE 等无扩展名 → null → 系统打开 | `file-format.ts` L135-136 |
| 点文件现状 | `.gitignore` 等 → `dot = lastIndexOf('.')` 找到点 → ext='.gitignore' → 查表未命中 → null | `file-format.ts` L135-138 |
| txt 分类行为 | getCategory('txt') → 'plain' → `<pre>` 渲染 + 无格式化/校验按钮。新增文本文件归 'txt' 行为完全匹配 | `file-format.ts` L157 getCategory |
| basename() 已有 | L107 `basename(path)` 私有函数，getFileFormat 内部已用。新逻辑复用同一 name 变量 | `file-format.ts` L107-110 |
| 大小写归一化 | L127 `const lower = path.toLowerCase()` 已做。basename 集合用小写匹配 | `file-format.ts` L127 |
| 后端零改动 | 后端 GET handler `readFileSync(absPath, 'utf8')` 不做 text/binary 分流，全部由前端 getFileFormat 决定 | PRD §2.4 |

## 设计决策

### D1: getFileFormat 白名单扩充 — file-format.ts（修改）

**文件**：`app/web/src/lib/file-format.ts`（修改）

**变更分 3 部分**：

#### D1.1 新增 KNOWN_TEXT_BASENAMES Set（EXT_TO_FORMAT 之后、basename() 之前插入）

```ts
/**
 * [v0.0.328] 已知纯文本 basename 精确匹配集合（大小写不敏感，值全部小写）。
 * 覆盖项目常见无扩展名/点文件纯文本——Dockerfile/Makefile/.gitignore 等。
 * getFileFormat 在扩展名查表前先查本集合；渐进扩充（加一行即可）。
 */
const KNOWN_TEXT_BASENAMES: ReadonlySet<string> = new Set([
  'dockerfile', 'makefile',
  'license', 'changelog', 'readme',
  '.gitignore', '.gitattributes', '.editorconfig',
  '.eslintrc', '.prettierrc', '.npmignore', '.dockerignore',
]);
```

#### D1.2 新增 KNOWN_TEXT_STEMS 前缀匹配（紧随 D1.1）

```ts
/**
 * [v0.0.328] 已知纯文本 basename 词干（去扩展名后的前缀部分，大小写不敏感）。
 * 匹配规则：basename 去掉首个 '.' 后的 ext 部分，剩余 stem ∈ 本集合 → 'txt'。
 *   Dockerfile.dev → stem='dockerfile' → 命中
 *   LICENSE.txt → stem='license' → 命中（但 .txt 已被 EXT_TO_FORMAT 覆盖，不影响）
 *   README.md → stem='readme' → 命中（但 .md 已被 EXT_TO_FORMAT 覆盖为 'md'，不影响）
 * 注：本检查在扩展名查表**之前**执行，所以 LICENSE.txt/README.md 等有已知扩展名的
 *   不会被截胡为 'txt'——需调整顺序：先扩展名查表，未命中再查 stem。
 */
const KNOWN_TEXT_STEMS: ReadonlySet<string> = new Set([
  'dockerfile', 'license', 'readme', 'changelog',
]);
```

> **顺序关键**：KNOWN_TEXT_STEMS 必须在扩展名查表**之后**（未命中时 fallback），否则 LICENSE.txt 会被截胡为 'txt'（应为 '.txt' → 'txt'，行为一致但路径不同，为保持一致性仍放后面）。

#### D1.3 getFileFormat 函数体扩充（L126-139 替换）

```ts
export function getFileFormat(path: string): FileFormat | null {
  const lower = path.toLowerCase();
  const name = basename(lower);

  // .env / .env.local / .env.production 等 → env（既有，不变）
  if (name === '.env' || name.startsWith('.env.')) {
    return 'env';
  }

  // [v0.0.328] 已知纯文本 basename 精确匹配（Dockerfile / Makefile / .gitignore / ...）
  if (KNOWN_TEXT_BASENAMES.has(name)) {
    return 'txt';
  }

  // 扩展名查表（既有逻辑，EXT_TO_FORMAT 追加了 .example 等）
  const dot = name.lastIndexOf('.');
  if (dot >= 0) {
    const ext = name.slice(dot);
    const fmt = EXT_TO_FORMAT[ext];
    if (fmt) return fmt;
  }

  // [v0.0.328] 已知纯文本词干前缀匹配（Dockerfile.dev → stem='dockerfile' → 命中）
  //   仅在扩展名查表未命中时 fallback——LICENSE.txt 等已被 .txt 命中不走这里
  if (dot >= 0) {
    const stem = name.slice(0, dot);
    if (KNOWN_TEXT_STEMS.has(stem)) return 'txt';
  }

  return null; // 无扩展名且未命中白名单 / 扩展名未命中 → unsupported
}
```

> 逻辑流：① .env 前缀特判 → ② KNOWN_TEXT_BASENAMES 精确匹配 → ③ 扩展名查表（含新增 .example/.sample/.lock/.diff/.patch）→ ④ KNOWN_TEXT_STEMS 词干匹配（Dockerfile.dev）→ ⑤ null。

#### D1.4 EXT_TO_FORMAT 追加扩展名（L50-101 对象内追加）

在 `.htm: 'code'` 之后追加：
```ts
  // ── [v0.0.328] 纯文本附加扩展名 ──
  '.example': 'txt',
  '.sample': 'txt',
  '.lock': 'txt',
  '.diff': 'txt',
  '.patch': 'txt',
```

#### D1.5 JSDoc 更新（L112-125 getFileFormat JSDoc）

算法描述追加第 3、6 步：
```
 *   3. basename === '.env' 或以 '.env.' 开头 → 'env'
 *   3.5 [v0.0.328] basename ∈ KNOWN_TEXT_BASENAMES → 'txt'
 *   4. 取最后一个 `.` 起的子串作为扩展名查表（含 .example/.sample/.lock/.diff/.patch）
 *   5. [v0.0.328] 扩展名未命中时，词干（去扩展名）∈ KNOWN_TEXT_STEMS → 'txt'
 *   6. 未命中返 null（unsupported，走系统打开）
```

**约束**：
- MUST KNOWN_TEXT_BASENAMES 精确匹配（不前缀匹配，防误判）
- MUST KNOWN_TEXT_STEMS 在扩展名查表之后（防 LICENSE.txt 截胡）
- MUST .env 前缀逻辑保持第一优先级不变
- MUST EXT_TO_FORMAT 追加 .example/.sample/.lock/.diff/.patch → 'txt'
- MUST NOT 改 getCategory（'txt' → 'plain' 既有不变）
- MUST NOT 加无限制 fallback（null 不全转 txt，防二进制误进）
- MUST NOT 改 open-local-path.ts（白名单扩充后自动生效）

## 文件级变更清单

| # | 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计影响行 |
|---|---------|---------|----------|------|---------|------|------|-----------|
| 1 | file-format | `app/web/src/lib/file-format.ts` | `KNOWN_TEXT_BASENAMES` | 新增 | 12 个已知纯文本 basename Set | MUST 小写精确匹配 | D1.1 | +8 |
| 2 | file-format | 同上 | `KNOWN_TEXT_STEMS` | 新增 | 4 个词干 Set（dockerfile/license/readme/changelog） | MUST 在查表后 fallback | D1.2 | +6 |
| 3 | file-format | 同上 | `EXT_TO_FORMAT` | 修改 | 追加 .example/.sample/.lock/.diff/.patch → 'txt' | MUST | D1.4 | +5 |
| 4 | file-format | 同上 | `getFileFormat` | 修改 | 加 KNOWN_TEXT_BASENAMES 精确匹配 + KNOWN_TEXT_STEMS 词干 fallback | MUST .env 第一优先；MUST stem 在查表后 | D1.3 | +12/-2 |
| 5 | file-format | 同上 | getFileFormat JSDoc | 修改 | 算法步骤更新（3.5/5/6） | MUST | D1.5 | ~3 |
| 6 | test | `app/web/src/lib/__tests__/file-format.test.ts` | 新 case | 新增 | Dockerfile/Makefile/.gitignore/.eslintrc/config.example/yarn.lock/Dockerfile.dev/.exe → 断言 | MUST 覆盖全部新增 + 回归 | — | ~+25 |

## 范式归属（逐控件）

| 控件/操作 | 范式 | 理由 |
|-----------|------|------|
| 新增文本文件预览/编辑 | **即时操作 + dirty 守卫**（既有） | 'txt' → plain → pre 渲染 + 既有 edit 流程，无新增范式 |

**结论**：不引入新范式，纯白名单数据扩充。

## 影响面评估

- **跨模块**：1 核心文件（file-format.ts）+ 测试 —— 极小
- **破坏性变更**：无——`getFileFormat` 返回值从 null → 'txt' 对新白名单文件是**行为增强**（从系统打开 → 预览区），对既有文件零影响（查表命中路径不变）
- **零后端 / 零 IPC / 零组件改动 / 零分流链路改动**
- **依赖顺序**：单文件改动无依赖
- **UT 覆盖面**：
  - `file-format.test.ts`（改）—— 新增 case：Dockerfile/Makefile/.gitignore/.eslintrc/.prettierrc/.editorconfig/.npmignore/.dockerignore → 'txt'；config.example/yarn.lock/.diff/.patch → 'txt'；Dockerfile.dev → 'txt'；.env/.env.local → 'env'（回归）；.exe/.zip/.so → null（不误判）
- **ET 建议**：可选——点 .gitignore/Dockerfile → 预览区打开（集成验证 getFileFormat → open-local-path → preview 链路）
