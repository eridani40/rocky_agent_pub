---
type: spec
title: Web Search Tool（协议 + List EP + app_config 路由）
priority: P1
status: active
updated: 2026-07-22
since: v0.0.23
---

# Web Search Tool — 协议 + List EP + app_config 路由

web_search 工具：按 query 检索 → 返回结构化结果列表（+可选 answer）。**协议先行 + list 扩展点 + app_config 路由**，后端 provider 可插拔。
体系定位见 `[P1]web_tools.md`；调研依据 `specs/research/v0.0.23-web-search.md`。

> **[v0.0.72 修订]**：EP 由 `exclusive` 改 `list`（多 impl 可枚举共存，仍按 `app_config.web_search.type` 单点路由）；`WebSearchProvider.search`/`isAvailable` 协议加 `cfg` 入参（map 传递，D1=A）；凭证从 ext impl `configSchema` 迁出到 `app_config.web_search` group（D2），impl 改从运行时入参 `cfg.apiKey` 读，删 env 回退。原 `exclusive` 文案作废，见 §5.4。

## 1. 概述

web_search 的核心是「**定义一套 provider 协议 + 一个 list 扩展点**」（v0.0.72 由 exclusive 改 list，多 provider 共存、按 `app_config.web_search.type` 单点路由）。具体搜索后端（Tavily/Google/Bing/...）由用户配置选；当前**内置 Zhipu provider**（智谱，§7）作为开箱 ext impl（**[v0.0.123]** 拆成 2 个独立 impl：`zhipu_coding_plan` MCP 订阅额度 / `zhipu_api` REST 按量计费），其他后端以插件 ext impl 形式贡献，协议不变。

```
LLM → web_search Tool（统一 schema）→ resolveProvider 读 app_config.web_search → 按 type 在 list EP 精确匹配 impl
                                   → provider.search(query, opts, cfg) → WebSearchResult
                                   → 截断 + wrapExternalContent → ToolResultBlock
```

## 2. WebSearchProvider 协议（权威契约）

```typescript
/** 搜索后端提供方契约（由插件 ext impl 实现）。凭证不进协议，归 app_config web_search group。 */
interface WebSearchProvider {
  /** provider 唯一 id（snake_case，与 ext impl implId 对应） */
  id: string;
  /** 展示名（配置 UI 用） */
  label: string;
  /**
   * 是否可用（如凭证是否配置）。**禁止做 I/O**（只查内存配置），否则每次 assemble 都阻塞。
   * [v0.0.72] 改为接收 cfg 入参（map，由 tool 从 app_config 构造传入）。
   * 返回 false → Tool 返回精确错误（"provider X 不可用 / 凭证未配置"），不静默换 provider。
   */
  isAvailable(cfg: WebSearchCfg): boolean;
  /**
   * 执行检索。超时/重试由 provider 内部处理（默认 30s + 2 次指数退避）。
   * [v0.0.72] 加 cfg 入参（map，由 tool 从 app_config.web_search.credentials[type] 构造传入）。
   * 协议不定义 apiKey 字段——cfg 是不透明 map，各 impl 自定义字段（zhipu 读 cfg.apiKey）。
   */
  search(query: string, opts: WebSearchOptions, cfg: WebSearchCfg, signal?: AbortSignal): Promise<WebSearchResult>;
}

/**
 * [v0.0.72] 不透明配置 map，由 tool 从 app_config.web_search.credentials[type] 构造，
 * 每次 call 传入 impl。协议不规定字段，由 impl 自定义（zhipu 期望 {apiKey?: string}）。
 */
type WebSearchCfg = Record<string, unknown>;

interface WebSearchOptions {
  maxResults?: number;     // 默认 10；上限由 provider 定
  /** 是否请求「带引用的答案」（部分后端如 Tavily 支持）；不支持则忽略 */
  answer?: boolean;
}

interface WebSearchResult {
  provider: string;            // provider.id
  query: string;
  count: number;               // results.length
  tookMs: number;
  /** 结构化结果项（最小集：title/url/snippet） */
  results: SearchResultItem[];
  /** 可选：provider 综合出的带引用答案（answer=true 时可能返回） */
  answer?: string;
}

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;             // 摘要正文
  score?: number;              // 相关度（provider 自定义刻度，可选）
  publishedDate?: string;      // ISO，可选
}
```

