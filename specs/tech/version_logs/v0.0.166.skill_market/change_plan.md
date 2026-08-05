# v0.0.166.skill_market 变更计划书 — Skill 市场后端（SkillMarketProvider 协议 + exclusive EP + capability negotiation + skills.sh source）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder 不改本文件；事后偏差写进 `change_log.md`。
> 概念权威：`specs/tech/agent/skills/[P1]skill_market.md`（协议 / EP / capability negotiation / install 范式 / skills.sh impl / HTTP 端点 / 配套）。
> 本版本无 PRD（用户可感知面在后续 UI 版本；本版本 = 后端能力 + 接口）。测试 = **UT only（免 AT，用户裁决）**。
> 行 = 一个函数/符号；列 = 模块 / 文件 / 函数·符号 / 类型 / 变更内容 / 约束 / 参考 / 影响行。

## 0. 架构师技术决策（落地开放点）

### A. exclusive 路由（非 web_search 的 type 路由）
`skill_market_provider` = exclusive EP。生效 impl 由 scope 配置 `selected: skills_sh` 决定（`default.yaml`）；`resolveSkillMarketProvider` 取 `getExtensionImpls(SkillMarketProviderPoint)[0]`（≤1 active），凭证 map 按 `provider.id` 索引（无 type 字段）。app_config `skill_market` group **只存 credentials**（token 可选），不存 type。

### B. install 实现方式（skills.sh /api/download files，非 zipball）— **用户裁决**
install = **provider 取文件 + installer source-无关核心落盘**两段：
- **取文件**（source-specific）：`provider.fetchSkillFiles(ref, cfg, signal)` → skills.sh 走 `GET https://skills.sh/api/download/{owner}/{repo}/{slug}`（官方 CLI `skills add` 同源，匿名 200，响应 `{ files:[{path,contents}], hash }` 精确内联单 skill 全部文件）。**不走 GitHub codeload zipball / 不用 git 二进制**（zipball 下整仓再按 skillId 定位子目录对 monorepo 如 awesome-copilot 太脆弱）。
- **落盘**（source-无关）：`installer.stageAndInstallFiles(files, dataDir, params)` → `mkdtemp` staging（`assertWithinTmp` 防遍历）写 files → `finalizeStagedSkill`（locate/parseSkillDir 校验/体积/冲突/原子 rename/重读，从现有 `installSkill` 抽出）→ 落 **app scope**（`<dataDir>/skills/`），治理 `evolvable=false` + `productionMethod='download'`。
- installer **不再需要 adm-zip / zipball / codeload**（adm-zip 仅 multipart 上传路径保留）。出站走 `proxyFetch`（勿新造 fetch）。ref 形状校验/防注入归 **provider**（ref 格式 provider 定义）。

### C. 文件拆分（skill-manage.ts 338 行超 300）
新增 `skill-manage-actions.ts`（迁现有 5 execute + helper）+ 新 `tools/skill-market/{types,resolve,actions}.ts`（市场协议/路由/action）。`skill-manage.ts` 瘦身为 tool 定义 + dispatch + scope 词汇导出（≤150 行）。

### D. capabilities = 静态属性（非方法）
`SkillMarketProvider.capabilities: SkillMarketCapabilities`（readonly 属性），impl 硬编码声明；上层先读 capabilities 再渲染/传参（三层字段模型，spec §3）。

## 1. 变更清单（method 级 — 行 = 函数/符号）

### 模块 ① 扩展点注册

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ①EP | app/server/src/plugin/extension-point.ts | SkillMarketProviderPoint | 新增 | 新 ExtensionPoint 常量：`id:'skill_market_provider'` / `cardinality:'exclusive'` / `description:'__MSG_extpoint.skill_market_provider.description__'` | MUST cardinality='exclusive'（抄 SessionStorePoint L176，**非** WebSearchProviderPoint 的 list） | skill_market §4；extension-point.ts L176 SessionStorePoint | +7 |
| ①EP | app/server/src/plugin/extension-point.ts | BUILTIN_EXTENSION_POINTS | 修改 | 数组 append `SkillMarketProviderPoint` | MUST append（不删既有） | extension-point.ts L242-265 | +2 |

