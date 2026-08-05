# v0.0.167 变更计划书 — Skill 入口市场 tab + 已安装来源标记 + 同源/可更新态

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 上游：PRD `specs/prd/version_logs/v0.0.167.skill_market_ui.md` + 后端契约 `specs/tech/agent/skills/[P1]skill_market.md`(v0.0.166) + `[P0]skill_definition.md`。

## §0 关键决策（架构裁定）

- **D-updatable = 方案 (a) getDetail 返回 hash + SkillEntry 暴露 installedHash，前端比对**（否决专用 compare 端点 (b)）。理由：`SkillsShProvider.getDetail` **内部已调 `fetchSkillFiles`**（`skills-sh-provider.ts:130`）→ hash 免费拿到；市场详情 modal 本就要调 `getDetail` → 拿 hash 后与已安装 skill 的 `installedHash` 本地比对，**零额外请求**，无需新端点。installedHash 是内容哈希（非敏感），暴露前端安全。惰性约束满足：列表阶段不比 hash（只 ref 精确匹配判「已安装」），仅详情/点检查更新时用 `getDetail.hash` vs `SkillEntry.installedHash`。
- **installedHash 暴露决策 = 暴露到前端**（`SkillEntry.installedHash`，随 list 返回）。配合 D-updatable(a) 让比对发生在前端，避免专用后端 compare 端点。
- **overwrite 守卫（correctness-critical 不变量）= 同源才覆盖**：`POST /skills/market/install` body 加 `overwrite?: boolean`。`finalizeStagedSkill` 遇同名冲突时——若 `overwrite=true` **且** 已存在目标 skill 的 frontmatter `market_ref` **精确等于**本次安装 ref（= governance.marketRef）→ 删旧目录后 rename 覆盖；否则（无 overwrite / 目标无 market_ref = 本地 skill / market_ref 不同 = 异源同名）→ 抛 `InstallError('conflict')`。**MUST NOT 覆盖本地或异源同名 skill**。守卫读的是**磁盘上已装 skill 的 frontmatter**，不信任前端传参。
- **来源元数据落 frontmatter**：install 落盘前经 `applyGovernance` 追加 `market_ref` / `market_source` / `installed_hash` 三个 frontmatter 键（与既有 `production_method:download` / `evolvable:false` 同一写入点）。legacy skill 无这些字段 → resolver 读为 undefined = 本地来源，不报错。
- **能力门控渲染**：市场 UI 先调 `/skills/market/capabilities`，仅渲染声明维度。skills.sh = `{stats:['installs']}` → 只渲染 name/ref/installs（+ 详情 description/readme）。**不做**多源侧栏/分类/排序/version/stars/加源（设计稿富余维度，见 PRD §7）。
- **文件体量护栏**：市场逻辑（capabilities/search/install/detail）落 `section-skill-market.tsx`，**不堆进 page-skill.tsx**（现 213 行）；page-skill 仅加 tab 项 + `tab==='market'` 分支渲染 `<SectionSkillMarket/>`（约 +30 行）。所有新文件 ≤300 行。

## §invariants（不可违反）

1. **overwrite 只覆盖同源**：existing.market_ref === 本次 ref 才删旧覆盖；否则 409。守卫以磁盘 frontmatter 为准。
2. **治理硬编码不变**：市场安装始终 `production_method='download'` + `evolvable=false`（v0.0.166 不变量），来源三字段是**追加**。
3. **multipart 上传路径零回归**：`installSkill`(multipart) 仍走 `finalizeStagedSkill` **不传 governance**（保留源 frontmatter，不写 market 字段、不启 overwrite 守卫）。
4. **能力门控**：UI 缺失维度不渲染、不造假、不报错（PRD §2 强制规则）。
5. **同源判定 = ref 精确匹配**：市场 item.ref === 已安装 SkillEntry.marketRef（非同名）。
6. **可更新判定惰性**：列表零额外请求（只 ref 匹配判已安装）；hash 比对仅详情/主动检查时。
7. **install 返回契约不变**：`POST /skills/market/install` 成功仍 202 `{ skill: SkillEntry }`（覆盖亦然）。

## 变更清单（8 列，行 = 一个函数/符号）

