---
type: spec
title: Skill 市场后端（SkillMarketProvider 协议 + exclusive EP + capability negotiation + skills.sh source）
priority: P1
status: active
updated: 2026-07-22
since: v0.0.166
---

# Skill 市场后端 — SkillMarketProvider 协议 + exclusive EP + capability negotiation

对接公开 skill 市场做 search / getDetail / install 能力。**协议先行 + exclusive 扩展点 + capability negotiation + app_config 凭证路由**，市场源可整源替换（skills.sh 是首个 impl，未来可换 ClawHub / git 自建）。

> 体系定位：本文属 skills 子系统（`index.md`）。install 落地复用 skills/installer.ts；provider 抽象范式对齐 `../tools/[P1]web_search_tool.md`（凭证归 app_config、isAvailable 禁 I/O）；出站 HTTP 复用 web-fetch 的 `proxyFetch`。调研依据 `specs/research/v0.0.166.skill-market.md`。

## 1. 概述

skill 市场 = 「**一套 provider 协议 + 一个 exclusive 扩展点 + capability negotiation 三层字段模型**」。search / getDetail / **fetchSkillFiles（取 skill 文件）**是 provider 职责（打到市场源 API）；**install 的「校验 / 落盘 / 治理」核心是 provider 无关的通用范式**（`installer.ts`，source 无关），但「取哪个 skill 的文件」由 provider 的 `fetchSkillFiles` 提供（source-specific）。

```
LLM → skill_manage(action=search|install)  ┐
UI  → GET/POST /skills/market/*            ┘→ resolveSkillMarketProvider 读 exclusive EP 当前生效 impl
   search/getDetail → provider.search/getDetail(…, cfg, signal)  → 市场源 API（skills.sh /api/search、/api/download）
   install          → provider.fetchSkillFiles(ref) 取 { files:[{path,contents}] }
                       → installer 通用核心（files → staging → locateSkillRoot → parseSkillDir 校验 → 原子 rename 落 app scope）
```

> **install 链路（用户裁决）**：走 skills.sh `/api/download/{owner}/{repo}/{slug}`（官方 CLI `skills add` 同源，匿名可用，精确返回单个 skill 的文件），**不走 GitHub codeload zipball**（zipball 下整仓再按 skillId 定位子目录，对 monorepo 如 awesome-copilot 太脆弱）。因此 installer 的复用核心从「zipBytes→adm-zip 解压」抽象为「`files:[{path,contents}]`→写 staging→校验→落盘」，**不依赖 adm-zip / zipball / codeload**。协议**仍不含 install**（不变量#2），但 provider 暴露 source-specific 的 `fetchSkillFiles`。

**exclusive 语义**：同一时刻只有一个 skill 市场源生效（范式对齐 `session_store` EP，**不是** `web_search` 的 list）。生效 impl 由 scope 配置 `selected` 决定（`default.yaml`），换源 = 换 impl + 声明能力，协议 / 上层零改动。

## 2. SkillMarketProvider 协议（权威契约）

契约类型落 `app/server/src/tools/skill-market/types.ts`（对齐 `web-search/types.ts` 风格）。