### 模块 ② SkillMarketProvider 协议类型

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ②协议 | app/server/src/tools/skill-market/types.ts | SkillMarketCapabilities | 新增 | interface：`categories?:string[]\|false` / `collections?:string[]` / `sorts?:SkillSortMode[]` / `stats?:('installs'\|'stars')[]`（据实：skills.sh 仅 stats:['installs']，其余不声明） | 自描述能力，capability negotiation 核心 | skill_market §2/§3 | 新文件 |
| ②协议 | app/server/src/tools/skill-market/types.ts | SkillSortMode | 新增 | union：`'relevance'\|'trending'\|'hot'\|'updated'\|'stars'\|'installs'` | — | skill_market §2 | 新文件 |
| ②协议 | app/server/src/tools/skill-market/types.ts | SkillMarketItem | 新增 | 通用核心 `ref/name` 必有 + `description?`（可选，search 不返回、getDetail 补填）+ 可选门控 `category/tags/collection/version/updatedAt/stats/verified/official` | MUST ref/name 非可选；description 及其余可选；缺字段=undefined 不造假 | skill_market §2/§3 | 新文件 |
| ②协议 | app/server/src/tools/skill-market/types.ts | SkillMarketSearchOptions | 新增 | `owner?/category?/collection?/sort?/limit?/cursor?`（skills.sh 仅认 owner/limit） | provider 忽略不支持项 | skill_market §2/§3 | 新文件 |
| ②协议 | app/server/src/tools/skill-market/types.ts | SkillMarketSearchResult | 新增 | `provider/query/count/tookMs/items[]/nextCursor?` | count=items.length；skills.sh 无 nextCursor | skill_market §2；对齐 WebSearchResult | 新文件 |
| ②协议 | app/server/src/tools/skill-market/types.ts | SkillMarketDetail | 新增 | extends SkillMarketItem + `readme?/repository?/securityAudit?` | skills.sh 无独立详情端点（getDetail 走 fetchSkillFiles+frontmatter） | skill_market §2/§8 | 新文件 |
| ②协议 | app/server/src/tools/skill-market/types.ts | FetchedSkillFiles | 新增 | `{ files: {path:string;contents:string}[]; hash?:string }`——fetchSkillFiles 返回，喂 installer source-无关核心 | contents=utf-8 文本；path=相对 skill 根 | skill_market §2/§7；skills.sh /api/download | 新文件 |
| ②协议 | app/server/src/tools/skill-market/types.ts | SkillMarketCfg | 新增 | `Record<string,unknown>` 不透明 map（skills.sh 认可选 cfg.token） | 凭证不进协议 | skill_market §2；web-search/types.ts L50 | 新文件 |
| ②协议 | app/server/src/tools/skill-market/types.ts | SkillMarketProvider | 新增 | `id/label/readonly capabilities/isAvailable(cfg)/search(q,opts,cfg,signal)/getDetail(ref,cfg,signal)/fetchSkillFiles(ref,cfg,signal)` | MUST isAvailable 禁 I/O；不定义 install（fetchSkillFiles 只取文件不落盘） | skill_market §2；web-search/types.ts L57 WebSearchProvider | 新文件 |

