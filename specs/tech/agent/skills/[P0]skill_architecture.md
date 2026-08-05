---
type: spec
title: Skill 子系统架构（实现架构）
priority: P0
status: active
updated: 2026-07-29
since: v0.0.21
---

# Skill 子系统架构（实现架构）

本文件 = 概念 spec 的**实现架构**：模块划分、数据流、注入点、文件级变更清单。架构必须实现三份概念 spec（`index.md` / `skill_definition.md` / `skill_tool.md`）。

---

## 1. 子系统定位与范围

实现 `index.md §①` 的「最小可用」三件套：(1) UI 管理 skill（install/enable/delete/preview）→ HTTP API + SkillRegistry；(2) skill 读工具（agent 输入 name → SKILL.md 全文 + skillDir）→ `tools/skill.ts`；(3) system prompt 注入（L0：name+description 常驻）→ `skills` mapper 填肉。

**不实现**：agent 写技能、skill 版本管理、供应链安全（见 `skill_definition.md` §8 roadmap）。

---

## 2. 模块划分

```
app/server/src/skills/
├── resolver.ts        # SkillResolver：双层扫描 + frontmatter 解析 → SkillCatalog
├── enabled-store.ts   # SkillEnabledStore：enabled 持久化（app_config skill_state）
├── installer.ts       # SkillInstaller：multipart → 解压 → 校验 → 复制到 scope
├── tree.ts            # buildFileTree(skillDir) → SkillFileNode[]（预览）
├── file-io.ts         # 单文件读写原语：越界守卫 + 二进制识别 + 256KB 截断 + 只覆写已存在文本文件
└── types.ts           # SkillCatalog / SkillEntry / SkillFileNode / SkillContent
app/server/src/handlers/skill.ts   # HTTP handler（见 api/06-skill.md）
app/server/src/tools/skill.ts      # skill 读工具（Tool 实现，仿 bash.ts）
app/plugins/builtins/rocky_context/prompt/skills.ts  # mapper 填肉
```

> `file-io.ts` = skill 单文件读写的**唯一权威实现**：`handlers/skill.ts handleFile`（`GET /skill/:name/file`）只做 skill 目录定位 + error→HTTP 映射；academy 的版本工作区 skill 文件端点（`specs/api/overall/18-academy.md §1.11`）复用同一原语，两域响应 shape 因此天然一致。越界守卫 / 二进制判定 / 截断阈值 **MUST NOT** 在别处再实现一份。

> 各模块各司其职、≤300 行；handler 编排，不持有业务状态。

---

## 3. 存储路径（四层；对齐 `[P0]skill_definition.md` §4）

| scope（底层 SkillScope） | 对外命名 | 位置 | 来源 |
|-------|------|------|------|
| builtin | —（不暴露） | 项目内 `app/plugins/builtins/*/skills/` | app 打包时进 asar |
| app 级 | `global` | `<dataDir>/skills/<name>/` | dataDir（bootstrap 注入，见 §6） |
| workspace 级 | `session`（项目级） | `<workspaceDir>/.rocky/skills/<name>/` | session.workspaceDir（v0.0.17 接线，见 §6） |
| **group 级** | —（不暴露） | `<groupWs>/.rocky/skills/<name>/`（groupWs = squad `<dataDir>/squads/<sid>/`） | session 的 squadId 经 `resolveGroupWsDir` 解析（`handlers/session-config.ts` 传入 groupDir） |

> `skill_manage`/`skill` 工具 input/output 对外用 `global`/`session`（映射在 `skill-manage.ts`/`skill.ts` 边界，`builtin`/`group` 输出回显映射为 `global`，因为工具对外只暴露两值不区分 4 层来源）；底层 `SkillScope` = 4 值 `builtin|app|workspace|group`。skill UI HTTP（06/06a）保内部 app/workspace（见 `[P0]skill_manage_tool.md §11` bounded 说明）。group 层由团队 ws 目录承载（`.rocky/skills/`，与 group memory `.rocky/memory/` 对称；旧 `.rocky_squad/` 路径废止，存量由 MigrationManager `squad-rocky-dir` 平移）。

**目录结构**：每个 skill 一个目录 = `<skill-name>/SKILL.md`（必需）+ 可选 `references/*.md`（L2）`scripts/` `templates/`。目录名 = frontmatter name。

### 3.1 gitignore 决策（推荐）

