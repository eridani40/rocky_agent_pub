---
type: log
title: Skills KB 变更记录
updated: 2026-08-04
---

# Skills KB 变更记录（ISO 倒序，最新在前）

## 2026-08-04 · v0.0.247 存储数量硬上限（补 v0.0.238 注入配额存储侧缺口）

- **`skill_definition.md §6.4`（新增）**：各对外 scope active skill 数硬限 global50/group30/session20（与注入配额同值同源，复用 `app_config.session` 三 key `maxSkillInject`/`maxSkillInjectGroup`/`maxSkillInjectSession`；`SkillStoreQuotas` 独立 type 概念解耦）。位置 = `executeCreate` dir 锁内单点（skill 走工具路径，无 UI HTTP 直写；UI 市场安装 `executeMarketInstall` 不受此限）。
- **6 不变量**：① 只在 executeCreate 触发（executePatch/enable/disable 不查——disable 自锁）② disabled 不计入（filter `enabled===true`，与 L0 catalog `selectSkillsByQuota` 同口径）③ builtin 不计（resolver 排除 builtin scope，agent/用户物理不写 builtin 层）④ evolvable=false 计入但错误文案如实告知 `(note: X non-evolvable skill(s) cannot be disabled)` ⑤ count+check+write 在 dir 级虚拟锁 `<scopeRoot>/.quota.lock` 内原子（防 TOCTOU race；嵌套 entry 外/dir 内无死锁）⑥ 内部 scope（`app|workspace|group`）经 `toExternalScope` 映射对外查 `quotas[extScope]`。
- **新增符号**：`skills/store-quota.ts`（`SkillStoreQuotas`/`DEFAULT_SKILL_STORE_QUOTAS`/`resolveSkillStoreQuotas`/`countActiveSkillsInScope`/`checkSkillStoreQuota`）+ `skills/policy.ts` `SkillQuotaExceededError`。`executeCreate` 末参 `appConfig: AppConfigService|null=null`（null 不查向后兼容；生产经 `skill-manage.ts` 单 caller 注入 `ctx.config.appConfig`）。
- **app_config §3.15 同步**：存储侧 `resolveSkillStoreQuotas` 读同组 key 同默认值（注入配额与存储硬限共用），概念解耦独立 type。
- **存量不追溯**：现存超限 skill 不强制清理，靠硬拦截驱动收敛。
- 详情：`specs/tech/version_logs/v0.0.247/change_plan.md`（skill 子系统）+ `specs/prd/overall/14-prompt-quality-governance.md §14.2.5`。

## 2026-08-02 · v0.0.238 注入分层配额 + builtin 不计 + 写侧 group 暴露 + description ≤50 硬检查

- `skill_definition.md §3` 注入配额：从「system→user→agent 跨组连续取 maxN=50」改为**按物理层归组分层配额**（workspace→session ≤20 / group→group ≤30 / app→global ≤50 / **builtin 恒全量殿后不计配额**）；catalog 序改 workspace→group→app→builtin（近者优先，修「方向反」）；层内 user→agent + updatedAt 倒序 + name 升序不变。
- `skill_definition.md §2` description 上限 1024 → **≤50 字符**（仅 agent 写侧 executeCreate/executePatch 硬检查；UI 市场安装路径 executeMarketInstall 直写不受影响——第三方 description 是源数据，T1 整理负责修低质）。
- `skill_manage_tool.md §2` scope 对外加 `'group'`（暴露 squad 团队层，group→groupSkillRoot(groupWsDir)）；**scope 必填无默认 + 按 biz 校验**（create/patch/disable/enable；可用表来自 `biz-scope-rules.ts`；studio group 与 workspace 物理同址）；read/list 保持现状。UI HTTP 端点仍用 app/workspace（OUT，后续一致性项）。
- `skill_manage_tool.md §11` 路由提示词 Step 2 重写（scope 必填 + 全 biz 静态可用表）。
- app_config：`maxSkillInject` 语义从「三源总量」转为「global 层配额」；新增 `maxSkillInjectGroup`(30)/`maxSkillInjectSession`(20)。
- `skill_definition.md §2` 注入侧 `SkillRow` 内部 `group` 字段重命名为 `origin`（'system' 值退役，仅 `'user'|'agent'`）；builtin 的「恒全量殿后」改由 `injectLayerOf(scope)` 映射到独立 inject layer 处理（不经 origin 分组）。私有 interface 未 export，不影响对外契约。