### 模块 ③ skills_sh builtin plugin impl

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ③impl | app/plugins/builtins/skills_sh/plugin.json | (manifest) | 新增 | `id:'skills_sh'` + 1 extImpl（`implId:'skills_sh'`,`point:'skill_market_provider'`,`impl:'./skills-sh-provider.ts'`,`description:__MSG__`） | MUST 目录名==id；无 configSchema（凭证不进 manifest） | builtin_plugins_directory §2.2；zhipu_web_search/plugin.json | 新文件 |
| ③impl | app/plugins/builtins/skills_sh/skills-sh-provider.ts | SkillsShProvider (default class) | 新增 | implements SkillMarketProvider；构造器 `(implId,_cfg={})` 存 `this.id=implId` | MUST default export class；凭证不从构造器 cfg 取 | skill_market §8；zhipu-api-provider.ts L78 | 新文件 |
| ③impl | app/plugins/builtins/skills_sh/skills-sh-provider.ts | capabilities (属性) | 新增 | 据实收窄：`{ stats:['installs'] }`；`categories`/`collections`/`sorts` 均**不声明**（skills.sh 无这些维度） | 只声明实测支持项；无 stars | skill_market §3/§8 | 新文件 |
| ③impl | app/plugins/builtins/skills_sh/skills-sh-provider.ts | isAvailable(cfg) | 新增 | 恒 `true`（全端点匿名 200，无需 token；cfg.token 可选仅未来提额度）；禁 I/O | MUST 禁 I/O | skill_market §5/§8；web_search_tool §5.3 | 新文件 |
| ③impl | app/plugins/builtins/skills_sh/skills-sh-provider.ts | search(query,opts,cfg,signal) | 新增 | `pickWebFetch(getRegistry())??proxyFetch` GET `https://skills.sh/api/search?q={query}`（opts.owner→`&owner=`）→ 响应 `{query,searchType,skills[],count,duration_ms}` → mapSkillsShItems → SkillMarketSearchResult（tookMs=duration_ms） | MUST 走 proxyFetch（勿新造 fetch）；超时 30s；端点=/api/search（**非** /api/v1/skills） | skill_market §8；web_fetch/proxy.ts L138；record-replay-registry.ts pickWebFetch/getRegistry | 新文件 |
| ③impl | app/plugins/builtins/skills_sh/skills-sh-provider.ts | fetchSkillFiles(ref,cfg,signal) | 新增 | 拆 ref(`{source}/{skillId}`=owner/repo/slug 校验+防注入)→ `pickWebFetch??proxyFetch` GET `https://skills.sh/api/download/{owner}/{repo}/{slug}` → 响应 `{files:[{path,contents}],hash}` → FetchedSkillFiles | MUST 走 proxyFetch；ref 形状校验归本方法（provider 定义 ref 格式）；不落盘 | skill_market §7/§8；skills.sh /api/download | 新文件 |
| ③impl | app/plugins/builtins/skills_sh/skills-sh-provider.ts | getDetail(ref,cfg,signal) | 新增 | 无独立详情端点 → 调 fetchSkillFiles(ref) → 从 SKILL.md frontmatter 解析 name/description、正文作 readme → SkillMarketDetail | ref=provider 格式；复用 fetchSkillFiles | skill_market §8 | 新文件 |
| ③impl | app/plugins/builtins/skills_sh/skills-sh-provider.ts | mapSkillsShItems(skills) | 新增 | skills.sh `{id,skillId,name,installs,source}` → SkillMarketItem[]：`id→ref`,`name→name`,`installs→stats.installs`；description 留 undefined | 缺字段留 undefined 不造假；只填声明的门控字段 | skill_market §3/§8 | 新文件 |

