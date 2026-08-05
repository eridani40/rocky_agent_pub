# v0.0.21 技术变更日志

> 概述：**新增最小可用的 Skill 子系统**。skill 是 agent 的可复用能力载体（标准 `SKILL.md`，兼容 Claude Code / OpenClaw 格式）。本版本交付三件套：(1) UI 管理 skill（install/enable/delete/preview）；(2) agent 侧 **纯读 `skill` 工具**（input name → SKILL.md 全文 + skillDir，L1 渐进式披露）；(3) system prompt **`skills` mapper 填肉**（L0：name+description 常驻，从 SessionConfig.skills 读 enabled 项）。废弃旧 skill spec 的 `.claude/skills/` 约定，改 rocky_agent 原生 `.rocky/skills/` 双层存储。
> 概念权威源：`specs/tech/agent/skills/`（overview / skill_definition / skill_tool / skill_architecture）；PRD：`specs/prd/overall/06-skill.md`；API：`specs/api/overall/06-skill.md`；UI：`specs/ui/overall/04-skill-page.md` + `specs/ui/components/skill-page/`（7 组件）+ `framework/nav-rail.md`（第 5 项）。
> 设计稿：`reqs/v0.0.21/easy-opc-skill-v10.html`（视觉契约）。

## 1. 锁定决策（权威，对齐 user_query 4 条）

| # | 决策 | 落地 |
|---|------|------|
| 1 | 存储 = 双层 `.rocky/skills/`（**不用 `.claude`**） | app 级 `<dataDir>/skills/<name>/` + workspace 级 `<workspace>/.rocky/skills/<name>/`；同名 workspace 覆盖 app（仅 resolver 一处合并，见 §3）；详见 `[P0]skill_definition.md` §4 / `[P0]skill_architecture.md` §3 |
| 2 | agent 工具 = **纯读 `skill`**（无 list/写操作） | `[P0]skill_tool.md`：input `{name}` → `{name, skillDir, body, scope}`；写操作（create/patch/edit/archive）与 list 移至 roadmap |
| 3 | enabled 状态落 `app_config.skill_state` group（key=name） | `enabled-store.ts` 包装 AppConfigService（`svc.set/get/listGroup`），fallback enabled=true；不写 skill 目录（资产是只读标准件）；详见 `[P0]skill_architecture.md` §3.2 |
| 4 | L0 注入 = `skills` mapper（system_prompt_mapper 链 #4，priority 500 stable tier） | `prompt/skills.ts` `SkillsMapper.map` 填肉：从 `ctx.config.skills.entries` 拼 name+description 列表 + tool 引导；详见 `[P0]skill_architecture.md` §8 |
| 5 | 治理字段（source/method/mutable）**仅记录不强制** | frontmatter 保留三字段（UI install 写默认值 `source=user, method=download, mutable=false`）；v0.0.21 无 agent 写入路径故无强制对象；留 self-evolution；见 `[P0]skill_definition.md` §6 |
| 6 | install 全格式（file/folder/zip/.skill 包） | `installer.ts`：multipart → adm-zip 解压 → 校验有 SKILL.md → tmp→rename 落 scope；原子失败回滚；见 `[P0]skill_architecture.md` §11 |

## 2. tech spec 改动清单

| spec | version | 改动摘要 |
|------|---------|---------|
| `agent/skills/[P0]overview.md` | 0.2 → 0.3 | 范围从 agent self-evolution 收窄为「最小可用」（UI 管理 + 读工具 + L0 注入）；存储改 `.rocky/skills/` 双层；agent 工具改纯读 `skill`；治理字段改仅记录 |
| `agent/skills/[P0]skill_definition.md` | 0.2 → 0.3 | §4 scope 改 rocky_agent 原生双层路径（废弃 `.claude/skills/`）；§6 治理字段保留但 v0.0.21 不强制 |
| `agent/skills/[P0]skill_tool.md` | 0.2 → 0.3 | 从 `skill_manage`（全套写）改为纯读 `skill`（input name → 全文+目录）；create/patch/edit/archive/list 移 §6 roadmap；旧文件名 `skill_manage_tool.md` 废弃 |
| `agent/skills/[P0]skill_architecture.md` | — 新增 1.0 | v0.0.21 实现架构：模块划分 / 双层存储路径 / enabled-store / install 原子性 / skills mapper 填肉 / 文件级变更清单（13 项） |
| `agent/context/[P0]system_prompt.md` | 0.4（沿用） | §4 mapper 表 `skills` 行（order 4，stable tier，源=skills 注册表）—— 概念层未变，本次填肉实现层（不改本 spec 版本） |
| `agent/context/[P0]extension point and implementations.md` | 沿用 | `skills` impl（`./prompt/skills.ts`）已在 v0.0.13 注册，本次仅填肉 `map()`，不动 manifest |

## 3. 核心设计原则（doc-modifier 须同步进 overall）