```typescript
/** provider 自描述支持能力（capability negotiation 核心；上层先问 capabilities 再决定渲染/传参）。
 *  据实收窄：skills.sh 只有 installs 一个统计维度，无 categories/collections/显式 sorts。 */
export interface SkillMarketCapabilities {
  /** 支持的分类枚举；false=不支持分类过滤；undefined=未声明（skills.sh 不声明） */
  categories?: string[] | false;
  /** 支持的集合/精选清单名（skills.sh 不声明） */
  collections?: string[];
  /** 支持的排序模式（skills.sh 不声明——search 已是后端相关度/installs 排序，无显式 sort 参数） */
  sorts?: SkillSortMode[];
  /** 结果里能带哪些统计维度（skills.sh = ['installs']，无 stars） */
  stats?: ('installs' | 'stars')[];
}

export type SkillSortMode = 'relevance' | 'trending' | 'hot' | 'updated' | 'stars' | 'installs';

/** 市场结果项（通用核心必有 + 可选能力门控字段，见 §3） */
export interface SkillMarketItem {
  /** 通用核心（必有）：install 唯一标识 ref（provider 定义格式；skills.sh = `{source}/{skillId}`，
   *  如 `github/awesome-copilot/git-commit`，可拆成 owner/repo/slug 供 /api/download） */
  ref: string;
  name: string;
  /** 可选：search 阶段 skills.sh **不返回** description → 留 undefined；getDetail 从 SKILL.md frontmatter 填 */
  description?: string;
  /** 可选 + 能力门控（provider 只填自己 capabilities 声明的；缺=undefined 不报错、不造假） */
  category?: string;
  tags?: string[];
  collection?: string;
  version?: string;
  updatedAt?: string;                       // ISO
  stats?: { installs?: number; stars?: number };  // skills.sh 仅 installs
  verified?: boolean;
  official?: boolean;
}

export interface SkillMarketSearchOptions {
  owner?: string;                           // skills.sh 支持按 gh_owner 过滤（&owner=）
  category?: string;                        // provider 不支持则忽略
  collection?: string;
  sort?: SkillSortMode;
  limit?: number;                           // 默认 20，上限由 provider 定
  cursor?: string;                          // 游标翻页（skills.sh 无 → 不返回 nextCursor）
}

export interface SkillMarketSearchResult {
  provider: string;                         // provider.id
  query: string;
  count: number;                            // items.length
  tookMs: number;                           // skills.sh duration_ms 或本地计时
  items: SkillMarketItem[];
  nextCursor?: string;                      // 有更多时返回（skills.sh 无）
}

/** skill 详情（getDetail 返回；README + 元数据）。skills.sh 无独立详情端点——getDetail 走
 *  /api/download 取文件，从 SKILL.md frontmatter 解析 name/description，SKILL.md 正文作 readme。 */
export interface SkillMarketDetail extends SkillMarketItem {
  readme?: string;
  repository?: { url: string; subpath?: string };
  securityAudit?: unknown;                  // provider 自定义结构（skills.sh 无）
}

/** provider.fetchSkillFiles 返回：某个 skill 的所有文件（内联内容）+ 可选校验 hash。
 *  install 用此喂给 installer 通用核心（source 无关）。 */
export interface FetchedSkillFiles {
  files: Array<{ path: string; contents: string }>;   // path=相对 skill 根；contents=utf-8 文本
  hash?: string;
}

/** 不透明配置 map；由 tool 从 app_config.skill_market.credentials[impl.id] 构造传入；协议不定义字段。
 *  skills.sh 全端点匿名可用，cfg.token 可选（未来提额度用，当前不依赖）。 */
export type SkillMarketCfg = Record<string, unknown>;

/** 市场源提供方契约（由插件 ext impl 实现）。凭证不进协议，归 app_config skill_market group。 */
export interface SkillMarketProvider {
  /** provider 唯一 id（snake_case，与 ext impl implId 对应） */
  id: string;
  /** 展示名（配置 UI / 错误提示用） */
  label: string;
  /** 自描述能力（静态属性，上层据此协商） */
  readonly capabilities: SkillMarketCapabilities;
  /** 是否可用（如可选 token 是否配置）。**禁止 I/O**（只查内存 cfg）。匿名公开只读源恒返 true。 */
  isAvailable(cfg: SkillMarketCfg): boolean;
  /** 搜索市场（超时/重试 provider 内部处理，默认 30s） */
  search(query: string, opts: SkillMarketSearchOptions, cfg: SkillMarketCfg, signal?: AbortSignal): Promise<SkillMarketSearchResult>;
  /** 取 skill 详情（ref = provider 定义格式；skills.sh 走 /api/download + SKILL.md frontmatter） */
  getDetail(ref: string, cfg: SkillMarketCfg, signal?: AbortSignal): Promise<SkillMarketDetail>;
  /** 取 skill 的所有文件（source-specific；install 用，喂给 installer source-无关核心）。
   *  不做校验/落盘（那是 installer 通用核心的职责）；只负责「从本源精确取到这个 skill 的文件」。 */
  fetchSkillFiles(ref: string, cfg: SkillMarketCfg, signal?: AbortSignal): Promise<FetchedSkillFiles>;
}
```