### 模块 ④ skill-manage search/install action（含文件拆分）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ④tool | app/server/src/tools/skill-manage-actions.ts | executeCreate/executePatch/executeSetEnabled/executeList/executeRead + 私有 helper | 新增(迁移) | 从 skill-manage.ts 迁入现有 5 execute + `readSkillFile/getBool/toMeta/makeEnabledStore/scopeRootDir/parseNameScope/CREATE_GOVERNANCE/isValidName` | MUST 行为不变（纯迁移）；export 供 skill-manage.ts import | skill_manage_tool §9；skill-manage.ts L185-337 | 新文件 |
| ④tool | app/server/src/tools/skill-manage.ts | (5 execute + helper) | 删除 | 迁出到 skill-manage-actions.ts，改为 import | 迁移后本文件 ≤150 行 | 同上 | -180 |
| ④tool | app/server/src/tools/skill-manage.ts | skillManageTool.definition | 修改 | enum 加 `'search'`,`'install'`；description 加一句市场说明；inputSchema 加 `query/ref/owner/limit` 属性（skills.sh 不认 sort/category，可留通用属性但 impl 忽略） | MUST 保留原 6 action 语义不变 | skill-manage.ts L122-151 | +10 |
| ④tool | app/server/src/tools/skill-manage.ts | skillManageTool.run (switch) | 修改 | dispatch 加 `case 'search':→executeMarketSearch(input,ctx)` / `case 'install':→executeMarketInstall(input,ctx,dataDir,w)` | search/install 委派 skill-market/actions.ts | skill-manage.ts L159-167 | +2 |
| ④tool | app/server/src/tools/skill-market/actions.ts | executeMarketSearch(input,ctx) | 新增 | resolveSkillMarketProvider→isAvailable→provider.search→序列化 items markdown（ref/name + 声明支持维度 installs；description 缺不渲染）→ textResult | 无 active/不可用 → errorResult 不回退 | skill_market §5/§6；web-search/tool.ts run | 新文件 |
| ④tool | app/server/src/tools/skill-market/actions.ts | executeMarketInstall(input,ctx,dataDir,workdir) | 新增 | resolveSkillMarketProvider→`provider.fetchSkillFiles(ref)`→`installer.stageAndInstallFiles(files,dataDir,params)` → JSON SkillEntry | 无 active/不可用→error；ref 非法（provider 抛）→ 映射 error；install 落 app scope | skill_market §5/§6/§7 | 新文件 |
| ④tool | app/server/src/tools/skill-market/actions.ts | serializeMarketResult() | 新增 | SkillMarketSearchResult → markdown（对齐 web-search serializeResult；description 缺省略） | — | web-search/tool.ts L160 | 新文件 |

### 模块 ⑤ install 落地（installer 抽 source-无关核心 + files 版）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ⑤install | app/server/src/skills/installer.ts | finalizeStagedSkill(tmpRoot,dataDir,params) | 新增(抽取) | 从 `installSkill` 抽出「locateSkillRoot→parseSkillDir 校验→subDir/name 一致→体积→冲突→原子 rename→重读」为 source-无关落盘核心 | multipart 与 download 两路共用；语义不变 | installer.ts L98-137；skill_market §7 | +30 |
| ⑤install | app/server/src/skills/installer.ts | installSkill(form,dataDir,params) | 修改 | 保留 multipart 入口（collectFileParts+stageParts 含 .zip/.skill adm-zip 分支不动）；staging 完后改调 finalizeStagedSkill 复用核心（去重） | 行为不变（回归 UT 保）；adm-zip 仅此路保留 | installer.ts L74 | ~0 |
| ⑤install | app/server/src/skills/installer.ts | stageAndInstallFiles(files,dataDir,params) | 新增 | 入参 `files:{path,contents}[]`（provider 取好）→ mkdtemp staging → 逐个按 path 写盘（复用 assertWithinTmp）→ finalizeStagedSkill；落盘 entry `productionMethod='download'`+`evolvable=false` | MUST source-无关（不含 fetch/zipball/ref 解析）；path 安全靠 assertWithinTmp；不依赖 adm-zip | skill_market §7；installer.ts assertWithinTmp L192 | 新增 ~30 |

> **删除**：原草稿的 `installSkillFromRef`（codeload zipball 下载）+ `stageAndInstallZip` + `parseSkillRef`（installer 侧）**均不落地**——ref 拆解/校验归 provider.fetchSkillFiles（ref 格式 provider 定义），出站取文件归 provider，installer 只吃 files。`productionMethod:'download'` 已在 `SkillEntry.productionMethod` enum 内（types.ts L39，核对存在）。