- **双层存储、workspace 覆盖 app**：app 级 `<dataDir>/skills/`（全局共享）+ workspace 级 `<workspace>/.rocky/skills/`（当前工作区专属）。**不用 `.claude`**（rocky_agent 原生路径）。同名合并只发生在 `SkillResolver.resolve` 一处，其余模块消费合并后 catalog——单一覆盖点，避免漂移。
- **progressive disclosure（控 token）**：L0 catalog（name+description）廉价常驻 system prompt；L1 全文按需（agent 调 `skill` 工具读 SKILL.md）；L2 references/scripts 钻取（agent 用 Read 工具读 skillDir 内文件）。三层逐级加载。
- **skill 工具纯读、不做 list**：agent 已从 system prompt（L0）知有哪些 skill、各自 description——工具 list 冗余且重复占 token。工具只负责 L1 全文加载。写技能属 self-evolution，移 roadmap。
- **enabled 状态与 skill 资产分离**：skill 目录是只读标准资产（用户下载/手写，不污染）；toggle 状态落 `app_config.skill_state` group（复用 AppConfigService，零新依赖）。fallback 默认 enabled=true（新装默认开，合 progressive disclosure）。
- **catalog 一次 resolve 多处消费**：`SessionConfig.skills` 持 catalog（session-config.ts 注入），mapper 拼 L0 + skill 工具 lookup 共用，避免每 turn 重复扫盘。
- **install 原子性**：tmp → rename，失败回滚，不污染目标 scope 目录。全格式支持（file/folder/zip/.skill）。

## 4. 文件级变更清单（实现，对齐 `[P0]skill_architecture.md` §11）

新增模块（`app/server/src/skills/`，各 ≤300 行）：

| 文件 | 职责 |
|------|------|
| `types.ts` | `SkillCatalog` / `SkillEntry` / `SkillFileNode` / `SkillContent` |
| `resolver.ts` | `SkillResolver.resolve(dataDir, workspaceDir, enabledStore)` + `lookup(name)`；双层扫描 + frontmatter 解析 + workspace 覆盖合并 |
| `enabled-store.ts` | `SkillEnabledStore`：包装 AppConfigService `skill_state` group，fallback enabled=true |
| `installer.ts` | `SkillInstaller.install`：multipart → adm-zip 解压 → 校验 SKILL.md → tmp→rename 落 scope |
| `tree.ts` | `buildFileTree(skillDir)` → `SkillFileNode[]`（递归，跳二进制/超大） |

编排/接入：

| 文件 | 操作 | 变更 |
|------|------|------|
| `app/server/src/handlers/skill.ts` | 新增 | HTTP handler（install/list/patch/delete/tree/file），见 `specs/api/overall/06-skill.md` |
| `app/server/src/tools/skill.ts` | 新增 | `skillTool`（Tool 实现，纯读 action） |
| `app/server/src/tools/registry.ts` | 修改 | `defaultTools()` push `skillTool` |
| `app/server/src/router.ts` | 修改 | 注册 `/skill` `/skill/install` `/skill/:name` `/skill/:name/tree` `/skill/:name/file` |
| `app/server/src/agent/context-types.ts` | 修改 | `SessionConfig` 加 `skills?: SkillCatalog` |
| `app/server/src/handlers/session-config.ts` | 修改 | `buildSessionConfigFromDeps` 末尾 step 6：resolve → 过滤 enabled → 赋 `config.skills` |
| `app/plugins/builtins/rocky_context/prompt/skills.ts` | 修改 | `SkillsMapper.map` 填肉：从 `ctx.config.skills.entries` 拼 L0 fragment（不再 no-op） |
| `package.json` | 修改 | 加 `adm-zip`（+ `@types/adm-zip` devDep） |

前端：skill 管理 UI（`app/web/...`）install/enable/delete/preview，见 `specs/ui/components/skill-page/`（7 组件：page-skill / section-skill-list / component-skill-item / component-skill-drop-zone / component-skill-tabs / component-skill-preview-modal / component-skill-delete-modal）+ nav-rail 第 5 项（`framework/nav-rail.md`）。

## 5. BUG 与运维

- **BUG-001 vite proxy missing skill `[open]`**：vite dev server proxy 表未含 `/skill` → 前端开发态调不通 skill API。fix：vite config 加 `/skill` proxy 条目（转发 server）。状态见 `states/v0.0.21/bugs/BUG-001-vite-proxy-missing-skill-[open].md`（主仓库）。

## 6. 不在范围（roadmap）

- **agent 写技能**（create/patch/edit/archive skill，self-evolution）—— 见 `[P0]skill_tool.md` §6
- **skill 版本管理** / 供应链安全（签名校验）—— 见 `[P0]skill_definition.md` §8/§9
- **治理字段强制**（mutable=false 拒 patch/edit/archive）—— 留 self-evolution 启用时实现
- **memory 子系统整理产出 skill** —— `[P0]overview.md` §4 标 roadmap，本版不实现
- **skill 与 plugin ext impl 关系** —— P1+，未定

## 7. 与其他版本的衔接

- **依赖 v0.0.17 workspace**：`session.workspaceDir`（v0.0.17 接线）是 workspace 级 skill scope 的路径来源；session-config.ts 注入 skills 时用。
- **复用 v0.0.13 system_prompt 链**：`skills` mapper 已在 v0.0.13 由 PluginManager 注册进 `rocky_context` plugin（priority 500，stable tier #4），本版只填肉 `map()`，不新增 EP/impl。
- **复用 v0.0.5 app_config**：enabled 状态落 `skill_state` group，零新依赖（AppConfigService 已有 set/get/listGroup）。