> 协议**只定义 search 行为**，不定义 `createTool`（Tool schema 由本工具统一）、不读写凭证（凭证归 `app_config` `web_search` group，§2.5/§4）、不暴露 provider 内部 HTTP 细节。
>
> **[v0.0.72] impl 构造器 cfg 与运行时 cfg 的语义关系**：PluginManager 仍按 `(implId, cfg)` 实例化（cfg 来自 scope configValues，统一实例化链路不变）；但 impl 内部**不再依赖构造器 cfg 取凭证**——`isAvailable`/`search` 统一从运行时入参 `cfg`（tool 传入）读。构造器 cfg 仅用于非凭证的初始化（如基址默认值等，zhipu 当前无此类需求）。这样：构造时 cfg 可空，运行时 cfg 始终由 tool 从 app_config 构造并覆盖/取代。**impl 不应在 `isAvailable`/`search` 中读 `this.cfg` 取凭证**——必须读入参 cfg。

## 3. web_search_provider 扩展点（list，单点路由）

内置 EP，位于 `app/server/src/plugin/extension-point.ts` 的 `BUILTIN_EXTENSION_POINTS`：

```typescript
/** web_search_provider：list，承载可插拔搜索后端（多 impl 共存，按 app_config.type 单点路由）。 */
export const WebSearchProviderPoint: ExtensionPoint = {
  id: 'web_search_provider',
  cardinality: 'list',
  group: 'web',
  description: '__MSG_extpoint.web_search_provider.description__',
};
```

- **[v0.0.72] cardinality=`list`**：注册表枚举多个 web_search_provider ext impl 共存（不强制单选）。`PluginManager.getExtensionImpls(WebSearchProviderPoint)` 返回所有已激活 impl 数组。
- **group=`web`**：分区（v0.0.23 引入），承载未来 web_fetch/browser 的 provider 类 EP。
- **单点路由（不融合）**：list 仅表示「多 impl 可同时注册」，**不表示一次搜索多 provider 并发融合**。tool 按 `app_config.web_search.type` 精确选一个 impl 调用（§4）。多 impl 共存只为「未来增加其他供应商」铺路。
- **配置 UI**：type 选择控件由 ext impl 列表驱动（choice-cards，见 ui spec `section-web-search-config`）；选中一个 type 即路由到对应 impl。

## 4. web_search Tool 层

```typescript
const webSearchTool: Tool = {
  definition: {
    name: 'web_search',
    description: 'Search the web. Returns a list of results (title/url/snippet) and optional answer.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number', default: 10 },
        answer: { type: 'boolean', default: false },
      },
    },
  },
  async run(input, ctx) {
    // [v0.0.72] resolveProvider：读 app_config.web_search → 按 type 路由 → 构造 cfg map
    const { provider, cfg } = resolveProvider(ctx);
    if (!provider) return errorResult('web_search 未配置 provider type（app_config.web_search 缺失或 type 未配置）');
    if (!provider.isAvailable(cfg)) return errorResult(`provider ${provider.label} 不可用（凭证未配置?）`);
    const res = await provider.search(input.query, { maxResults: input.maxResults, answer: input.answer }, cfg, ctx.signal);
    const body = serializeResult(res);             // markdown 序列化（results 列表 + answer）
    return textResult(truncate(wrapExternalContent(body), WEB_TOOLS_MAX_CHARS));
  },
};
```

**[v0.0.72] `resolveProvider` 逻辑**（取代 exclusive 取首个）：

```typescript
function resolveProvider(ctx: ToolCtx): { provider?: WebSearchProvider; cfg: WebSearchCfg } {
  const cfg: WebSearchCfg = {};
  // 1. 读 app_config.web_search.default
  const appConfig = ctx.config.appConfig as AppConfigService | undefined;
  const wsConfig = appConfig?.get?.("web_search", "default") as
    | { type?: string; credentials?: Record<string, Record<string, unknown>> }
    | undefined;
  if (!wsConfig?.type) return { cfg };          // type 未配置 → ToolError
  // 2. 取 list EP 全部 impl
  const pm = ctx.config.pluginManager;
  const impls = pm?.getExtensionImpls?.(WebSearchProviderPoint) ?? [];
  // 3. 按 type 匹配 impl.id
  const provider = impls.find(p => p.id === wsConfig.type);
  if (!provider) return { cfg };                  // impl 不存在 → ToolError
  // 4. 构造 cfg = credentials[type] ?? {}
  Object.assign(cfg, wsConfig.credentials?.[wsConfig.type] ?? {});
  return { provider, cfg };
}
```

