---
type: spec
title: Skill 定义
priority: P0
status: active
updated: 2026-08-04
since: v0.0.21
---

# Skill 定义

skill = agent 的**可复用能力载体**——把"某类任务怎么做"封装成可加载、可复用、可演化的单元。agent 遇到匹配场景时加载对应 skill 走已验证流程。
主文档：`index.md`。skill 读工具见 `[P0]skill_tool.md`。skill 元数据注入 system prompt 见 `../context/[P0]system_prompt.md` §4 `skills` mapper（L0 注入）。

> **实现落点（v0.0.51；v0.0.55 改名 evolvable + 删 mutableLocked）**：evolvable 强制执行落地于 `app/server/src/tools/skill-manage.ts`（agent 路径）+ `app/server/src/skills/governance.ts`（UI 路径，PATCH `/skill/:name/governance`）；L0 catalog `[evolvable=true|false]` 标记落地于 `app/plugins/builtins/rocky_context/prompt/skills.ts`。**v0.0.55 SPEC CHANGE**：`mutable → evolvable`（更直观）；删 `mutableLocked` 维度（UI 一定能改 evolvable，agent 不碰治理元字段——无需 lock）。

## 1. 概述

skill 是 agent 的**可复用能力载体**——把"某类任务怎么做"封装成可加载、可复用、可演化的单元。agent 遇到匹配场景时加载对应 skill 走已验证流程。

**载体**：一个目录 + 一个 `SKILL.md`（markdown + YAML frontmatter），格式兼容 Claude Code / OpenClaw。

**当前范围**：UI 管理 skill（install/enable/delete/preview）+ skill **读**工具（读全文 + 目录）+ system prompt 注入（L0）+ **agent 写工具 `skill_manage`**（create/patch/disable/enable/list/read，v0.0.51 已实现）。

## 2. SKILL.md 结构

```yaml
---
name: skill-name              # 必需，全局唯一 id（同 scope 内），kebab-case，≤64 字符
description: ...              # 必需，触发器：何时用此 skill（模型驱动匹配），≤50 字符（agent 写侧 executeCreate/executePatch 硬检查；UI 市场安装路径不受影响）
allowed-tools: Read, Grep     # 可选，skill 激活时锁定的工具集
# —— 治理字段（见 §6；强制执行）——
source: user                  # 'user' | 'agent'（originator；builtin 在 resolver 落 'user' fallback）
production_method: download   # handwritten | consolidation | download（builtin 不写此字段）
updated: 2026-07-15T10:30:00Z # [v0.0.149] 最后修改时间（ISO 8601，frontmatter 短形 `updated`/语义化 `updatedAt` 均可）；组内排序依据
evolvable: false              # 是否允许 agent 修改/整理（强制：false 拒绝 patch/disable/enable）
# —— 市场来源锚点（见 [P1]skill_market.md §7.1；仅市场安装写，本地/builtin 缺省）——
market_ref: github/awesome-copilot/git-commit  # [v0.0.167] 安装用的 provider ref（同源判定 + 覆盖守卫依据）
market_source: skills_sh      # [v0.0.167] provider id（来源展示）
installed_hash: a1b2c3…       # [v0.0.167] 安装时内容哈希（可更新比对锚点）
---
```

可选支持文件：`references/*.md`（L2 深度参考）、`scripts/*`、`templates/*`。