- **app 级 `<dataDir>/skills/`**：不进 git（dataDir 是用户数据目录，如 `~/.rocky_agent_dev/`，天然不入库）。
- **workspace 级 `<workspaceDir>/.rocky/skills/`**：**建议进 git**（团队共享 skill 版本，符合 `[P0]skill_definition.md` §4.1 设计意图）。推荐项目 `.gitignore` 加 `!.rocky/` + 显式 `.rocky/skills/`；团队不想共享可自行 `echo '.rocky/skills/' >> .gitignore`（不强制）。

### 3.2 enabled 状态持久化

**决策**：用 **`app_config` 的 `skill_state` group**（key = skill name，data = `{enabled, scope}`）。**理由**：
1. **集中、可热查**：toggle 不需扫文件系统、不写 skill 目录（skill 目录是「只读资产」，写入治理字段会污染用户下载的 skill）。
2. **复用 AppConfigService**（`svc.set('skill_state', name, data)` / `svc.get` / `listGroup`），与 provider/policy 等状态同构，零新依赖。
3. **与 FsCrudStore 解耦**：skill 用 node:fs 直接操作目录（拷贝/解压/删除是文件级操作，FsCrudStore 的 json/jsonl 分片模型不匹配）。
4. **fallback 默认 enabled=true**：skill_state group 缺该 name 的 record → 视为 enabled（新装的 skill 默认开，符合 progressive disclosure 原则）。

**否决方案**：sidecar `<skill>/.rocky.meta.json`——会污染下载的 skill 目录、与「skill 是标准兼容资产」原则冲突，且 toggle 需写文件、原子性差。不采用。

---

## 4. SkillResolver（扫描 + 解析）

### 4.1 职责

无状态纯函数：扫四层目录（builtin/app/workspace/group）→ 解析 SKILL.md frontmatter → 合并去重（下游覆盖上游：group > workspace > app > builtin）→ 注入 enabled → 产出 `SkillCatalog`。

### 4.2 接口（groupDir 可选参）

```typescript
interface SkillResolver {
  /** 扫四层 + 合并 + 注入 enabled。groupDir 可选（studio session 传，其他传 undefined 走三层）。无副作用，每次全量扫（skill 数量小，不缓存）。 */
  resolve(
    dataDir: string,
    workspaceDir: string | undefined,
    enabledStore: SkillEnabledStore,
    builtinDir?: string,
    groupDir?: string,             // group ws 根目录（squad 或 classroom 共享 ws，内部派生 .rocky/skills/）
  ): SkillCatalog;
  /** resolveAll 同 resolve 签名（返回不过滤 enabled 的全 catalog，含 disabled；供 skill_manage list 用） */
  resolveAll(dataDir, workspaceDir?, enabledStore, builtinDir?, groupDir?): SkillCatalog;
  /** 按 name 寻址：lookup 顺序 group → workspace → app → builtin，命中最高层即返。 */
  lookup(dataDir, workspaceDir | undefined, name, builtinDir?, groupDir?): SkillContent | undefined;
}
```

**便利 helper**（export 供测试/未来扩展）：
```typescript
groupSkillRoot(groupWsDir: string): string
  // → `<groupWsDir>/.rocky/skills/`
```
resolver 内部走 `join(groupDir, '.rocky', 'skills')` 从 caller 传的 groupDir 派生（API 收目录不收 squadId/classroomId，更纯粹；groupDir 已由 caller 经 `agent/group-dir.ts resolveGroupWsDir(dataDir, {squadId?, classroomId?})` 唯一解析——squadId 优先于 classroomId，皆无 → 不传 groupDir）。

### 4.3 SkillCatalog / SkillEntry

```typescript
interface SkillCatalog { entries: SkillEntry[]; }   // entries 已去重（name 唯一）

interface SkillEntry {
  name: string;                                  // frontmatter name（= 目录名）
  description: string;                           // frontmatter description（≤1024）
  scope: 'builtin' | 'app' | 'workspace' | 'group';   // 4 值；命中层（group 最高优先级）
  skillDir: string;              // 绝对路径
  enabled: boolean;              // 来自 enabledStore（缺省 true）
  // 治理字段（仅记录，v0.0.21 不消费）
  source?: 'user' | 'agent';
  productionMethod?: 'handwritten' | 'consolidation' | 'download';
  mutable?: boolean;
}
```

### 4.4 扫描时机

**无缓存，每次调用全量扫**（on-demand）。调用点：
- `GET /skill`（列表）→ resolve
- `buildSessionConfigFromDeps`（每条 message 前）→ resolve 取 catalog 注入 SessionConfig.skills
- skill 工具 `run` → lookup（按 name）