**错误分支（均返 ToolError，不静默回退）**：
- `appConfig` 不存在 / `web_search.default` record 缺失 / `data.type` 缺失 → 「web_search 未配置 provider type」。
- `type` 对应的 impl 不在 `getExtensionImpls` 返回中 → 「web_search type `{type}` 对应 impl 未激活」。
- `provider.isAvailable(cfg) === false` → 「provider {label} 不可用（凭证未配置?）」。

Tool 注册到 `defaultTools()`（见 `registry.ts`），按 `definition.name='web_search'` 路由。

## 5. 设计决策

### 5.1 search 返回结构化类型，非 `Record<string,unknown>`
**结论**：`WebSearchResult`/`SearchResultItem` 是显式 interface（title/url/snippet 最小集 + score/publishedDate 可选）。
**理由**：结构化便于 Tool 层统一序列化、截断、wrapExternalContent；不同 provider 输出归一到同一形状。
**反例**：若返回裸 JSON，每个 provider 字段不一（openclaw tavily 多 score，hermes 多 position），Tool 层无法统一处理。

### 5.2 凭证不进协议，归 app_config web_search group
**结论**：协议无 apiKey/baseUrl 字段；凭证归 `app_config` `web_search` group（D2，§2.3 of `[P0]app_config.md`）。
**[v0.0.72 修订]**：原归 plugin manifest `configSchema`（ext impl config）的方案作废——凭证迁出 ext impl configSchema，改由 tool 从 `app_config.web_search.credentials[type]` 构造 cfg 入参传 impl。
**理由**：协议是行为契约，凭证是用户配置；归 app_config 后 UI 走统一「应用配置」入口、与 providers/observability 同范式，便于未来扩展多 provider 凭证。

### 5.3 isAvailable 禁止 I/O
**结论**：`isAvailable(cfg)` 只查内存配置（如 cfg.apiKey 字段非空），不发网络探测。
**理由**：assemble/inventory 可能频繁调；I/O 会阻塞或并发风暴。

### 5.4 list 但单点路由（v0.0.72 修订 — 推翻原 exclusive 决策）
**结论**：cardinality=`list`（多 impl 共存），但 tool 仍按 `app_config.web_search.type` 单点路由到一个 impl，不并发融合。
**[v0.0.72 推翻原决策]**：原 `exclusive`（≤1 生效，注册表强制单选）→ 改 `list`（注册表允许多 impl 共存），由 app_config 层表达「当前选中哪个 type」。这样：多 search 供应商可同时安装（用户在「应用配置 → 网络搜索」随时切换 type），无需先停用旧的再装新的。
**理由**：一次搜索仍由一个 provider 答——结果可解释、凭证/计费隔离、与单选 UI 心智一致。多 provider 并发融合会双倍计费且结果去重复杂，本版本不引入。多 impl 共存只为「切换 type 时无需先卸载旧 impl」铺路。

## 6. 共性约定（见 `[P1]web_tools.md` §2）

- 超时：provider 自带 30s；Tool 透传 `ctx.signal`。
- 重试：provider 内部 2 次指数退避（瞬时错误）。
- 截断：结果序列化超 `WEB_SEARCH_MAX_CHARS`（~100k）→ 截断 + 提示 context offload。
- wrapExternalContent：snippet/answer 必须 untrusted 包装（防 injection）。
- 代理：provider 的 HTTP 调用走 undici EnvHttpProxyAgent（见 `web_fetch_tool.md` §3）。

## 7. 内置 Zhipu provider（智谱 — v0.0.123 拆 2 个独立链路）

v0.0.23 提供开箱 provider：**Zhipu web_search**（智谱），单 plugin `zhipu_web_search` 贡献。**[v0.0.123]** 从 1 个 impl 拆成 2 个独立 ext impl（同 `web_search_provider` list EP，各自 key 隔离、访问链路隔离，用户按计费方式选一条）：