> 协议定义 **search / getDetail / fetchSkillFiles 行为 + capabilities 自描述**，**不定义 install**（install 的校验/落盘/治理是 installer 通用核心，§7；fetchSkillFiles 只「取文件」不落盘）、不读写凭证（凭证归 app_config `skill_market` group，§10）、不暴露内部 HTTP 细节。

## 3. capability negotiation 三层字段模型（核心 — 固化）

skill 市场各源能力参差（有的有 installs/trending，有的只有 star/更新时间）。协议用**三层字段模型**吸收差异，让上层「支持与不支持都自适应」：

| 层 | 字段 | 语义 |
|---|---|---|
| **① 通用核心（必有）** | `ref` / `name` | 任何源都能给；`ref` 是 install 唯一标识（provider 定义格式），fetchSkillFiles/install 据此取文件 |
| **①′ 核心可选** | `description` | **降级为可选**——search 阶段部分源（如 skills.sh）不返回 → 留 `undefined`；`getDetail` 从 SKILL.md frontmatter 补填。上层缺则不渲染描述，不报错 |
| **② 可选 + 能力门控（结果）** | `category` / `tags` / `collection` / `version` / `updatedAt` / `stats{installs?,stars?}` / `verified` / `official` | provider **只填自己 `capabilities` 声明支持的**；上层缺字段 = `undefined`，不报错、不渲染该维度 |
| **③ 可选 + 能力门控（参数）** | `SkillMarketSearchOptions.owner` / `category` / `collection` / `sort` | provider **只认自己 `capabilities` 声明的**；传了不支持的一律忽略（不报错）。skills.sh 只认 `owner`（+ `limit`） |

**真实源验证**：skills.sh search 只返回 `ref/name/stats.installs`（无 description/category/sort/stars）——capability negotiation 模型正好被真实源验证有用：能力少的源（skills.sh）只填 core + installs，上层自适应少渲染几维；未来能力多的源多渲染。**核心从「必有三字段」收窄为「必有 ref/name + 可选 description」**。

**协商规则（不变量）**：
1. **上层永远先问 `capabilities` 再决定渲染/传参**（UI 据 `capabilities.categories` 决定是否显示分类过滤；据 `capabilities.stats` 决定是否显示安装量/star）。
2. **provider 只填/只认自己声明的能力**；未声明的结果字段留空、未声明的参数忽略。
3. **换源 = 换 impl + 换 `capabilities` 声明**，协议契约、tool 层、HTTP 端点、上层渲染逻辑**零改动**——能力多的源多渲染几维、能力少的源少渲染几维，自适应收敛。

## 4. skill_market_provider 扩展点（exclusive）

内置 EP，位于 `app/server/src/plugin/extension-point.ts` 的 `BUILTIN_EXTENSION_POINTS`：

```typescript
/** skill_market_provider：exclusive，承载可替换的 skill 市场源（同一时刻只有一个生效）。 */
export const SkillMarketProviderPoint: ExtensionPoint = {
  id: 'skill_market_provider',
  cardinality: 'exclusive',                 // 范式抄 session_store（≤1 active），非 web_search 的 list
  description: '__MSG_extpoint.skill_market_provider.description__',
};
```

- **cardinality = `exclusive`**：同 scope ≤1 active（`getExtensionImpls(SkillMarketProviderPoint)` 返 0 或 1 个）；生效 impl 由 scope 配置 `selected` 决定（§10 `default.yaml`）。这与 `web_search`（list + app_config.type 路由）**语义不同**——skill 市场是整源替换心智，不需要「多源共存切换」。
- **group**：新增 `skill-market` group（`app/plugins/groups.json`，§10），承载本 EP 的 UI 元数据。