**理由**：skill 数量小（个位~几十），扫盘 + 解析 frontmatter 成本可忽略；缓存会引入「install 后 catalog 不刷新」一致性 bug。无状态 = 永远新鲜。

## 5. SkillInstaller（安装流程）

### 5.1 流程

```
multipart upload (file | folder zip | .skill zip)
  → 解压到临时目录（tmp dir under dataDir）
  → 校验：含 SKILL.md + frontmatter 有 name + name kebab-case ≤64
  → name 冲突检查：目标 scope 目录同名已存在 → 409（前端确认覆盖再 DELETE + 重装）
  → 复制到 <scope>/<name>/（node:fs cpRecursive）
  → 扫描刷新（resolver.resolve）→ 取该 name 的 SkillEntry
  → 写 enabled_state（默认 enabled=true，即不写 record 走 fallback）
  → 返回 SkillEntry 元数据
```

### 5.2 zip 解压依赖选择

**决策：`adm-zip`**。

**理由**：
1. **同步 API**（`zip.extractAllTo`），与项目 fs-store 同步风格一致，代码直观。
2. **零原生依赖**（纯 JS），bun 兼容好，无需 node-gyp。
3. **API 简单**（`new AdmZip(buf).extractAllTo(dir, true)`），覆盖 `folder.zip` / `.skill`（zip 改后缀）两种场景。
4. **`yauzl` 否决**：流式 API 异步复杂，skill 包小（通常 <1MB），无流式收益。

### 5.3 格式识别（决策1：统一一个 handler）

multipart 字段名 **`files`**（兼容 `file`）。**每个 part 的 `filename` = 相对 skill 根的路径**（webkitRelativePath 约定，如 `my-skill/SKILL.md`）。兼容旧 run.sh 约定：filename 仅基名时读表单字段 `relativePath` 或 `relativePath_<basename>`。

| 上传形态 | 后端处理 |
|---------|---------|
| 单文件 `.md`（filename=`SKILL.md` 或仅基名） | 直接放置为 tmpRoot/SKILL.md（name 从 frontmatter） |
| 单 part `.zip` / `.skill` | adm-zip 解压到 tmpRoot → 找含 SKILL.md 的根（tmpRoot 自身或单层子目录） |
| 多 part（folder） | 按 filename/relativePath 还原目录树到 tmpRoot |

### 5.4 原子性

写到 tmp 目录 → 校验通过 → rename 到目标（`fs.renameSync` 原子）；失败回滚删 tmp。目标已存在不覆盖（返 409 让前端确认）。

> **frontmatter 解析依赖**：建议 `gray-matter`（成熟、轻量、防 YAML 边界 bug）；否决手写解析（name/description 虽简单但 frontmatter 边界 case 多）。

---

## 6. 注入点（dataDir / workspace 来源）

### 6.1 dataDir

`bootstrapBuiltinPlugins(dataDir)` 已注入（`bootstrap.ts:101`）。**BootstrapResult 不变**——SkillResolver 在 handler 内用 `deps.dataDir` 构造（无状态，不需 bootstrap 持有）。

### 6.2 workspaceDir

- **per-session**：`session.workspaceDir`（SessionStore 持久，v0.0.17 接线，见 `session-config.ts:62-80`）。
- skill API（`GET/PATCH/DELETE /skill`）从 query param `?workspace=<path>` 或当前选中 session 的 workspaceDir 取。**管理页 API 无 session 上下文** → 前端传 `workspace` query param（当前打开的 workspace）；缺省则只扫 app 级。

### 6.3 三处注入接线

| 调用点 | dataDir | workspaceDir |
|--------|---------|--------------|
| `GET/PATCH/DELETE /skill` | `deps.dataDir` | query `?workspace=` |
| skill 工具 `run` | `ctx.config.skills`（已 resolve 锁路径） | `ctx.config.workdir`（= session.workspaceDir） |
| system prompt skills mapper | `ctx.config.skills`（catalog） | （已 resolve，不重复扫） |

### 6.4 测试调试端点（决策2：`GET /session/:id/debug/system-prompt`）

**仅 test 环境开放**（`APP_ENV === 'test' || NODE_ENV === 'test'`，非 test → 404）。handler 调 `buildSessionConfigFromDeps`（注入 skills catalog）→ `buildSystemPrompt(pluginManager, config)` → 返回完整 system prompt 文本。供 AT 黑盒验证 skill L0 注入（toggle enabled/disabled 后 prompt 含/不含 skill 行），见 api/06-skill.md §11。