### 模块 A — backend install-core（app/server/src/skills/installer-core.ts）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| install-core | app/server/src/skills/installer-core.ts | `SkillGovernanceOverride` | 修改 | interface 追加 `marketRef?: string` / `marketSource?: string` / `installedHash?: string`（现有 productionMethod/evolvable 保留） | MUST 全为可选；multipart 不传 → 不写这些键 | PRD §6.1；skill_market §7 | +3 |
| install-core | app/server/src/skills/installer-core.ts | `InstallParams` | 修改 | 追加 `overwrite?: boolean`（默认 false=保持现 409 语义） | MUST 可选、默认 false | §0 overwrite 守卫；PRD §6.4 | +2 |
| install-core | app/server/src/skills/installer-core.ts | `applyGovernance()` | 修改 | 除 production_method/evolvable 外，`gov.marketRef→market_ref`、`gov.marketSource→market_source`、`gov.installedHash→installed_hash` 写入 frontmatter（各 undefined 则不写） | MUST 用 snake_case frontmatter 键（对齐 parseSkillDir 读侧）；读/解析失败静默跳过（不阻断安装，同现有） | installer-core.ts:241；skill_definition §2 | +6 |
| install-core | app/server/src/skills/installer-core.ts | `readInstalledMarketRef()` | 新增 | helper：读给定 SKILL.md 路径的 frontmatter `market_ref`（gray-matter），返回 string\|undefined；读/解析失败返 undefined。供 overwrite 守卫判同源 | MUST 只读不写；失败返 undefined 不抛 | §0 overwrite 守卫；invariant#1 | +14 |
| install-core | app/server/src/skills/installer-core.ts | `finalizeStagedSkill()` | 修改 | 冲突分支改造：`existsSync(target)` 时——若 `params.overwrite && governance?.marketRef && readInstalledMarketRef(join(target,'SKILL.md'))===governance.marketRef` → `rmSync(target,{recursive,force})` 后继续 rename；否则抛 `InstallError('conflict')`（含 `no overwrite`/`different source`/`local skill` 语义消息） | MUST NOT 覆盖 market_ref 不匹配或缺失的目标；守卫以磁盘 frontmatter 为准，不信前端 | installer-core.ts:124-128；invariant#1；PRD §6.4 | +12/-2 |
| install-core | app/server/src/skills/installer-core.ts | `stageAndInstallFiles()` | 修改 | 签名加第 4 参 `market?: { marketRef:string; marketSource:string; installedHash?:string }`；构造 governance = `{ productionMethod:'download', evolvable:false, ...market }` 传 finalize；`params.overwrite` 透传（已在 params）。无 market 参时行为等价现状（仍 download/evolvable=false） | MUST 治理 download/evolvable=false 硬编码保留（invariant#2）；MUST 把 market 三字段并入 governance | installer-core.ts:154-182；PRD §6.1 | +8/-4 |

### 模块 B — backend types + resolver（来源字段暴露）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| skills-types | app/server/src/skills/types.ts | `SkillEntry` | 修改 | 追加 `marketRef?: string` / `marketSource?: string` / `installedHash?: string`（治理字段区，注释说明来源锚点用途） | MUST 全可选；legacy/本地 skill 无 → undefined | PRD §6.2；skill_definition §2 | +6 |
| skills-resolver | app/server/src/skills/resolver.ts | `parseSkillDir()` | 修改 | frontmatter 读 `market_ref`/`market_source`/`installed_hash` → SkillEntry.marketRef/marketSource/installedHash（非 string → undefined），随现有 source/evolvable 一并 return | MUST 容忍缺失（不报错）；只读 string 标量 | resolver.ts:102-116；PRD §6.5 | +4 |

### 模块 C — backend market provider（getDetail 补 hash + 文件列表）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| market-types | app/server/src/tools/skill-market/types.ts | `SkillMarketDetail` | 修改 | interface 追加 `hash?: string`（当前内容哈希，供可更新比对）+ `files?: Array<{ path: string }>`（包含文件列表，仅路径不含内容） | MUST 全可选（能力门控）；files 仅 path 不回传 contents（省 payload） | §0 D-updatable(a)；PRD §3.1 详情 | +2 |
| market-provider | app/plugins/builtins/skills_sh/skills-sh-provider.ts | `SkillsShProvider.getDetail()` | 修改 | 返回对象追加 `hash: fetched.hash` + `files: fetched.files.map(f=>({path:f.path}))`（fetched 已在方法内取得，无新请求） | MUST NOT 新增网络请求（复用已 fetch 的 fetched）；缺 hash 则 undefined | skills-sh-provider.ts:124-142；§0 D-updatable(a) | +3 |