## 5. resolveSkillMarketProvider（tool / handler 共用路由）

落 `app/server/src/tools/skill-market/resolve.ts`（对齐 web-search `resolveProvider`，但 exclusive → 取单个 active impl，凭证按 impl.id 取）：

```typescript
function resolveSkillMarketProvider(ctx: ToolCtx): { provider?: SkillMarketProvider; cfg: SkillMarketCfg } {
  const pm = ctx.config.pluginManager;                  // 鸭子类型 getExtensionImpls
  const impls = pm?.getExtensionImpls?.(SkillMarketProviderPoint) ?? [];
  const provider = impls[0];                            // exclusive → ≤1 个 active
  if (!provider) return { cfg: {} };
  // 凭证按 impl.id 取（exclusive 无 type 路由，凭证 map 仍按 impl id 索引，支持 token 可选）
  const appConfig = ctx.config.appConfig;
  const mkCfg = appConfig?.get?.('skill_market', 'default') as
    | { credentials?: Record<string, Record<string, unknown>> } | undefined;
  return { provider, cfg: mkCfg?.credentials?.[provider.id] ?? {} };
}
```

**错误分支**：无 active impl → ToolError / HTTP 503「skill 市场未配置生效 provider」；`isAvailable(cfg)===false`（源要求 token 而未配）→ ToolError「provider {label} 不可用」。匿名公开只读源 `isAvailable` 恒 true，无 token 也能搜。

## 6. skill-manage search/install action + 文件拆分

skill-manage tool 加 `search` / `install` 两个 action（enum + description + switch）。**`skill-manage.ts` 现 338 行已超 300 上限**，加 action 必须先拆分：

**拆分方案**：
- 新建 `app/server/src/tools/skill-manage-actions.ts`：迁入现有 5 个 execute 函数（`executeCreate` / `executePatch` / `executeSetEnabled` / `executeList` / `executeRead`）+ 其私有 helper（`readSkillFile` / `getBool` / `toMeta` / `makeEnabledStore` / `scopeRootDir` / `parseNameScope` 等）。
- `skill-manage.ts` 瘦身为：tool 定义（schema / description / dispatch switch）+ scope 词汇映射导出（`toInternalSkillScope` / `toExternalSkillScope` 等对外契约，多处 import 需保留在此或另立 `skill-scope.ts`）。目标 ≤ 150 行。
- 新建 `app/server/src/tools/skill-market/actions.ts`：market 专属 `executeMarketSearch(input, ctx)` + `executeMarketInstall(input, ctx, dataDir, workdir)`（调 `resolveSkillMarketProvider` → `provider.fetchSkillFiles(ref)` → `installer.stageAndInstallFiles`）。
- `skill-manage.ts` dispatch 加 `case 'search'` / `case 'install'` → 委派 `skill-market/actions.ts`（新增 2 import）；enum 加 `'search'`,`'install'`；description 加一句市场说明；inputSchema 加 `query` / `ref` / `sort` / `category` 属性。

**action 语义**：
| action | 入参 | 行为 |
|---|---|---|
| `search` | `query`, `owner?`, `limit?`（skills.sh 不认 sort/category） | resolve provider → `search` → 序列化 items（markdown，含 ref/name + 声明支持的统计维度 installs；description 缺则不渲染） |
| `install` | `ref`（provider 定义格式，skills.sh=`{source}/{skillId}`）, `scope?`（默认 app/global） | resolve provider → `provider.fetchSkillFiles(ref)` → `installer.stageAndInstallFiles`（校验/落盘/治理，§7）→ textResult JSON `{ ok:true, ref, skill: SkillEntry }`（ref 形状先在 action 层 `owner/repo/slug` 守卫，非法 → INVALID_INPUT） |

## 7. install = provider 取文件 + installer 通用核心（source 无关）