> 治理字段保留在 frontmatter，UI install 时可写入（如 `source=user, method=download, evolvable=false`）。skill 读工具不解释这些字段。`evolvable` 字段由 `skill_manage` 工具强制检查（见 `[P0]skill_manage_tool.md`）+ UI governance 端点直接修改（见 §8）。L0 catalog 注入 system prompt 时带 `evolvable` 标记（让 LLM 知道哪些 skill 可改）。**disabled skill 不出现在 L0 catalog**。
>
> **v0.0.55 字段改名 + 删维度**：`mutable → evolvable`（更直观「是否开启自进化」）；删 `mutableLocked` 维度（v0.0.51 引入、零历史包袱）。理由：UI 一定能改 evolvable（用户对自己资产有完全控制权），agent 不碰治理元字段（它不会无聊改这个）；用户要禁某 skill 自进化 → UI 直接把 evolvable 设 false（无需 lock）。
>
> **[v0.0.149] frontmatter 加 `updated`/`updatedAt`（注入配额组内排序依据）+ spec↔code 漂移订正**：
> - **新增 `updated`（ISO 8601）frontmatter 字段**：`skill_manage` create/patch + UI governance PATCH 刷新 `updated = now`；builtin skill 在源 frontmatter 内带固定 `updated`（随发版）；缺 `updated`（legacy）→ 排序按 epoch 0（组内最末），组内 tiebreak name 升序保确定。**无 skill migration**（文件型；缺失仅排末，下次编辑自动盖戳）。读侧（`resolver.ts readUpdatedAt`）优先 `updatedAt`（语义化），回退 `updated`（短形）；两者皆非 string → undefined。写侧（`skill_manage executeCreate/executePatch` + `governance writeGovernance`）落 frontmatter `updated`。
> - **spec↔code 漂移订正（重要）**：原 spec（§2 / §6.2 默认值表）写 `source: user | agent | system`（三值），但**代码 `SkillEntry.source` enum 实际是 `'user' | 'agent'`**（`app/server/src/skills/types.ts`），**无 `'system'`**——builtin skill 在 `resolver.ts` L89 落 `source='user'` fallback（builtin frontmatter 即便写 `source: system` 也被 resolver normalize 为 `'user'`）。本文 §2/§6.2 已订正为 `'user' | 'agent'`。
> - **builtin 由 scope 派生 injectLayer，不经 origin**：注入侧 `skills.ts` 内部 `SkillRow` 有 `origin: 'user'|'agent'`（仅二值，无 `'system'`）+ `scope: SkillScope`（builtin/app/workspace/group）。builtin 的「恒全量殿后」靠 `injectLayerOf(scope)` 映射到独立 inject layer `'builtin'`（不计配额），**不靠 origin 分组**——层内排序只用 origin(user→agent)，builtin 层整体跳过配额截断按 `sortFn` 全量拼入 catalog 尾部。

## 3. progressive disclosure（三层加载，控 token）

| 层 | 加载内容 | 时机 | 成本 |
|----|---------|------|------|
| L0 metadata | `name` + `description` + `[evolvable]` + `[scope=...]` 来源层标注 | 始终（注入 system prompt `skills` mapper，见 system_prompt §4） | 廉价，catalog 全量常驻 |
| L1 body | 完整 SKILL.md 正文 | skill 被触发 → agent 调 `skill` 读工具 | 按需 |
| L2 references | references/scripts 等 | agent 主动钻取（Read 工具读目录绝对路径下文件） | 深度按需 |

**设计意图**：skill 数量增长 ≠ token 爆炸——catalog（L0）廉价常驻，全文（L1）与细节（L2）按需加载。

**L0 行格式**（skills mapper 渲染）：`- {name} [evolvable=true|false] [scope=builtin|app|workspace|group]: {description}`。**来源层标注**（v0.0.232）：每条带 4 层 scope 标注（底层 `SkillScope` 原值，不做 global/session 对外映射——注入透明化要求可溯源到具体层）；路径不在每行重复（路径说明统一由「定义你的 agent」c) 条承担，见 `../context/[P1]agent_profile.md`）。

**[v0.0.238] 注入配额（分层 + builtin 不计）**：`selectSkillsByQuota` 接 `SkillInjectQuotas` `{ session: 20; group: 30; global: 50 }`，物理层归组映射：
- workspace 层（scope='workspace'）→ session 层配额 ≤20
- group 层（scope='group'）→ group 层配额 ≤30
- app 层（scope='app'）→ global 层配额 ≤50
- **builtin 层（scope='builtin'）不计入配额、恒全量注入**（平台资产，用户/agent 不可控，裁掉会破坏基础能力）