详情：`specs/tech/version_logs/v0.0.238/change_plan.md`（D-E 节）+ `specs/prd/overall/14-prompt-quality-governance.md` §14.2.3/§14.2.4。

## 2026-08-01 · v0.0.232 skills L0 来源层标注 + squad workspace/group 层同址说明

- **`[P0]skill_definition.md` §3**：L0 行格式加 `[scope=builtin|app|workspace|group]` 来源层标注（底层 SkillScope 原值，不做对外映射；路径不逐行重复，由 agent_profile c) 条统一承担）。
- **`[P0]skill_definition.md` §4.1**：squad 场景 workspace 层与 group 层同址（workspaceDir=squads/{sid}）——同目录双扫幂等，entry 以 `scope='group'` 生效，无 resolver 代码变更。
- 详情：`specs/tech/version_logs/v0.0.232/change_plan.md`


## 2026-07-29 · v0.0.214 skill 单文件读写原语抽出共用（file-io.ts）

- **`[P0]skill_architecture.md §2`** + **`index.md` 对外协作点**：新增模块 `skills/file-io.ts` = skill 单文件读写原语唯一权威（越界守卫 / 二进制识别 / 256KB 截断 / 只覆写已存在文本文件）；`handlers/skill.ts handleFile` 改 delegate（`GET /skill/:name/file` 对外契约逐字节不变），academy 版本工作区 skill 文件端点（`api 18-academy §1.11`）复用同一原语 → 两域响应 shape 天然一致。
- **`specs/api/overall/06-skill.md §8`**：`SkillEntry` 既有漂移订正到代码实际（scope 四层、`source: 'user'|'agent'`、`mutable`/`mutableLocked` → 单维度 `evolvable`、补 `updatedAt` + 市场来源三字段）；§12.5 两条已失实的漂移记录删除。

## 2026-07-28 · v0.0.208 academy 板块整体删除（影响：group scope 去 classroomId 维度）

- **`[P0]skill_definition.md §4.1`** + **`[P0]skill_architecture.md §4`** + **`index.md` 原则 3**：group 层 ws 路径仅 squad（去 classroom 选项）；`resolveGroupWsDir(dataDir, {squadId?})` 去 classroomId；caller（handlers/session-config.ts）仅 studio session 传 groupDir。

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-26 · v0.0.205.t2_cons（squad→group 改名 + .rocky 收口 + GET /skill sessionId 参数）

- `index.md` ④ 原则 3 改写：`SkillScope` `'squad'`→`'group'`（group=squad 或 classroom 团队 ws，`<groupWs>/.rocky/skills/`；`.rocky_squad/skills/` 路径废止，存量 squad 由 MigrationManager `squad-rocky-dir` 平移）；resolver 参数 `squadDir`→`groupDir`；academy coach 经 `sessionContext.classroomId` 派生 groupDir 获得 classroom group 层；`keepStudioSkill` group 层恒保留（对齐 R2 workspace 层语义）。
- `GET /skill` 加 query `?sessionId=`（handler 经 sessionStore 解析 workspace + groupDir，与 `?workspace=` 并存 sessionId 优先）——chat 悬浮菜单 skills 入口数据源（前端按 scope 分 session/group/global 三 tab，对外三层映射见原则 3）。
- scope 三层用户视角定稿：session=workspace 层 / group=group 层 / global=builtin+app 层。