**install 分两段**：①「取文件」source-specific，由 `provider.fetchSkillFiles(ref)` 负责（skills.sh 走 `/api/download`，§8）；②「校验 / 落盘 / 治理」source-无关，由**落盘核心**负责。二者解耦——换源只换 fetch，落盘链路零改动。

**文件布局（v0.0.166 拆分）**：source-无关落盘核心抽到**新文件** `app/server/src/skills/installer-core.ts`（含 `finalizeStagedSkill` + `stageAndInstallFiles` + 类型/错误/工具 `assertWithinTmp`/`locateSkillRoot`/`scopeRoot`/`InstallError`/`SkillGovernanceOverride`）；`installer.ts` 收窄为 **multipart 上传适配层 + facade 重导出**（`installSkill` + `collectFileParts`/`stageParts`，并从 `installer-core` re-export 全部核心符号——`import '../skills/installer'` 路径对外不变，无回归）。拆分原因：`installer.ts` 抽取后超 300 行硬上限。

- **`stageAndInstallFiles(files, dataDir, params)`**（installer-core.ts，**同步**）：入参 `files: {path,contents}[]`（provider 取好）→ `mkdtemp` staging → 逐个按 `path` 写盘（复用 `assertWithinTmp` 防路径遍历）→ 走落盘核心 `finalizeStagedSkill(tmpRoot, dataDir, params, governance?)`（`locateSkillRoot`+`parseSkillDir`+目录名一致+体积+冲突+原子 rename+重读）。治理 `{ productionMethod:'download', evolvable:false }` **硬编码在 `stageAndInstallFiles` 内传给 finalize**（caller 只传 `{scope:'app'}`，不传治理）。
- **治理写入 SKILL.md frontmatter 持久化（非仅覆盖返回对象）**：`finalizeStagedSkill` 拿到 `governance` 后，落盘前经 `applyGovernance` 用 `gray-matter` **改写 staged 的 `SKILL.md` frontmatter**（`production_method` / `evolvable` 键），再原子 rename。这样落盘资产的 SKILL.md 里就带 `production_method: download` + `evolvable: false`——**resolver 重扫也一致**（源 frontmatter 若声明 `evolvable:true` 会被强制盖成 false），不依赖运行时对象覆盖。
- **`installSkill`（multipart）行为不变**：保留其 `collectFileParts`+`stageParts`（含 **.zip/.skill adm-zip 解压**分支——multipart 上传仍支持 zip，adm-zip 保留），staging 完后调同一 `finalizeStagedSkill`（**不传 governance** → 保留源 frontmatter，零回归）。即**共用的是落盘核心（finalize），不是 staging**——multipart 的 zip 解压 staging 与 download 的 files 写盘 staging 各自独立，汇入同一 finalize。**adm-zip 仅 multipart 保留，download 路径完全不用**。
- 冲突（已存在同名）→ `InstallError('conflict')` / caller 映射 409；体积上限 50MB（复用 `MAX_SKILL_BYTES`）。
- **ref 形状校验**：ref 格式由 provider 定义 → 拆解/校验/防注入归 **provider**（skills.sh 在 fetchSkillFiles 内拆 owner/repo/slug 并校验，§8）；installer 只吃 files，路径安全由 `assertWithinTmp` 兜底（files[].path 不得越 staging 根）。

> **设计取舍（用户裁决）**：install 走 skills.sh `/api/download` 精确取单 skill 文件，**不走 GitHub codeload zipball / 不用 git 二进制**。理由：精确拿单 skill、匿名可用、对齐官方 CLI `skills add`；zipball 下整仓再定位 skillId 子目录对 monorepo（awesome-copilot 含大量 skill）太脆弱。installer 因此**不再需要 adm-zip 处理 download 路径**（adm-zip 仅 multipart 上传保留）。出站走 `proxyFetch`（§8），不新造 fetch。

## 7.1 [v0.0.167] install 来源元数据 + 覆盖更新 + 可更新惰性比对（前端消费前提）