### 模块 D — backend handler + tool action（install 加 overwrite + 来源元数据）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| market-handler | app/server/src/handlers/skill-market.ts | `handleMarketInstall()` | 修改 | body 解析加 `overwrite`（bool）；调用改为 `stageAndInstallFiles(fetched.files, dataDir, { scope:'app', overwrite: body.overwrite===true }, { marketRef: ref, marketSource: provider.id, installedHash: fetched.hash })`；成功仍 202 `{skill}` | MUST 传 provider.id 作 marketSource + ref 作 marketRef + fetched.hash；conflict→409 经外层 catch 映射（invariant#7） | skill-market.ts:157-184；PRD §6.4；invariant#7 | +6/-2 |
| market-action | app/server/src/tools/skill-market/actions.ts | `executeMarketInstall()` | 修改 | `stageAndInstallFiles(fetched.files, dataDir, {scope:'app'}, { marketRef: ref, marketSource: provider.id, installedHash: fetched.hash })`（agent 路径同写来源元数据；overwrite 不开放给 agent → 省略/传 false） | MUST 写来源元数据保持与 HTTP 路径一致；agent 路径**不**开 overwrite（默认 409，避 agent 误覆盖） | actions.ts:58-92；PRD §6.1 | +4/-2 |

### 模块 E — api-client（前端市场 API + SkillEntry 镜像）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| api-client | app/web/src/lib/api-client.ts | `SkillEntry` | 修改 | 镜像后端追加 `marketRef?: string` / `marketSource?: string` / `installedHash?: string` | MUST 与后端 types.ts 字段名/可选性一致 | 模块 B；PRD §6.2 | +3 |
| api-client | app/web/src/lib/api-client.ts | `MarketCapabilities` | 新增 | type：`{ id:string; label:string; capabilities:{ stats?:('installs'\|'stars')[]; categories?:string[]\|false; collections?:string[]; sorts?:string[] } }`（镜像后端 capabilities） | MUST 全为可选门控字段 | skill_market §2/§9 | +7 |
| api-client | app/web/src/lib/api-client.ts | `MarketItem` | 新增 | type：`{ ref:string; name:string; description?:string; stats?:{installs?:number;stars?:number} }`（列表卡数据形，能力门控可选字段） | MUST ref/name 必有，其余可选 | skill_market §3 | +5 |
| api-client | app/web/src/lib/api-client.ts | `MarketDetail` | 新增 | type：MarketItem + `readme?:string; repository?:{url:string}; hash?:string; files?:{path:string}[]` | MUST 镜像后端 SkillMarketDetail（含新 hash/files） | 模块 C；skill_market §2 | +6 |
| api-client | app/web/src/lib/api-client.ts | `getMarketCapabilities()` | 新增 | `GET /skills/market/capabilities` → MarketCapabilities；503 视为「无 provider」由 caller 处理（抛含状态语义的错误或返 null，coder 定，须能被 section 区分出 noProvider 态） | MUST 让 caller 能区分 503(无 provider) vs 其他错误 | skill_market §9；PRD §3.5 | +8 |
| api-client | app/web/src/lib/api-client.ts | `searchMarket()` | 新增 | `GET /skills/market/search?q=&owner?=&limit?=` → `{ items: MarketItem[] }`（透传 provider 返回，取 items） | MUST 只传 q(+ 可选 owner/limit)；不传门控外参数 | skill_market §9；PRD §3.1 | +8 |
| api-client | app/web/src/lib/api-client.ts | `getMarketDetail()` | 新增 | `GET /skills/market/detail?ref=` → MarketDetail（ref 走 query，含 `/` 需 encodeURIComponent） | MUST ref encodeURIComponent | skill_market §9 | +6 |
| api-client | app/web/src/lib/api-client.ts | `installMarketSkill()` | 新增 | `POST /skills/market/install` body `{ ref, overwrite? }` → `{ skill: SkillEntry }`（取 .skill）；409 冲突错误透传 caller | MUST 支持可选 overwrite；409 抛错让 UI 反馈 | skill_market §9；PRD §6.4 | +12 |