---

## 7. SessionConfig.skills 字段

### 7.1 字段定义（改 `agent/context-types.ts`）

```typescript
export interface SessionConfig {
  // ... 现有字段
  /** skill catalog 摘要（enabled 项），供 skills mapper 拼 L0 + skill 工具寻址 */
  skills?: SkillCatalog;
}
```

**字段 = 完整 SkillCatalog（enabled 项过滤后）**，不是裸 name 列表。理由：skill 工具的 `lookup` 需要 scope/skillDir 元数据；mapper 拼 L0 需要 description。一次 resolve，多处消费，避免重复扫盘。

### 7.2 注入（改 `handlers/session-config.ts buildSessionConfigFromDeps`）

```typescript
// 6. resolve skill catalog（仅 enabled 项）
const skills = skillResolver.resolve(dataDir, workspaceDir, enabledStore);
// 过滤 enabled=true 的 entries（fallback 缺省 true）
return { ..., skills: { entries: skills.entries.filter(e => e.enabled) } };
```

注入点 = workspaceDir 已确定后（`session-config.ts:78-85` 之后）。skill 工具 lookup 时用 `config.workdir` 作 workspace（= workspaceDir），与 §6.3 一致。

---

## 8. system prompt skills mapper 填肉（改 `prompt/skills.ts`）

```typescript
map(ctx: PromptCtx): PromptFragment[] {
  const entries = ctx.config.skills?.entries ?? [];
  if (entries.length === 0) return [];
  const lines = entries.map(e => `- ${e.name}: ${e.description}`);
  const content = `## Available Skills\n\n${lines.join('\n')}\n\nUse the \`skill\` tool to load a skill's full SKILL.md by name.`;
  return [{ id: 'skills', tier: 'stable', content, priority: 500 }];
}
```

- 读 `ctx.config.skills.entries`（已过滤 enabled），**不重复扫盘**（resolve 在 buildSessionConfig 已做）。
- 内容 = L0：name + description 列表（对齐 `[P0]skill_definition.md` §3 L0）。
- tier=stable（cache 友好，skill 列表 session 内不变）。

---

## 9. skill 读工具（`tools/skill.ts`，仿 `bash.ts`）

### 9.1 定义

```typescript
export const skillTool: Tool = {
  definition: {
    name: 'skill',
    description: 'Read a skill\'s full SKILL.md by name (progressive disclosure L1). Returns body + skillDir for L2 drill-down via Read tool.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', description: 'skill name (kebab-case)' } },
    },
  },
  async run(input, ctx): Promise<ToolRunResult> {
    const name = String(input.name ?? '');
    if (!name) return errorResult(`[invalid_input] name is required`);
    // 从 ctx.config.skills（已 resolve 的 catalog）按 name 寻址
    const entry = ctx.config.skills?.entries.find(e => e.name === name);
    if (!entry) return errorResult(`Skill "${name}" not found`);
    // 读 SKILL.md 全文
    const body = readFileSync(join(entry.skillDir, 'SKILL.md'), 'utf8');
    return textResult(JSON.stringify({ name, skillDir: entry.skillDir, scope: entry.scope, body }));
  },
};
```

### 9.2 寻址

从 `ctx.config.skills.entries`（resolve 时已 workspace 覆盖 app 去重）按 name 查 → 读 `skillDir/SKILL.md`。**不重复扫盘**，与 mapper 共用同一 catalog。

> `registry.ts defaultTools()` 增 `skillTool`（7 个默认工具）。`tool_guidance` mapper 自动介绍（读 `config.tools` 的 definition）。

---

## 10. 关键设计原则

1. **无状态扫描**：SkillResolver 不缓存，每次全量扫（skill 数量小，新鲜度 > 性能）。
2. **install 原子性**：tmp → rename，失败回滚，不污染目标 scope 目录。
3. **enabled 状态与 skill 资产分离**：skill 目录是只读标准资产；toggle 状态落 app_config，不写 skill 目录。
4. **catalog 一次 resolve 多处消费**：SessionConfig.skills 持 catalog，mapper 拼 L0 + skill 工具 lookup 共用，避免每 turn 重复扫盘。
5. **双层覆盖语义集中在 resolver**：workspace 覆盖 app 只在 `SkillResolver.resolve` 一处，其余模块消费合并后 catalog。
6. **纯读工具**：skill 工具只读不写（对齐 `[P0]skill_tool.md`），治理护栏留 self-evolution。

---

## 11. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/skills/types.ts` | 新增 | `SkillCatalog` / `SkillEntry` / `SkillFileNode` / `SkillContent` interface |
| `app/server/src/skills/resolver.ts` | 新增 | `SkillResolver`：`resolve(dataDir, workspaceDir, enabledStore)` + `lookup(name)`；双层扫描 + frontmatter 解析（gray-matter 或手写 YAML 解析）+ workspace 覆盖 app 合并 |
| `app/server/src/skills/enabled-store.ts` | 新增 | `SkillEnabledStore`：包装 `AppConfigService` 的 `skill_state` group（get/set/listGroup），fallback enabled=true |
| `app/server/src/skills/installer.ts` | 新增 | `SkillInstaller`：multipart → adm-zip 解压 → 校验 SKILL.md → rename 到 scope 目录；`install(file, scope, dataDir, workspaceDir)` |
| `app/server/src/skills/tree.ts` | 新增 | `buildFileTree(skillDir)` → `SkillFileNode[]`（递归，跳过二进制/超大文件） |
| `app/server/src/handlers/skill.ts` | 新增 | `handleSkillCollection` / `handleSkillInstall` / `handleSkillItem`（PATCH/DELETE）/ `handleSkillTree` / `handleSkillFile`；编排 resolver/installer/enabled-store |
| `app/server/src/tools/skill.ts` | 新增 | `skillTool`：Tool 实现，read action，从 `ctx.config.skills` 寻址读 SKILL.md |
| `app/server/src/tools/registry.ts` | 修改 | `defaultTools()` 增加 `skillTool`（push 进数组）；import skillTool |
| `app/server/src/router.ts` | 修改 | 注册 `/skill` `/skill/install` `/skill/:name` `/skill/:name/tree` `/skill/:name/file` 路由分发到 handlers/skill.ts |
| `app/server/src/agent/context-types.ts` | 修改 | `SessionConfig` 增 `skills?: SkillCatalog` 字段（注释说明 skill catalog 注入点） |
| `app/server/src/handlers/session-config.ts` | 修改 | `buildSessionConfigFromDeps` 末尾增 step 6：`skillResolver.resolve(dataDir, workspaceDir, enabledStore)` → 过滤 enabled → 赋 `config.skills` |
| `app/plugins/builtins/rocky_context/prompt/skills.ts` | 修改 | `SkillsMapper.map` 填肉：从 `ctx.config.skills.entries` 拼 L0 fragment（name + description 列表 + tool 引导），不再 no-op |
| `app/web/...` skill 管理 UI | 新增 | install/enable/delete/preview（见 PRD/UI spec，coder 编码前置产组件 spec） |
| `package.json` | 修改 | 增加 `adm-zip` 依赖（+ `@types/adm-zip` devDep） |