v0.0.166 install 只写治理 `production_method:download` + `evolvable:false`，**不记录市场来源**，也无版本比对。v0.0.167 前端要做「已安装来源标记 / 市场同源已安装 / 可更新」，后端补齐三块（method 级契约见 `specs/tech/version_logs/v0.0.167.skill_market_ui/change_plan.md`）：

1. **来源元数据写 frontmatter**：install 落盘前 `applyGovernance`（installer-core.ts）除治理两字段外，**追加**写入 SKILL.md frontmatter：
   - `market_ref`：安装用的 provider ref（如 `github/awesome-copilot/git-commit`）。
   - `market_source`：provider id（如 `skills_sh`）。
   - `installed_hash`：安装时 `provider.fetchSkillFiles` 返回的 `hash`（内容锚点，供可更新比对）。
   - `SkillGovernanceOverride` 加 `marketRef?/marketSource?/installedHash?`（全可选）；`stageAndInstallFiles` 加第 4 参 `market?: {marketRef,marketSource,installedHash?}`，构造 governance 传 finalize。**multipart 上传路径不传 → 不写这些键（零回归）**。
   - resolver.parseSkillDir 读三键 → `SkillEntry.marketRef/marketSource/installedHash`（缺失=本地来源，不报错）。前端 api-client SkillEntry 镜像 marketRef/marketSource/installedHash。
2. **可更新判定 = 方案 (a) getDetail 返 hash + 前端比对（惰性）**：`SkillMarketDetail` 加 `hash?: string`（当前内容哈希）+ `files?: {path}[]`（包含文件列表）。skills.sh `getDetail` **内部已调 fetchSkillFiles** → hash/files 免费，无新请求、无新端点。前端：列表阶段只 ref 精确匹配判「已安装」（零请求）；详情 modal 拿 `detail.hash` 与已安装 `installedHash` 比对 → 不同「可更新」/ 相同「已是最新」。**列表不比 hash**（惰性，避免 N 次请求）。
3. **更新 = 同源覆盖重装（correctness-critical 守卫）**：`POST /skills/market/install` body 加 `overwrite?: boolean`。`finalizeStagedSkill` 遇同名冲突时——仅当 `overwrite=true` **且**磁盘已装目标的 frontmatter `market_ref` **精确等于**本次 ref → 删旧目录后 rename 覆盖，刷新 installed_hash；否则（无 overwrite / 目标无 market_ref = 本地 skill / market_ref 不同 = 异源同名）→ `InstallError('conflict')` 409。**MUST NOT 覆盖本地或异源同名 skill**（守卫读磁盘 frontmatter，不信前端传参）。agent 路径（skill_manage install）**不开放 overwrite**（默认 409，避 agent 误覆盖）。

## 8. skills.sh 首个 source impl（builtin plugin）

打包成 builtin plugin `app/plugins/builtins/skills_sh/`：

- **plugin.json**：`id: skills_sh`，1 条 extImpl（`implId: skills_sh`，`point: skill_market_provider`，`impl: ./skills-sh-provider.ts`）。
- **skills-sh-provider.ts**：`export default class SkillsShProvider implements SkillMarketProvider`；构造器 `(implId, _cfg={})` 只存 `this.id=implId`（凭证不从构造器取，运行时入参 cfg 读，对齐 web_search v0.0.72）。
  - `capabilities`（据实收窄）：`{ stats: ['installs'] }`——skills.sh 唯一统计维度是 installs（**无 stars**）；`categories` / `collections` / `sorts` **均不声明**（skills.sh 无这些维度，search 结果已是后端相关度/installs 排序，无显式 sort 参数）。
  - `isAvailable(cfg)`：**恒 true**（全端点匿名 200，无需 token；`cfg.token` 可选，仅未来提额度用，当前不依赖）。禁 I/O。
  - `search(query, opts, cfg, signal)`：`proxyFetch` GET `https://skills.sh/api/search?q={query}`（`opts.owner` → `&owner={owner}`）→ 响应 `{ query, searchType, skills:[{id,skillId,name,installs,source}], count, duration_ms }` → `mapSkillsShItems` 映射 → `SkillMarketSearchResult`（`tookMs=duration_ms`，`nextCursor` 无）。
  - `getDetail(ref, cfg, signal)`：skills.sh **无独立详情端点** → 调 `fetchSkillFiles(ref)` 取文件 → 从 `SKILL.md` frontmatter 解析 `name`+`description`、正文作 `readme` → `SkillMarketDetail`。
  - `fetchSkillFiles(ref, cfg, signal)`：拆 ref（`{source}/{skillId}` = `owner/repo/slug`，校验形状 + 防注入）→ `proxyFetch` GET `https://skills.sh/api/download/{owner}/{repo}/{slug}` → 响应 `{ files:[{path,contents}], hash }` **直接内联返回该 skill 所有文件** → `FetchedSkillFiles`（这是官方 CLI `skills add` 走的安装路径，精确单 skill，非整仓 zip）。
  - `mapSkillsShItems(skills)`：`{id→ref, name→name, installs→stats.installs}`；`description` 留 `undefined`（search 不返回）；未声明能力的门控字段一律不填（不造假）。