catalog 拼接序 = **workspace → group → app → builtin**（近者优先，修正旧「system→user→agent 方向反」——squad 自定义 group 不再被 builtin 挤掉配额）；层内 user→agent + updatedAt 倒序 + name 升序。studio 场景 workspace 与 group 物理同址 → resolver 同址双扫按 group 生效 → workspace 层条目为空 → session 配额不参与（与 PRD studio 可用表无 session 一致）。配额源：app_config `session` group，`maxSkillInject`（旧 key 语义转为 global 层）/ `maxSkillInjectGroup` / `maxSkillInjectSession`（缺省 50/30/20）。

**实现**：L0 = system prompt 注入（必做）；L1 = skill 读工具返回全文（必做）；L2 = agent 用已有 Read 工具读目录（无需新工具）。

## 4. scope 分层

rocky_agent 是 Electron app，有 **dataDir**（app 数据根，如 `~/.rocky_agent_dev/`，v0.0.1 引入）+ **workspace**（工作区，v0.0.17 引入）概念。skill 存储用 rocky_agent 原生命名 `.rocky/`，**不沿用 Claude Code 的 `.claude/`**（那是 Claude Code CLI 的 CWD/home 约定，与 Electron app 的 dataDir/workspace 模型不匹配）。

> **对外 scope 命名 `global`/`session`**（仅 `skill_manage`/`skill` **工具**入参/输出层；底层 `SkillScope` = 4 值 `builtin|app|workspace|group`）：对外 `global` ↔ 底层 `app`（builtin/group 输出回显也归 `global`）；对外 `session` ↔ 底层 `workspace`。映射发生在 `skill_manage`/`skill` 工具边界（见 `[P0]skill_manage_tool.md §2`）。**工具 enum 不暴露 group**——团队共享 skill 通过 group ws 目录自动生效（无需 agent 显式选 scope），保对外 skill_manage/skill tool schema 不变。**但 HTTP/UI 层暴露 group**：`GET /skill` 响应 `SkillEntry.scope` 值域含 `'group'`（chat 悬浮菜单 skills 入口数据源，前端按 session=workspace / group=group / global=builtin+app 三层分组展示，见 `index.md` ④ 原则 3）。
>
> ⚠️ **session ≠ 单会话私有**：对外 `session`（底层 workspace）是**项目级** workspace 存储（一个项目多会话共享、可随 git 团队共享），非严格单会话私有。memory 的 `session` 才是真·单会话。命名统一后 tool description + 本 spec 须显式消歧（`skill_manage_tool.md §2.1`）。

| scope（底层） | 对外 | 位置 | 范围 | 生命周期 |
|-------|------|------|------|---------|
| builtin | —（不暴露） | 项目内 `app/plugins/builtins/*/skills/`（打包时进 asar） | 所有 agent 默认 | 随 app 版本 |
| app 级 | `global` | `<dataDir>/skills/` | 所有 workspace 共享（用户全局） | 随 app，跨 workspace 持久 |
| workspace 级 | `session`（项目级） | `<workspace>/.rocky/skills/` | 当前 workspace 专属（项目级，非单会话） | 随 workspace（可随 git/团队共享） |
| **group 级** | —（工具不暴露；HTTP `SkillEntry.scope='group'`） | `<groupWs>/.rocky/skills/`（groupWs = squad `<dataDir>/squads/<sid>/`） | 当前团队（squad）内多 session 共享 | 随团队 ws（squad 删除时目录级联清理） |

- `dataDir` 由 app 配置决定（test/dev/prod 不同，见 `specs/tech/app`）。
- `workspace` 是用户在 app 里打开的目录（v0.0.17 工作区概念）。
- group 目录与 workspace 同用 `.rocky/` 命名空间（**`.rocky/` = rocky app 数据在对象 ws 里的存放位置**，memory/skill/state 统一收口；与 group memory `.rocky/memory/` 对称；旧 `.rocky_squad/` 路径废止，存量由 MigrationManager `squad-rocky-dir` 平移）。
- 四层**都参与合并**注入 system prompt（L0），都参与 skill 读工具寻址（L1）。

### 4.1 四层合并语义