### 模块 ⑥ /skills/market/* HTTP 端点

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ⑥http | app/server/src/handlers/skill-market.ts | handleSkillMarketRoute(req,method,path,url,appConfig,pluginManager,dataDir) | 新增 | dispatch `/skills/market/{capabilities,search,detail,install}`；resolve provider（handler 侧构造等价 ctx 或直接调 resolve helper） | 无 active provider → 503 | skill_market §9；handlers/skill.ts handleSkillRoute | 新文件 |
| ⑥http | app/server/src/handlers/skill-market.ts | handleMarketCapabilities() | 新增 | GET → `{id,label,capabilities}`（无 active→503） | — | skill_market §9 | 新文件 |
| ⑥http | app/server/src/handlers/skill-market.ts | handleMarketSearch(url) | 新增 | GET `?q&owner&limit&cursor` → provider.search → 200 JSON（skills.sh 仅认 q/owner/limit） | — | skill_market §9 | 新文件 |
| ⑥http | app/server/src/handlers/skill-market.ts | handleMarketDetail(url) | 新增 | GET `?ref=` → provider.getDetail → 200 JSON | ref 走 query（含 /） | skill_market §9 | 新文件 |
| ⑥http | app/server/src/handlers/skill-market.ts | handleMarketInstall(req,dataDir) | 新增 | POST body `{ref,scope?}` → resolve provider → `provider.fetchSkillFiles(ref)` → `installer.stageAndInstallFiles` → 202 SkillEntry | 复用 resolve + installer；InstallError→状态码映射 | skill_market §9；installer InstallError | 新文件 |
| ⑥http | app/server/src/tools/skill-market/resolve.ts | resolveSkillMarketProvider(ctx-like) | 新增 | 取 `getExtensionImpls(SkillMarketProviderPoint)[0]`（exclusive≤1）+ cfg=`appConfig.get('skill_market','default').credentials?[id]??{}` | tool/handler 共用；无 active→provider undefined | skill_market §5；web-search/tool.ts L127 resolveProvider | 新文件 |
| ⑥http | app/server/src/routes/misc-routes.ts | (dispatch block) | 修改 | 加分支 `if (path==='/skills/market' \|\| path.startsWith('/skills/market')) return handleSkillMarketRoute(...)` | MUST 放在现有 `/skill/*` 分支前后不冲突（`/skills/`复数≠`/skill/`单数）；传 bs.pluginManager | misc-routes.ts L167-170 | +5 |

### 模块 ⑦ groups.json + build-plugins + app_config schema + i18n 配套

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ⑦配套 | app/plugins/groups.json | groups[] | 修改 | append `{id:'skill-market',label:__MSG_group.skill_market.label__,description:__MSG__,extPoints:['skill_market_provider']}` | — | groups.json L45-56（web/vision 范式） | +6 |
| ⑦配套 | app/plugins/scopes/default.yaml | skill-market group block | 新增 | 加 `- id: skill-market` → `pointId: skill_market_provider` / `selected: skills_sh` / `impls:[skills_sh]` | MUST selected（exclusive 靠 selected 选源，抄 session_store L71-75） | default.yaml L71-75/L106-120 | +6 |
| ⑦配套 | app/plugins/scopes/forked.yaml | (skill_market) | 无变更 | forked 不加（旁路 run 不搜市场；exclusive 无 impl→getExtensionImpls 空，安全） | — | forked.yaml L80-84 | 0 |
| ⑦配套 | specs/tech/config/[P0]app_config.md | §3 group 集合 + §3.17 skill_market 组 | 修改(doc) | group 集合追加 `skill_market`；加 §3.17：单实例 key='default'，`data={credentials?:{[implId]:{token?}}}`（只放凭证，无 type） | doc-modifier 阶段 5 落定；本表记待办 | app_config.md §3.6 web_search 范式 | +新节 |
| ⑦配套 | app/web/src/i18n/locales/zh-CN/plugin-config.json | extpoint/group/plugin MSG | 修改 | 加 `extpoint.skill_market_provider.description` + `group.skill_market.{label,description}` + `plugin.builtin.skills_sh.{label,description,impl...}` | zh-CN + en-US 两套 | plugin-config.json L162-175（see_image 范式） | +多条 |
| ⑦配套 | app/web/src/i18n/locales/en-US/plugin-config.json | 同上 | 修改 | 同上英文 | — | 同上 | +多条 |
| ⑦配套 | scripts/build-plugins.ts | EXTERNALS / copyResources | 无变更(验证) | skills_sh 自动被扫描编译；deep import `@app/server`+`undici` 已在 EXTERNALS；无新第三方包 → 不改；仅验证产物校验通过 | 若引入新第三方包才需改 EXTERNALS | build-plugins.ts L30 EXTERNALS | 0 |