- **端点据实（curl 实测，全部匿名 200）**：
  - 搜索：`GET /api/search?q=<query>[&owner=<gh_owner>]`
  - 下载/详情：`GET /api/download/{owner}/{repo}/{slug}`（slug=skillId）
  - ⚠️ 旧草稿的 `/api/v1/skills` 是**错端点**（要 Vercel OIDC token，匿名 401）——已删除。
- **认证**：全端点匿名可用，`token` 做成可选 provider cfg（`app_config.skill_market.credentials.skills_sh.token`，§10），当前不依赖（有则未来提额度）。
- **build-plugins**：`skills_sh` 目录带 plugin.json → 被 `scripts/build-plugins.ts` 自动扫描编译成自包含 `.cjs`；deep import `@app/server/dist/...` + `undici`(proxyFetch) 均已在 `EXTERNALS`，**无新第三方包**，EXTERNALS 无需改（仅需验证产物校验通过）。

## 9. /skills/market/* HTTP 端点（给未来 UI）

新建 handler `app/server/src/handlers/skill-market.ts`（`handleSkillMarketRoute`），misc-routes.ts 加 dispatch 分支（`path === '/skills/market' || path.startsWith('/skills/market')`；注意 `/skills/`(复数) 不与现有 `/skill/`(单数) 冲突）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/skills/market/capabilities` | 返当前生效 provider 的 `{ id, label, capabilities }`（UI 协商用；无 active → 503） |
| GET | `/skills/market/search?q=&owner=&limit=&cursor=` | resolve → `search` → 200 JSON（缺 `q` → 400；skills.sh 仅认 q/owner/limit） |
| GET | `/skills/market/detail?ref=<provider ref>` | resolve → `getDetail`（ref 含 `/` 走 query 参数，不走路径段；缺 `ref` → 400）。**[v0.0.167]** 返回体含 `hash`（当前内容哈希，可更新比对）+ `files:[{path}]`（包含文件列表） |
| POST | `/skills/market/install` | body `{ ref, scope?, overwrite? }` → ref 形状守卫（`owner/repo/slug` 非法 / `scope` 非 `app` → 400）→ resolve → `provider.fetchSkillFiles(ref)` → `installer.stageAndInstallFiles`（§7，**[v0.0.167]** 传 market 元数据 `{marketRef:ref, marketSource:provider.id, installedHash:hash}` + `overwrite`）→ **202** `{ skill: SkillEntry }`。**overwrite=true 仅同源覆盖**（§7.1 守卫），异源/本地同名 → 409 |

handler 内部复用 `resolveSkillMarketProvider`（tool/handler 同源）；handler 侧无 `ToolCtx` → 构造等价 `{ config:{ pluginManager, appConfig } }` 鸭子类型传入。**所有端点统一门槛：无 active provider → 503**。install 语义据实：**走生效 provider 的 `fetchSkillFiles` 取文件 + installer 通用核心落盘**（非 codeload zipball）。`InstallError` → 状态码映射（`bad_request`→400 / `conflict`→409 / `workspace_not_found`→404 / `too_large`→413）；其余异常 → 500。

## 10. 配套：app_config group + scopes + groups.json + i18n

- **app_config `skill_market` group（`config/[P0]app_config.md` §3.17）**：单实例 `key="default"`，`data = { credentials?: { [implId]: { token?: string } } }`（token 可选，匿名可用）。**只放凭证**（不放 type——exclusive 靠 scope selected 选源）。
- **scopes/default.yaml**：`web`/`vision` 同级加 `skill-market` group block →
  ```yaml
  - id: skill-market
    points:
      - pointId: skill_market_provider
        selected: skills_sh
        impls:
          - skills_sh
  ```
  **forked.yaml 不加**（forked 旁路 run 不搜市场；exclusive EP 无 impl → getExtensionImpls 空，不影响）。
- **groups.json**：追加 `{ id: 'skill-market', label/description: __MSG__, extPoints: ['skill_market_provider'] }`。
- **i18n（`app/web/src/i18n/locales/{zh-CN,en}/plugin-config.json`，注意英文目录是 `en/` 非 `en-US/`）**：加 `extpoint.skill_market_provider.description` + `group.skill_market.{label,description}` + `plugin.builtin.skills_sh.{label,description}` + impl description MSG 条目（zh-CN + en 两套）。

## 11. 设计决策

- **exclusive 非 list（用户裁决）**：skill 市场是整源替换心智（skills.sh → 未来 ClawHub/git 自建），不需 web_search 的「多源共存 + type 切换」；exclusive 抄 session_store，生效源由 scope `selected` 决定。
- **capability negotiation 而非硬编码字段**：各市场源能力参差，协议用三层字段模型吸收差异 → 换源零改动、支持与不支持都自适应（避免为每源改协议）。
- **install 取文件 source-specific，落盘核心 source-无关**：`provider.fetchSkillFiles(ref)` 取文件（skills.sh 走 `/api/download` 精确取单 skill）+ `installer.stageAndInstallFiles` 校验/落盘/治理——换源只换 fetch，落盘链路零改动。**不走 codeload zipball / git 二进制**（用户裁决：精确、匿名、对齐官方 CLI；zipball 对 monorepo 太脆弱）。
- **凭证归 app_config、不进协议 / 不进 plugin manifest**（对齐 web_search v0.0.72 / see_image）：token 可选，匿名公开只读为默认路径。
- **出站复用 proxyFetch**：不新造 fetch，统一走 web-fetch 代理层（record/replay + 系统代理支持）。

## 12. 边界

| 零件 | 归属 |
|---|---|
| SkillMarketProvider 协议 + capabilities 三层模型 + skill_market_provider EP + resolve + skill-manage search/install + `/skills/market/*` + skills_sh impl | 本文 ✅ |
| EP cardinality/exclusive 解析 | `plugin_system/[P0]extension_point_interface.md` / `plugin_manager_interface.md` |
| app_config skill_market group（凭证归属） | `config/[P0]app_config.md` §3 |
| install 落盘的 staging/校验/原子 rename 机制 | `[P0]skill_architecture.md` §5 + `skills/installer-core.ts`（落盘核心）+ `skills/installer.ts`（multipart 适配 + facade） |
| skill 治理字段（evolvable/source/productionMethod） | `[P0]skill_definition.md` §6 |
| 出站代理 | `../tools/[P1]web_fetch_tool.md` §3 |
| 市场 UI（我的/市场两 tab、卡片渲染、来源 badge、同源/可更新态） | **[v0.0.167]** `specs/ui/components/skill-page/`（page-skill / component-skill-tabs / component-skill-item / section-skill-market / component-market-item / component-market-detail-modal / market-status）+ 本文 §7.1 后端契约 |

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/v0.0.166.skill_market/change_plan.md`（method 级变更契约）。