详情：`specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md`

## 2026-07-22 · v0.0.190（AT 去 record/replay — skills_sh 出站还原纯 proxyFetch）

- **`[P1]skill_market.md` §5 impl 描述 + §6 边界表删 `pickWebFetch ?? proxyFetch` / record-replay 行**：AT record/replay 机制整体删除（见 `../../testing/at-framework.md` §5），`skills_sh/skills-sh-provider.ts` 出站 fetch 还原为直接 `proxyFetch`（统一代理层）。spec 对齐代码。
- **代码-spec 一致核实（doc-modifier 阶段 5）**：`app/plugins/builtins/skills_sh/skills-sh-provider.ts` `import { proxyFetch }` 直接调用，无 pickWebFetch 残留。无偏离。

## 2026-07-17 · v0.0.167.skill_market_ui（skill 市场 tab + 已安装来源标记 + 同源/可更新态）

- **前端市场 tab**（在 v0.0.166 后端上建 UI）：`page-skill` 加 `market` tab 分支渲染 `<SectionSkillMarket>`；新增 `section-skill-market.tsx`（挂载即 capability negotiation，503→noProvider 空态；search + 结果网格；能力门控只渲染 name/ref/installs）+ `component-market-item.tsx`（结果卡，3 态 installable/installing/installed）+ `component-market-detail-modal.tsx`（详情弹窗，getDetail 取 readme+file 列表，惰性 `detail.hash!==installedHash` 判可更新，更新走 `installMarketSkill(ref,{overwrite:true})`）+ 纯函数 `market-status.ts`（`deriveMarketStatus`）。
- **已安装来源标记**：`component-skill-item` 据 `marketRef` 渲染「市场/本地」来源徽标（testid `skill-item-{id}-source`）；SkillItem props 加 `marketRef?`/`marketSource?`。
- **后端安装元数据（少量增量）**：`installer-core.ts` `SkillGovernanceOverride` +`marketRef`/`marketSource`/`installedHash`，`InstallParams` +`overwrite?`；`applyGovernance` 写 3 个 frontmatter 键（`market_ref`/`market_source`/`installed_hash`）；新增 `readInstalledMarketRef()` helper；`finalizeStagedSkill` 冲突分支加**仅同源**覆盖守卫（读磁盘 frontmatter 比对，不信前端，MUST NOT 覆盖本地/异源同名）；`stageAndInstallFiles` 加第 4 参 market metadata。`types.ts` `SkillEntry` +3 字段；`resolver.ts parseSkillDir` 读回。
- **可更新态惰性判定（选项 a）**：`skill-market/types.ts SkillMarketDetail` +`hash?`+`files?`；`skills-sh-provider.ts getDetail` 从已取文件设 `hash`（零新增端点/请求）；`SkillEntry` 暴露 `installedHash` 给前端比对。
- **API 客户端**：`api-client.ts` 镜像 SkillEntry + `MarketCapabilities`/`MarketItem`/`MarketDetail` 类型 + `getMarketCapabilities`/`searchMarket`/`getMarketDetail`/`installMarketSkill` 函数。
- **i18n**：`skill.json` zh-CN + en 加市场相关 key。**spec↔code 漂移记录**：`api-client.ts SkillEntry.scope` 未含 `'squad'`（本版本不改，非本版本范围）。
- **配套**：`index.md` ④ 加原则 15 + `[P1]skill_market.md §7.1/§9/§12` 更新 + `[P0]skill_definition.md §2/§6.3`（3 个新 frontmatter 字段）+ 新增 4 份 `specs/ui/components/skill-page/` 组件 spec。
- **[doc-modifier 阶段 5 同步]**：`specs/api/overall/06-skill.md` +§12 `/skills/market/*`（capabilities/search/detail/install 契约，doc-sync 待办#1，补 overall 层权威）；`specs/prd/overall/06-skill.md` +§6.2.1b 市场 tab + 来源徽标 + 路径 H（原 market non-goal 标交付）；ui 组件 spec 对齐实现偏离（detail-modal `itemRef` 非 `ref`/额外 `market-detail-updatable-badge` testid/readme 纯文本 `<pre>`；skill-item testid `{id}→name`）。记录漂移：api-client `SkillEntry.scope` 缺 `'squad'`（doc-sync 待办#2，本版不改）。代码==spec 核对结论：全一致，无 bug 级不一致。