agent 可见 skill = builtin ∪ app 级 ∪ workspace 级 ∪ group 级（按 `name` 合并）。

**同名冲突覆盖优先级（下游覆盖上游）**：**group > workspace > app > builtin**

理由：
1. **group 最高**——团队（squad/classroom）内约定的规则/工具应对本团队强制生效，覆盖成员个人 workspace 版本（group = 团队 source of truth）。
2. **workspace > app**——workspace 更"近"用户当前任务，可 pin 特定版本；随 git 共享让团队强制 skill 版本。
3. **app > builtin**——用户下载的 skill 覆盖系统内建默认（用户对自己 dataDir 资产完全控制权）。
4. **向后兼容**——无 group 的 session（playground/subagent，groupDir 缺省）走原三层（builtin < app < workspace），无 breaking。

**L0 注入**：合并后的 catalog（去重，name 唯一）注入 system prompt `skills` mapper。同名时最高优先级层的 description 胜出。
**L1 寻址**：skill 读工具按 name 查找 lookup 顺序 `group → workspace → app → builtin`，命中最高优先级层返回其路径与全文。

> **squad 场景 workspace 层与 group 层同址（v0.0.232）**：squad session 的 `workspaceDir = squads/{sid}/`（团队 workspace 简化，见 `../../squad/[P1]squad_workspace.md`），故 workspace 层（`<workdir>/.rocky/skills/`）与 group 层（`<groupWs>/.rocky/skills/`）扫描同一目录——合并去重后该目录的 entry 以 `scope='group'` 生效（group 高层覆盖），L0 标注 `[scope=group]`；「定义你的 agent」c) 条将两层合并渲染为一行「团队」。无 resolver 代码变更（同址双扫幂等）。

**resolver API**：`SkillResolver.resolve/resolveAll/lookup` 末位加可选 `groupDir?: string` 参数（groupDir = group ws 根目录，caller 经 `agent/group-dir.ts resolveGroupWsDir(dataDir, {squadId?})` 唯一解析——皆无不传；内部通过 `join(groupDir, '.rocky', 'skills')` 派生扫描根）。**caller 契约**：`handlers/session-config.ts` 在 session 有 squadId（studio）时传 groupDir，否则传 `undefined` 保后向兼容。便利 helper `groupSkillRoot(groupWsDir): string` 已 export 供测试/未来扩展用（resolver 内部不调它，走 caller-supplied groupDir 保 API 收目录不收 id 更纯粹）。

### 4.2 迁移说明（从 .claude → .rocky）

- **废弃**：spec 旧版的「项目 `.claude/skills/` + 个人 `~/.claude/skills/`」路径。
- **迁移映射**：原"项目级" → workspace 级（`<workspace>/.rocky/skills/`）；原"个人级" → app 级（`<dataDir>/skills/`）。
- **理由**：Claude Code 是 CLI（CWD = 项目，home = 个人）；rocky_agent 是 Electron app（workspace = 打开的目录，dataDir = app 数据根），用 `.rocky/` 命名区分自家生态。Claude Code 的 `.claude/` skill 目录与 rocky_agent 互不读取。

## 5. 触发机制

- **模型驱动**（主）：agent 根据 L0 注入的 `description` + 当前上下文自动触发 → 调 skill 读工具取 L1 全文。**description 即路由**。
- **显式调用**（辅）：用户/agent 直接指名调用 skill 读工具。

## 6. 治理字段（单维度：evolvable）

**强制执行**。一个维度控制 agent 写路径；UI 路径直接改 evolvable（用户对自己资产有完全控制权）。

### 6.1 `evolvable` —— agent / consolidation 可改性

控制 `skill_manage` 工具的 patch/disable/enable 是否允许（agent 写路径）：