| implId | 本质 | 端点 / 协议 | 计费 | impl 文件 |
|---|---|---|---|---|
| `zhipu_coding_plan` | v0.0.121 引入的 MCP 实现（现 dev1，本节下方「API」记的即此链路） | `open.bigmodel.cn/api/mcp/web_search_prime/mcp`（Streamable HTTP + JSON-RPC 2.0，两步 initialize→tools/call） | Coding Plan 订阅额度 | `zhipu-coding-plan-provider.ts` |
| `zhipu_api` | v0.0.121 前 REST 实现（v0.0.123 从 git `0b64ae54^` 恢复） | `open.bigmodel.cn/api/paas/v4/web_search`（POST Bearer，`{search_query,search_engine:"search_std",search_intent:false,count}`） | 按 API 调用量计费 | `zhipu-api-provider.ts` |

> **[v0.0.123] 拆分动机 + spec 以真实行为为准（D4 用户裁决）**：v0.0.121 把 REST（按量计费，需单独资源包）换成 MCP（订阅额度，同 key 可用），把两条本质不同的链路混叫一个 `zhipu`。v0.0.123 拆两个独立 impl，各配一个 apiKey，控件形式一样（type 下拉 1→2 项）。既有 `zhipu` 配置一次性迁移到 `zhipu_coding_plan`（现有 key 实为 coding plan key，迁移机制见 `app_config.md §3.6`）。
>
> **共性契约**（两 impl 一致，复用 v0.0.72 契约，`WebSearchProvider` 协议/`resolveProvider` 路由零改动）：凭证唯一源 = `app_config.web_search.credentials.<implId>.apiKey`；`isAvailable(cfg)=!!cfg.apiKey`；`search` 空 key 抛 Error → tool 层转 ToolError；两 impl `label` getter 返回不同文案（`智谱 · Coding Plan（订阅额度）`/`智谱 · API（按量计费）`，供 ToolError `{label}` 区分；下拉 option label 另走 i18n `impl.<implId>.description`）；响应都归一到同一 `WebSearchResult`。
>
> **plugin.json（v0.0.123 — 2 extImpls，参照 llm_anthropic 1-plugin-2-impls）**：两条 extImpls entry（`zhipu_coding_plan`→`./zhipu-coding-plan-provider.ts` / `zhipu_api`→`./zhipu-api-provider.ts`），均 `point:"web_search_provider"`；plugin `id` 保持 `zhipu_web_search`（不改，避免 policy/scope 连锁）。scope `default.yaml` 的 `web_search_provider.impls` 列 `[zhipu_coding_plan, zhipu_api]`（两 impl 均 default 激活）。

**凭证归属（两 impl 共性）**：
- **凭证不走 ext impl config**：`plugin.json` 无 `configSchema.apiKey`（secret 不进 manifest configSchema，对齐 v0.0.67 D1）；impl 不从构造器 cfg / env 读 apiKey。
- **凭证唯一源 = `app_config.web_search.credentials.<implId>.apiKey`**（`<implId>` = `zhipu_coding_plan` / `zhipu_api`）：由 tool 从该处构造 cfg 入参 `{ apiKey: <secret> }`，每次 `search`/`isAvailable` 调用时传入。impl 不依赖 `this.cfg` 取凭证（无 env 回退）。
- **key 空抛错语义**：`isAvailable(cfg) === !!(cfg.apiKey && cfg.apiKey.length > 0)`；`search` 中 cfg.apiKey 空 → 抛 `Error('zhipu provider 未配置 apiKey')`，tool 层 catch 转 ToolError。

**plugin.json（v0.0.123 — 2 extImpls，参照 llm_anthropic 1-plugin-2-impls）**：
```json
{
  "id": "zhipu_web_search",
  "label": "__MSG_plugin.builtin.zhipu_web_search.label__",
  "description": "__MSG_plugin.builtin.zhipu_web_search.description__",
  "extImpls": [
    { "implId": "zhipu_coding_plan", "point": "web_search_provider",
      "impl": "./zhipu-coding-plan-provider.ts",
      "description": "__MSG_plugin.builtin.zhipu_web_search.impl.zhipu_coding_plan.description__" },
    { "implId": "zhipu_api", "point": "web_search_provider",
      "impl": "./zhipu-api-provider.ts",
      "description": "__MSG_plugin.builtin.zhipu_web_search.impl.zhipu_api.description__" }
  ]
}
```
> `configSchema` 已 v0.0.72 删除（secret 不进 manifest configSchema，对齐 v0.0.67 D1）。plugin `id` 保持 `zhipu_web_search`（避免 policy/scope 连锁）。