详情：`specs/tech/version_logs/v0.0.167.skill_market_ui/change_plan.md`

## 2026-07-17 · v0.0.166.skill_market（skill 市场后端 — SkillMarketProvider 协议 + exclusive EP + capability negotiation）

- **新增 `[P1]skill_market.md`**：SkillMarketProvider 协议（`id`/`label`/`capabilities`/`isAvailable`/`search`/`getDetail`/**`fetchSkillFiles`**，凭证走运行时 cfg 入参，对齐 web_search v0.0.72）+ `skill_market_provider` **exclusive** 扩展点（范式抄 `session_store`，非 web_search list）+ **capability negotiation 三层字段模型**（通用核心 **ref/name 必有 + description 可选** + 可选能力门控结果字段 + 可选能力门控参数，换源零改动）。
- **install = provider 取文件 + installer source-无关核心落盘**：`provider.fetchSkillFiles(ref)` → skills.sh 走 `GET /api/download/{owner}/{repo}/{slug}`（官方 CLI `skills add` 同源，匿名 200，精确内联单 skill 文件）→ `installer.stageAndInstallFiles(files,…)` 抽 source-无关落盘核心（staging→校验→原子 rename，复用现有 assertWithinTmp/locateSkillRoot/parseSkillDir）→ app scope；治理 `evolvable=false` + `productionMethod=download`。**不走 codeload zipball / git 二进制 / adm-zip**（adm-zip 仅 multipart 上传路径保留）。
- **skills.sh 首个 source impl**：builtin plugin `app/plugins/builtins/skills_sh/`（`skill_market_provider` exclusive impl），走 proxyFetch 调 `GET /api/search?q=[&owner=]`（据实端点，**非** `/api/v1/skills`）+ `/api/download`；capabilities 据实收窄 `{stats:['installs']}`（无 stars/categories/sorts）；全端点匿名可用，token 可选（app_config `skill_market` group）。
- **能力落地**：`skill-manage` tool 加 `search`/`install` action（因 `skill-manage.ts` 338 行超 300 → 拆 `skill-manage-actions.ts` + 新 `tools/skill-market/{types,resolve,actions}.ts`）+ `/skills/market/{capabilities,search,detail,install}` HTTP 端点（misc-routes dispatch，`/skills/`(复数) 不撞现有 `/skill/`）。
- **配套**：`index.md` ④ 加原则 14 + ⑤ 导航行；app_config 新增 `skill_market` group（credentials only）；scopes/default.yaml 加 `skill-market` group（selected: skills_sh）；groups.json 加 `skill-market` group；plugin-config i18n 加 EP/group/plugin MSG 条目。本版本 = UT only（免 AT）。

详情：`specs/tech/version_logs/v0.0.166.skill_market/change_plan.md`

## 2026-07-17 · v0.0.164.memory_opt（skill resolver 加 squad workspace 目录源 — 4 层合并）

- **`[P0]skill_definition.md §4`**：内部 `SkillScope` type 从 `builtin|app|workspace` 扩为 `builtin|app|workspace|squad`（4 值）；对外 `skill_manage`/`skill` 工具 scope enum **不改**（仍 `global|session|all`，UI 零暴露——squad skill 靠资源位置进入，非 UI 选 metadata）。§4.1 双层合并 → 四层合并：**squad > workspace > app > builtin**（squad 最贴当前 squad 任务）。
- **skill resolver（`app/server/src/skills/resolver.ts`）**：新增 `squadSkillRoot(dataDir, squadId)` helper（返 `<dataDir>/squads/<squadId>/.rocky_squad/skills/`，对齐既有 squad 内部约定 `.rocky_squad/` 命名空间 + 与 squad memory 路径心智对称）；`SkillResolver.resolve/resolveAll/lookup` 签名末位加可选 `squadDir?: string`（squadDir=squad 根路径，由 caller 从 studioContext.squadId 拼），omit 保持后向兼容（等价既有三层扫描）。
- **`handlers/session-config.ts`**：`SkillResolver.resolve(...)` 调用点追加 squadDir 参数：`isStudio && studioContext?.squadId ? join(deps.dataDir, 'squads', studioContext.squadId) : undefined`（studio session 有 squadId 才传，非 studio/无 squadId 均 undefined）。studio overlay filter 逻辑不动。
- **L0 catalog 分组暂不改**：skill 侧 L0 分组当前 3 类（system/user/agent），squad skill 归 user 组（与 workspace skill 同为「用户/项目资产」语义无冲突）。PRD 未要求，避免过度设计。
- **`routing_decision.md`** 同步加 project type 澄清 + scope 加 squad 规则（三处共享单一源，skill_manage description 自动同步生效）。

详情：`specs/tech/version_logs/v0.0.164.memory_opt/change_log.md` + `change_plan.md`

## 2026-07-15 · v0.0.149.memory_opt（skill frontmatter 加 updatedAt + L0 注入分组配额）

- **`[P0]skill_definition.md §2`**：frontmatter 新增 `updatedAt:ISO`（组内排序依据）；skill_manage create/patch + UI governance PATCH 刷新 updatedAt=now；builtin 在源 frontmatter 带固定值；缺 updatedAt（legacy）→ 排序 epoch0 组内末，tiebreak name 升序。无 skill migration（文件型，缺失仅排末）。
- **`[P0]skill_definition.md` L0 注入**：skills mapper（`prompt/skills.ts`）加「三类分组（system→user→agent）+ 组内 updatedAt 倒序 + 总量上限前 N（默认50）」。**spec↔code 漂移**：`SkillEntry.source` enum 无 'system'（builtin 落 source='user' fallback），分组键派生 = `scope==='builtin'→system / source==='agent'→agent / else user`（必看 scope，不得只读 source）。
- **配额源**：`app_config` 新 group `session`（maxSkillInject，缺失回退50）。skill=stable tier，数量变破 prompt cache（预期内）。

详情：`specs/tech/version_logs/v0.0.149.memory_opt/change_plan.md`

## 2026-07-10 · v0.0.112（scope 对外统一 global/session + 默认 global + 路由提示词）

- **`[P0]skill_manage_tool.md §2`**：scope 对外统一 `global`/`session`（`list` 含 `all`），**可选、默认 global**（订正原「必填」spec 落后——代码 `parseNameScope` 非 workspace 即 app 已默认 global）；映射表（global↔app / session↔workspace / builtin 回显→global）。§2.1 消歧：skill `session`=项目级 workspace（**非单会话私有**，须写进 description）。§11 路由提示词（ROUTING_DECISION_PROMPT 单一常量三处同源）。
- **`[P0]skill_definition.md §4`** + **`[P0]skill_architecture.md §3`**：scope 对外命名映射 + session=项目级消歧注记；底层 SkillScope/存储路径不变。
- **bounded 说明**：本版本仅统一 `skill_manage`/`skill` 工具 input/output；skill UI HTTP（06/06a）+ 管理页仍 app/workspace（open 一致性项）。

详情：`specs/tech/version_logs/v0.0.112.memory/change_log.md`

## 2026-07-03 · v0.0.55（evolvable 改名 + 删 mutableLocked）

- `[P0]skill_definition.md §2/§6/§8`：删 `mutableLocked` 维度（§6.2/§6.3 表/§6.4/§8 重写）；`mutable → evolvable`（frontmatter + §6.1 + 默认值表 + 创建规则）；默认值表更新（系统内置 evolvable=false 但不再「locked」）。
- `[P0]skill_manage_tool.md §2-§4/§8`：patch payload 不含 evolvable；create 注入 `evolvable:true`（删 mutableLocked）；mutable 强制文案 → evolvable 强制；SkillManageMeta 字段改名。
- `index.md`：④ 第 8/11 条改写（mutable → evolvable + 删 mutableLocked 双维度 → 单维度）；⑤ 导航表同步。
- 实现层（task）：`governance.ts` body.evolvable + 删 step3 mutableLocked 检查 + 函数名 `governSkillEvolvable`；`skill-manage.ts` create 注入字段改名；`types.ts` SkillEntry 改名 + 删 mutableLocked；`skills.ts` prompt `[evolvable=*]` 标记。

详情：`specs/tech/version_logs/v0.0.55.memory_ui_session_lock/change_log.md`

## 2026-07-03 · v0.0.51 实现完成（long term memory — skill_manage + governance + L0 mutable 标记）

- `skill_manage` 工具落地（`app/server/src/tools/skill-manage.ts`，6 action 全实现：create / patch / disable / enable / list 含 disabled / read 含 disabled）。create 自动注入 4 治理字段（`{source:'agent', production_method:'consolidation', mutable:true, mutableLocked:false}`）+ per-file 锁串行化（`withFileLock`）+ mutable 强制（false 拒绝 patch/disable/enable）+ payload 不含 mutable/mutableLocked（agent 路径无视 mutableLocked）+ atomicWrite 落盘。
- Governance service 落地（`app/server/src/skills/governance.ts`）：PATCH `/skill/:name/governance` 端点 + service 层强制（`mutableLocked=true` → 403）+ 外科式替换 frontmatter `mutable` 行（保留其他字段字节序）+ per-file 锁。
- L0 catalog `[mutable=true|false]` 标记落地（`app/plugins/builtins/rocky_context/prompt/skills.ts`）：每条 enabled skill 在 L0 带 mutable 标记，LLM 知晓哪些可被 skill_manage 改。
- TOOL_POLICY bound 落地（`app/server/src/agent/tool-policy.ts`）：playground-rocky / studio-leader / studio-mate 各加 `skill_manage` + `memory_manage`；subagent / studio-squad 不加（避免派生递归）。
- 验证：UT 4106 passed；AT 6 case PASS（skill_manage create/patch/mutable_enforce + governance 200/403）；post_compact 走 UT 覆盖。
- 各 detail 文件加「实现落点」注记；index.md 加「实现状态 v0.0.51 已实现」callout；`skill_definition.md §1` 「不实现 agent 写 skill」改述为「v0.0.51 已实现 skill_manage」。

详情：`specs/tech/version_logs/v0.0.51.long_term_memory/change_log.md`（§实现完成段）

## 2026-07-03 · v0.0.51 v2（long term memory — 双维度治理 + 并发写锁）

- `skill_definition.md §2/§6/§8`：新增 `mutableLocked` 字段（维度 B：UI 可改性）+ 默认值表（系统内置 `mutableLocked=true`，其余 `false`）+ 创建时写入规则。§6 重写为「双维度治理模型」（维度 A `mutable`=agent 可改性 / 维度 B `mutableLocked`=UI 可改性，正交分离）。§8 恢复并细化「UI 改 mutable」——UI 默认能改 mutable（用户资产控制权），但 `mutableLocked=true` 时拒绝；UI 走独立 HTTP 路径，不经 `skill_manage` 工具。
- `skill_manage_tool.md §4`：mutable 强制规则补充——agent 工具完全无视 `mutableLocked`（agent 永远不能改 mutable）；UI 改 mutable 走另一路径（SkillsService HTTP 端点）。`§7`：新增 §7.1 注册范围确认（所有 agent）+ §7.2 并发写锁（per-file 文件锁序列化，保证跨 agent 并发写不撕裂 SKILL.md；读不持锁）。
- `index.md`：① 核心概念表新增「治理双维度」行；② 边界更新（UI 改 mutable 路径 + 写操作文件锁）；④ 新增 2 条原则（双维度治理 + 写操作原子串行化）。

详情：`specs/tech/version_logs/v0.0.51.long_term_memory/change_log.md`（§v2 修订段）

## 2026-07-02 · v0.0.51（long term memory — skill_manage 工具 spec）

- 新增 `[P0]skill_manage_tool.md`：skill_manage 工具（create/patch/disable/enable/list/read）接口定义。不可 delete（用 disable 替代）。list 含 disabled（防创建撞车重复 skill）。patch/disable/enable 受 mutable 强制（false 拒绝）。被动工具注册给 playground-rocky/studio-leader/studio-mate（依赖 v0.0.48 tool_list merge）。
- `skill_definition.md §2/§6`：mutable 字段从「仅记录不强制」改为「强制执行」。mutable=false 拒绝 patch/disable/enable；mutable 字段本身不可被 agent 修改。§8 移除「skill 管理界面改 mutable」待定项（已决策 agent 不可改 mutable）。
- `skill_tool.md §1/§6/§7`：明确 skill 读工具只读 enabled skill；skill_manage.read 才能读 disabled skill 全文。§6 从 roadmap 改为「已设计」。
- `index.md`：① 从「agent 写技能属 roadmap」改为 skill_manage 工具已设计；② 边界更新；④ 新增 3 条 skill_manage 核心原则（mutable 强制 / 不可 delete / list 含 disabled）；⑤ 导航新增 skill_manage_tool.md。

详情：`specs/tech/version_logs/v0.0.51.long_term_memory/change_log.md`

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`；`overview.md` 按类拆流并入 index 后归档到 `soft_deleted/`。
- 全部 3 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理 inline `[v0.0.21]` / `> version:` blockquote / 尾部 `## N. 版本` 段噪声，迁移到 frontmatter `since` 或本 log。

## 2026-06-25 · v0.0.21（最小可用 skill 子系统）

- 定位改为「最小可用 skill 子系统」：UI 管理（install/enable/delete/preview）+ skill 读工具 + system prompt L0 注入；agent 写技能移至 roadmap。
- 存储：废弃 Claude Code 的 `.claude/skills/` 约定，改 rocky_agent 原生双层——app 级 `<dataDir>/skills/` + workspace 级 `<workspace>/.rocky/skills/`。
- agent 工具从 `skill_manage`（create/patch/edit/archive/list）改为纯读 `skill`（input name → SKILL.md 全文 + skillDir；无 list，L0 常驻 prompt）。
- 治理字段（source/production_method/mutable）保留在 frontmatter 但**仅记录不强制**（无 agent 写入路径，无强制对象）。
- 模块落地：`skills/{resolver,installer,enabled-store,tree,types}.ts` + `handlers/skill.ts` + `tools/skill.ts` + `prompt/skills.ts`（mapper 填肉）。
- enabled 状态用 `app_config skill_state` group（复用 AppConfigService）；fallback enabled=true。
- SessionConfig 加 `skills?: SkillCatalog`；`buildSessionConfigFromDeps` 末尾 resolve 注入（仅 enabled 项）。
- zip 解压用 `adm-zip`（同步 API + 纯 JS + bun 兼容好）；frontmatter 解析用 `gray-matter`。
- 测试调试端点 `GET /session/:id/debug/system-prompt`（仅 test 环境开放，AT 黑盒验 skill L0 注入）。

详情：`specs/tech/version_logs/v0.0.21/change_log.md`