### 模块 F — frontend 组件（市场 tab + 来源 badge + 状态区）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-skill | app/web/src/components/skill-page/page-skill.tsx | `TAB_IDS` | 修改 | 加 `{ id:'market', label:'' }`（label 运行时注入 t('tab.market')） | MUST 保留 manage 默认激活 | page-skill.tsx:29；PRD §3.1 | +1 |
| ui-skill | app/web/src/components/skill-page/page-skill.tsx | `PageSkill()` | 修改 | TABS 映射两 tab 各自 label；body 区按 `tab` 分支：`manage`→现有 drop-zone+list（不动），`market`→`<SectionSkillMarket installedSkills={skills} onInstalled={refresh}/>`；tab 切换不卸载已加载列表 | MUST NOT 把市场 fetch/state 写进本文件（下沉 section）；MUST 复用现有 refresh 作 onInstalled 回调（装完刷「我的」使来源 badge/同源态即时生效） | page-skill.md；invariant §0 文件护栏 | +18/-4 |
| ui-skill | app/web/src/components/skill-page/component-skill-item.tsx | `ComponentSkillItem()` | 修改 | name 行加只读**来源 badge**：`skill.marketRef` 存在→「市场」（info/中性 badge），否则→「本地」；badge 固定占位（尺寸稳定，出现/消失不位移） | MUST 只读不可点；MUST 占位恒定（_conventions §11）；走 i18n source.market/source.local | component-skill-item.md；_conventions §11；PRD §3.2 | +10 |
| ui-skill | app/web/src/components/skill-page/section-skill-market.tsx | `SectionSkillMarket()` | 新增 | 市场内容区容器：挂载调 getMarketCapabilities（503→noProvider 态）；搜索框(受控 q + 防抖/回车触发 searchMarket)；结果 grid 渲染 `component-market-item`；loading/empty/error/noProvider 态；持 detail modal open state + install handler(installMarketSkill→onInstalled)；把 installedSkills 传下算同源态 | MUST 能力门控渲染（无 capabilities 不渲染搜索框）；MUST ≤300 行（超则拆 hook）；同源判定走 deriveMarketStatus | _conventions §9；PRD §2/§3.5 | +180 |
| ui-skill | app/web/src/components/skill-page/component-market-item.tsx | `ComponentMarketItem()` | 新增 | 市场结果卡：icon-box(hash 色)+name+ref(author 行 mono)+installs(门控)+右下状态区（可安装/安装中/已安装 badge）；点卡→onOpenDetail(ref) | MUST 不渲染 description(search 无)/version/stars；状态区尺寸固定 | _conventions §9/§11；PRD §3.1/§4 | +90 |
| ui-skill | app/web/src/components/skill-page/component-market-detail-modal.tsx | `ComponentMarketDetailModal()` | 新增 | 详情 modal：挂载调 getMarketDetail(ref)；头(icon-box+name+ref+已安装 badge)+readme(markdown)+文件列表(files[].path)+底部状态区（可安装→安装 / 已安装→检查更新→(hash 比对)可更新→更新 / 已是最新）；overlay+close | MUST 惰性可更新：仅本 modal 内用 detail.hash vs installedSkill.installedHash 比对；更新=installMarketSkill(ref,{overwrite:true}) | _conventions §9；PRD §3.4/§4 | +190 |
| ui-skill | app/web/src/components/skill-page/market-status.ts | `deriveMarketStatus()` | 新增 | 纯函数：入 `(item.ref, installedSkills, opts?:{detailHash?,installing?})` → 状态枚举 `installable\|installing\|installed\|updatable\|upToDate`（列表只出 installable/installing/installed；updatable/upToDate 仅传 detailHash 时算） | MUST 同源=ref 精确匹配 marketRef；MUST 无 detailHash 时不返回 updatable/upToDate（惰性，invariant#6） | PRD §4；invariant#5/#6 | +26 |