- `evolvable=false` 的 skill：`skill_manage` 的 patch/disable/enable **全部拒绝**。
- `evolvable=true` 的 skill：允许 patch/disable/enable。
- **evolvable 字段本身不可被 agent 修改**（不能 true→false，也不能 false→true）。agent 工具的 patch payload 不含 `evolvable` 字段。创建时设定（agent create 自动 `evolvable=true`，用户手写/下载 `evolvable=false`）。
- **UI 可改 evolvable**（无 lock 维度，§8）：用户对自己资产有完全控制权——可手动把 immutable skill 解锁让 consolidation 优化，也可把 evolvable skill 切回 false。系统内置 skill UI 也能改（不强行防呆，用户对自己 dataDir 资产有完全控制权）。

### 6.2 默认值表（按场景）

| 场景 | source | method | evolvable | 含义 |
|------|--------|--------|-----------|------|
| 用户手写 | `user` | `handwritten` | `false` | 用户资产；agent 不可改；UI 可切 true 让 consolidation 优化 |
| 第三方下载（UI install） | `user` | `download` | `false` | 同上 |
| agent create / 整理产出 | `agent` | `consolidation` | `true` | agent 资产；agent 可改；UI 可切 false 防 agent 再改 |
| 系统内置（builtin） | `user`（resolver fallback） | —（不写 method） | `false` | 默认固化（agent 不可改）；UI 仍可改（用户对自己 dataDir 资产有完全控制权）。**[v0.0.149] spec↔code 订正**：`SkillEntry.source` enum 无 `'system'`，builtin 在 `resolver.ts` L89 落 source='user' fallback；builtin 分组靠 `scope==='builtin'` 派生（见 §2 注），不靠 source |

### 6.3 创建时写入规则

- UI install 的 skill 默认 `source=user, method=download, evolvable=false`（install 时由后端写入 frontmatter）。
- `skill_manage.create` 创建的 skill 自动设 `source=agent, method=consolidation, evolvable=true`，并盖 `updated=now`（[v0.0.149] 注入排序用）。
- 系统内置 skill 在打包容器时硬编码 `evolvable=false`（不通过 install / create 路径写入；source 由 resolver 落 'user' fallback）。
- **[v0.0.167] 市场安装追加来源锚点**：`POST /skills/market/install`（及 skill_manage install）落盘时除治理字段外，写 `market_ref` / `market_source` / `installed_hash`（见 `[P1]skill_market.md §7.1`）。resolver 读入 `SkillEntry.marketRef/marketSource/installedHash`（缺省=本地来源，不报错）。UI「我的」tab 据 marketRef 有无显示「市场/本地」来源 badge；市场 tab 据 ref===marketRef 判同源已安装、据 detail.hash vs installed_hash 判可更新。

### 6.4 存储数量硬上限（executeCreate create 路径配额）

**各对外 scope active skill 数硬限**：global ≤50 / group ≤30 / session ≤20（与注入配额 §3 同值同源，复用 `app_config.session` group 三 key：`maxSkillInject`/`maxSkillInjectGroup`/`maxSkillInjectSession`；存储侧 `resolveSkillStoreQuotas` 读同 key 同兜底）。补 v0.0.238 注入配额只截「注入 prompt 条数」不限「磁盘存储条数」的缺口。

- **位置 = `executeCreate` dir 锁内单点**（`tools/skill-manage-actions.ts`，与 description ≤50 硬检查同 create 路径）；skill 走工具路径，无 UI HTTP 直写路径（UI 市场安装 `executeMarketInstall` 不受此限——第三方 skill 是源数据，T1 整理负责收敛低质）。
- **溢出 = `SkillQuotaExceededError` 硬拒绝**（`skills/policy.ts`，携 `scope`/`current`/`limit`/`nonEvolvableCount` 四字段）；message 形态 `skill <scope> quota exceeded (<current>/<limit>); disable an old skill to free space`；catch 转 `[INVALID_INPUT]` 返回 agent（不抛 HTTP）。
- **核心不变量**（贯穿实现）：
  1. **只在 executeCreate 触发**——`executePatch` / `enable` / `disable` **不触发**（disable 是减少 active，被自己拦会自锁；patch 不增条目数）。
  2. **disabled 不计入**——`countActiveSkillsInScope` 调 `SkillResolver.resolve` 后 filter `enabled === true`（与 L0 catalog `selectSkillsByQuota` 同口径）。
  3. **builtin 不计**——resolver 排除 builtin scope（agent/用户物理不会写 builtin 层；builtin 恒全量殿后）。
  4. **evolvable=false 计入配额**（防全标 false 绕过），但溢出错误文案如实附 `(note: X non-evolvable skill(s) cannot be disabled — patch or re-evaluate them)`——守 v0.0.151「如实反映」立场。
  5. **count + check + write 原子**——嵌套 dir 级虚拟锁 `<scopeRoot>/.quota.lock`（仅 create 分支），count+check+write 全在 dir 锁内串行，防并发 create 不同 name 的 TOCTOU race；嵌套顺序固定 entry 锁（外）→ dir 锁（内），无死锁。
  6. **内部 scope → 对外映射**——`countActiveSkillsInScope` 收内部 `'app'|'workspace'|'group'`（与 executeCreate 写入层一致），`checkSkillStoreQuota` 经 `toExternalScope` 映射到对外 `'global'|'session'|'group'` 查 `quotas[extScope]`（app→global / workspace→session / group→group）。