**API — zhipu_coding_plan（MCP 端点，实测连通 2026-07-12）**：
```
POST https://open.bigmodel.cn/api/mcp/web_search_prime/mcp
Header: Authorization: Bearer <apiKey> ; Accept: application/json, text/event-stream
两步（鉴权绑 session）：① initialize 握手 → 响应头 mcp-session-id
                        ② tools/call { name:"web_search_prime", arguments:{ search_query } } 带 session 头
Resp: SSE（data: 行内 JSON-RPC）；result.content[0].text 双重 JSON 编码 [{title,link,content,publish_date?,...}]
```

**API — zhipu_api（REST 端点，v0.0.123 从 git `0b64ae54^` 恢复）**：
```
POST https://open.bigmodel.cn/api/paas/v4/web_search
Header: Authorization: Bearer <apiKey>  ; Content-Type: application/json
Body: { search_query, search_engine:"search_std", search_intent:false, count }
Resp: { search_result: [{ title, link, content, publish_date, ... }] }
```

**WebSearchProvider 实现（两 impl 同一契约形状，仅 label + 出站 API 不同）**：两个独立文件 `zhipu-coding-plan-provider.ts`（MCP）/ `zhipu-api-provider.ts`（REST），各 `export default class ZhipuWebSearchProvider`，构造器 `(implId, _cfg)` 只存 `this.id=implId`（cfg 不取凭证，保留签名兼容 PluginManager 实例化链路）。
```typescript
// 两 impl 共性骨架（label + search 出站细节各异）
class ZhipuWebSearchProvider {
  readonly id: string;                       // = implId（registry 自识别）
  constructor(implId: string, _cfg = {}) { this.id = implId; }
  get label(): string {
    // coding-plan-provider.ts → '智谱 · Coding Plan（订阅额度）'
    // api-provider.ts         → '智谱 · API（按量计费）'  （两 label 必不同，供 ToolError {label} 区分）
    return /* impl-specific */ '';
  }
  isAvailable(cfg: WebSearchCfg = {}): boolean {   // cfg.apiKey 非空 → true（禁 I/O）
    return typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0;
  }
  async search(query, opts, cfg: WebSearchCfg = {}, signal?) {
    const apiKey = cfg.apiKey;
    if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('zhipu provider 未配置 apiKey');
    // coding_plan：MCP 两步 initialize→tools/call（webFetch=proxyFetch）
    // api：单次 REST POST /web_search（同走 proxyFetch）；两者结果都经 mapZhipuResults → WebSearchResult
  }
}
```
> 出站走 `proxyFetch` 统一代理层（不改真实请求参数/协议；v0.0.190 起 AT record/replay 拦截层已删，不再有 pickWebFetch 决策）。

**响应映射（两 impl 一致，`search_result[]`/MCP items → `WebSearchResult`）**：
| WebSearchResult 字段 | Zhipu 来源 |
|---|---|
| `results[].title` | `search_result[].title` |
| `results[].url` | `search_result[].link` |
| `results[].snippet` | `search_result[].content`（截断为 snippet 长度，原 content 偏长） |
| `results[].publishedDate` | `search_result[].publish_date` |
| `results[].score` | （Zhipu 无，省略） |
| `answer` | （Zhipu 不直接返回综合 answer；`search_intent` 是意图分析，不映射 answer，省略） |

> 两 impl 调用均走 `proxyFetch` 代理层（复用 web_fetch 同源，共性 §6）。超时 30s（provider 自带）。

## 8. 边界

| 零件 | 归属 |
|---|---|
| WebSearchProvider 协议 + WebSearchResult 类型 + web_search_provider EP + web_search Tool + Zhipu 两 impl（`zhipu_coding_plan` MCP / `zhipu_api` REST） | 本文 ✅ |
| EP cardinality/group/list 解析 | `plugin_system/extension_point_interface.md` / `plugin_manager_interface.md` |
| **[v0.0.72] app_config.web_search group（凭证归属）** | `specs/tech/config/[P0]app_config.md` §3.6 |
| 共性约定（代理/截断/包装/超时） | `[P1]web_tools.md` §2 |
| 串行执行 + ToolResultBlock 包装 | `tool_execution_engine.md` |
| **其他 provider**（Tavily/Google/Bing/...） | 后续以插件 ext impl 贡献（协议不变） |

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