### 模块 G — i18n（skill ns 双 locale）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| i18n | app/web/src/i18n/locales/zh-CN/skill.json | market/source keys | 修改 | 加 `tab.market`、`source.{market,local}`、`market.{searchPlaceholder,empty,error,noProvider,installsLabel}`、`market.status.{installed,updatable,upToDate}`、`market.btn.{install,installing,update,checkUpdate}`、`market.detail.files` | MUST 文案对齐 PRD §5 表（zh-CN 列） | PRD §5；_conventions §8a | +16 |
| i18n | app/web/src/i18n/locales/en/skill.json | market/source keys | 修改 | 同上 key 集，英文文案（PRD §5 en 列） | MUST key 与 zh-CN 一一对应 | PRD §5 | +16 |

### 模块 H — specs（tech + ui 组件 spec，doc-modifier 阶段最终校准；架构期先落契约）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| spec-tech | specs/tech/agent/skills/[P1]skill_market.md | §7/§9 + 新 §13 来源元数据 | 修改 | §7 install 补来源三字段写入；§9 install 端点补 `overwrite` 语义 + 同源守卫；新增小节：install 写 market_ref/market_source/installed_hash + getDetail 返 hash/files + 可更新惰性比对 | MUST 记录 overwrite 同源守卫不变量 | 本 change_plan §0/§invariants | +30 |
| spec-tech | specs/tech/agent/skills/[P0]skill_definition.md | §2 frontmatter + §6.2 表 | 修改 | §2 frontmatter 加可选 `market_ref`/`market_source`/`installed_hash`（下载来源锚点）；§6.2/SkillEntry 说明来源字段 | MUST 标注 legacy 缺省=本地来源 | PRD §6.5 | +12 |
| spec-tech | specs/tech/agent/skills/{index.md,log.md} | OKF 元数据 | 修改 | index.md ④ 补一条来源标记/同源可更新原则；log.md 加 v0.0.167 行；两文件 frontmatter `updated` | MUST 遵 OKF（okf-skill） | 项目原则 12/16 | +8 |
| spec-ui | specs/ui/components/skill-page/*.md | 组件 spec | 新增/修改 | 新增 section-skill-market.md / component-market-item.md / component-market-detail-modal.md / market-status.md；修改 page-skill.md（market tab 分支）/ component-skill-tabs.md（market tab）/ component-skill-item.md（来源 badge） | MUST 声明全部 testid（e2e-designer 读）；MUST 填视觉基线（设计稿） | _conventions §5/§9；本文档同步产出 | 见各 spec |

## 影响面评估

- **跨模块**：backend(install-core/types/resolver/provider/handler/tool-action) + api-client + frontend(6 组件/helper) + i18n + specs。依赖顺序：**A(install-core 类型/签名) 先于 D(handler/action 调用)**；B(SkillEntry) 先于 E(api-client 镜像) 先于 F(组件用)；C(getDetail hash/files) 先于 F(详情 modal)。
- **破坏性**：`stageAndInstallFiles` 签名新增第 4 可选参 + `SkillGovernanceOverride`/`InstallParams` 加可选字段——**均可选，向后兼容**（multipart 路径不传，零回归 invariant#3）。仅两个 install caller（handler / tool action）需同步传 market 元数据。
- **风险点**：(1) overwrite 同源守卫是 correctness-critical——coder MUST 按 invariant#1 实现，误覆盖本地/异源 skill 是数据丢失级 bug；(2) page-skill.tsx / section-skill-market.tsx 文件体量护栏，超 300 行须拆 hook；(3) 能力门控——UI 不得渲染 skills.sh 未声明维度（version/stars/分类/多源）。
- **打包护栏**：本版本**不加新第三方依赖**（gray-matter 已在用、前端仅调既有 fetch 封装），provider getDetail 改动不引新包 → build-plugins EXTERNALS 无需改。无 runtime-config / 路径展开新入口。四类 packaged 护栏均不触发。
- **测试**：AT 冒烟——install 写来源元数据 + overwrite 同源守卫（同源覆盖成功 / 异源 409 / 本地 409）是确定性 HTTP 契约（UT + 少量 AT 覆盖）；ET——市场 tab 渲染/搜索/安装/来源 badge/同源已安装态（PRD 6 路径）。是否新增持久 case 由 orchestrator test-plan 裁定（遵冒烟集纪律）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder。
- overwrite 守卫破 invariant#1 → 直接退回（correctness-critical）。
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计。