### 模块 ⑧ 关键 UT（本版本 = UT only，免 AT）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ⑧UT | app/server/src/tools/skill-market/*.test.ts | resolveSkillMarketProvider | 新增 | UT：无 active→undefined；有 active→取 [0]；cfg 按 id 取 credentials | 白盒 | skill_market §5 | 新文件 |
| ⑧UT | app/server/src/tools/skill-market/*.test.ts | executeMarketSearch/executeMarketInstall | 新增 | UT：stub provider→search 序列化；install = stub fetchSkillFiles 返回 files→stageAndInstallFiles 落盘；provider 抛 ref 非法→error | mock provider（不打真网） | skill_market §6/§7 | 新文件 |
| ⑧UT | app/server/src/skills/installer.test.ts | stageAndInstallFiles/finalizeStagedSkill | 新增 | UT：files:[{path,contents}]→写盘落盘（fixture files，含 SKILL.md）；冲突 409；path 遍历拒（assertWithinTmp）；productionMethod='download'+evolvable=false | 复用现有 installer UT 范式；multipart 回归不破 | skill_market §7 | +若干 |
| ⑧UT | app/plugins/builtins/skills_sh/*.test.ts | SkillsShProvider.search/fetchSkillFiles/mapSkillsShItems/capabilities | 新增 | UT：mock /api/search 响应→映射 SkillMarketItem（installs→stats，description undefined）；mock /api/download→FetchedSkillFiles；capabilities={stats:['installs']}；isAvailable 恒 true | mock proxyFetch/pickWebFetch | skill_market §8 | 新文件 |
| ⑧UT | app/server/src/plugin/*.test.ts | SkillMarketProviderPoint 注册 | 新增/修改 | UT：BUILTIN_EXTENSION_POINTS 含 skill_market_provider；cardinality='exclusive' | — | skill_market §4 | +若干 |

## 2. 不变量（code-reviewer 清单 G 查偏离）

1. `skill_market_provider` **MUST exclusive**（非 list）——resolve 取 `[0]`，不做 type 路由。
2. 协议 **MUST 不含 install**（install 的校验/落盘/治理是 installer source-无关核心，provider 无关）；但 provider **MUST 暴露 `fetchSkillFiles(ref,cfg,signal)`**（source-specific 取文件，不落盘）。凭证 **MUST 不进协议 / 不进 plugin manifest configSchema**（走运行时 cfg 入参）。
3. capability negotiation：核心 = `ref/name` 必有，`description` 可选（search 缺→undefined，getDetail 补填）；其余结果字段 provider **只填声明支持的**，参数 **只认声明支持的**（传不支持的忽略，不报错）；缺字段=undefined 不造假。
4. install 出站 **MUST 走 proxyFetch**（`provider.fetchSkillFiles` 内，勿新造 fetch）；走 skills.sh `/api/download`（**非 codeload zipball**）；落 **app scope** + `evolvable=false` + `productionMethod='download'`。installer 落盘核心 source-无关（不含 fetch/ref 解析）。
5. `skill-manage.ts` 拆分后 **MUST ≤300 行**（目标 ≤150）；现有 6 action 行为不变（回归 UT 保）。
6. `installSkill`（multipart）行为不变——抽取 `finalizeStagedSkill` 是纯去重，multipart 的 collectFileParts+stageParts（含 adm-zip）不动。
7. misc-routes `/skills/market` 分支不得撞现有 `/skill/*`（复数≠单数）。