- **executeCreate 签名加末参 `appConfig: AppConfigService | null = null`**：`null`（UT 直调 / 向后兼容）→ 不查配额原 write 行为；生产路径经 `skill-manage.ts` 单 caller 注入 `ctx.config.appConfig`。
- **存量不追溯**：现存超限 skill 不强制清理，靠硬拦截驱动收敛。

## 7. 设计决策

- **标准 SKILL.md，不造新协议**：兼容生态。
- **description 即触发器**：模型自主判断，减少用户负担。
- **progressive disclosure**：控 token 是 skill 规模化演进的前提。
- **workspace 级覆盖 app 级**：项目/workspace 是 source of truth（§4.1）。
- **`.rocky/` 命名**：rocky_agent 自家生态，与 Claude Code 的 `.claude/` 区分。
- **存储数量硬限（补 v0.0.238 注入配额存储侧缺口）**：executeCreate create 路径查 active skill 数（disabled/builtin 不计），超 group30/global50/session20 硬拒（错误引导 disable 腾位）；count+write 在 dir 级虚拟锁内原子（防 race）。值跟注入配额同源、概念解耦（独立 type）。详见 §6.4。

## 8. UI 改 evolvable（用户资产控制权 — v0.0.55 简化）

**用户对自己资产有完全控制权**：UI 默认能改 `evolvable` 字段（true↔false 切换），无 lock 约束（v0.0.55 删 mutableLocked 维度）。典型场景：

- 用户手写了一个 skill（默认 `evolvable=false`），希望让 consolidation fork 优化它 → UI 切到 `evolvable=true`。
- agent create 的 skill（默认 `evolvable=true`），用户不想被 agent 再改 → UI 切到 `evolvable=false`。
- 系统内置 skill（默认 `evolvable=false`），用户想解锁让 agent 整理 → UI 切到 `evolvable=true`（不强行防呆——用户对自己 dataDir 资产有完全控制权）。

**强制规则**：

- **UI 路径不经过 `skill_manage` 工具**——是独立 HTTP 端点（`PATCH /skill/:name/governance`），调用 SkillsService 而非 agent tool。理由：UI 操作不是 agent 行为，不混入 agent 工具调用语义。
- **无 lock 检查**（v0.0.55 删 mutableLocked）：UI 直接修改 frontmatter `evolvable` 字段（per-file lock 串行化仍生效，避免与 agent patch 并发撕裂 SKILL.md）。

**与 agent 工具的关系**：

- agent 工具（`skill_manage`）**永远不能改 evolvable**——见 §6.1 + `skill_manage_tool.md §4`。
- UI 路径**无约束**——直接改 evolvable（用户对自己资产有完全控制权）。

## 9. 待定（P1+）

- skill 与 plugin_system extension_point 的关系
- skill 版本管理（git tag / semver）
- 第三方 skill 分发与供应链安全（ClawHub 等）
- UI 路径细节（PATCH 端点的字段集 / 双因素确认 / 审计日志）

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