### 11.1 注入点确认（填补 reconcile 缺口）

- **skills mapper 数据源**：`ctx.config.skills.entries`（SessionConfig.skills，由 session-config.ts resolve 注入）✅
- **dataDir 路径**：`deps.dataDir`（router 透传，bootstrap 注入）✅
- **workspace 路径**：`session.workspaceDir`（loop 内）/ query param `?workspace=`（管理 API）✅
- **gitignore 决策**：app 级不进 git（dataDir 天然不入库）；workspace 级 `.rocky/skills/` 建议进 git（团队共享），推荐项不强制 ✅

---

## 12. 与其他子系统的关系（实现层）

- `context/system_prompt`：skills mapper（已注册 priority 500）读 `config.skills` 拼 L0。
- `tools/`：skill 工具注册进 defaultTools；tool_guidance mapper 自动介绍。
- `persistence/app_config`：enabled 状态落 `skill_state` group（复用 AppConfigService）。
- `agent/session`（v0.0.17 workspace）：workspaceDir 来源；session-config.ts 注入 skills 时用。
- `http/router`：新增 /skill 路由组。

## 13. 风险与边界

- **frontmatter 解析**：见 §5.4（gray-matter）。
- **大文件预览**：`GET /skill/:name/file` 文本超 256KB 截断；二进制返类型标记不返内容。
- **路径穿越**：`?path=` 必须 resolve 后 startsWith skillDir（仿 `session-workspace-seed.ts:68`）。
- **并发安装同名**：rename 前检查目标存在 → 409；不自动覆盖。
