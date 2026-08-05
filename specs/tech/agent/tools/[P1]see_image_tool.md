---
type: spec
title: See Image Tool（视觉理解 · 协议 + List EP + app_config 路由）
priority: P1
status: active
updated: 2026-07-22
since: v0.0.141
---

# See Image Tool — 协议 + List EP + app_config 路由（视觉理解）

see_image 工具：给一段文字 + 若干**本地图片路径** → 返回对图片的**文字理解**。与 web_search **完全同构**（provider 协议 + list 扩展点 + `app_config` 凭证路由 + 未配置精确报错），仅把「search(query)→结果列表」换成「understand(text, imagePaths[])→文字理解」。范式蓝本见 `[P1]web_search_tool.md`；调研依据 `specs/research/v0.0.141-see-image.md`。

> **硬约束（不可违反）**：**base64 / 图片二进制内容绝不进 tool 入参或出参**。tool 入参只有本地路径（相对 workspace 或绝对）+ 文字；出参只有文字理解结果。读文件 → base64 只在 **provider impl 内部**（→ 出站 API 传输环节）出现，杜绝图片二进制撑爆主对话上下文。

## 1. 概述

```
LLM → see_image Tool（统一 schema {text, imagePaths[]}）
      → resolveProvider 读 app_config.see_image → 按 type 在 list EP 精确匹配 impl
      → 路径校验：ctx.workdir resolve 相对路径 → 绝对路径 + 存在/可读/图片格式校验（tool 层，不读内容）
      → provider.understand(text, absPaths, cfg, signal)  ← base64 只在 impl 内部
      → SeeImageResult{text} → wrapExternalContent + 截断 → ToolResultBlock
```

双 vender（同 EP，各自 key 隔离）：`minimax_m3`（MiniMax-M3 anthropic 兼容端点，**多图有序**）/ `zhipu_image`（智谱 GLM 视觉 REST 直调，**仅 1 图**）。

## 2. SeeImageProvider 协议（权威契约）

```typescript
/** 视觉理解后端提供方契约（由插件 ext impl 实现）。凭证不进协议，归 app_config see_image group。 */
interface SeeImageProvider {
  /** provider 唯一 id（snake_case，与 ext impl implId 对应） */
  id: string;
  /** 展示名（配置 UI / 错误提示用） */
  label: string;
  /**
   * 是否可用（如凭证是否配置）。**禁止做 I/O**（只查内存 cfg.apiKey），否则每次 assemble 阻塞。
   * cfg 由 tool 从 app_config.see_image.credentials[type] 构造传入。
   * 返回 false → Tool 返精确错误（"vender X 不可用 / 凭证未配置"），不静默换 vender。
   */
  isAvailable(cfg: SeeImageCfg): boolean;
  /**
   * 执行视觉理解。
   * @param text       提问文字（可空串）
   * @param imagePaths **绝对路径数组**（tool 已用 ctx.workdir resolve + 校验存在/图片格式）；顺序有语义
   * @param cfg        不透明 map（tool 从 app_config 构造，含 apiKey）
   * @param signal     取消信号（透传 ctx.signal）
   * 读文件 → base64 只在本方法内部完成；出站 fetch 走 proxyFetch（统一代理层）。
   * 失败（key 空 / API 错误 / vender 能力限制如 zhipu 图数≠1）抛 Error → tool 层 catch 转 ToolError。
   */
  understand(
    text: string,
    imagePaths: string[],
    cfg: SeeImageCfg,
    signal?: AbortSignal,
  ): Promise<SeeImageResult>;
}

/** 不透明配置 map（tool 从 app_config.see_image.credentials[type] 构造传入）。impl 期望 { apiKey?: string }。 */
type SeeImageCfg = Record<string, unknown>;

interface SeeImageResult {
  provider: string;   // provider.id
  text: string;       // 文字理解结果（vender 对 图片+文字 的综合理解）
  count: number;      // imagePaths.length
  tookMs: number;
}
```

> 协议**只定义 understand 行为**，不定义 Tool schema（本工具统一）、不读写凭证（凭证归 `app_config.see_image` group，§2.5/§4）、不知 ctx.workdir（路径 resolve 归 tool 层，见 §4）。
> **凭证读取（对齐 web_search v0.0.72）**：PluginManager 仍按 `(implId, cfg)` 实例化，但 impl **不从构造器 cfg / env 取凭证**——`isAvailable`/`understand` 统一从运行时入参 cfg 读。构造器 cfg 仅保留签名兼容。

## 3. see_image_provider 扩展点（list，单点路由）

内置 EP，位于 `app/server/src/plugin/extension-point.ts` 的 `BUILTIN_EXTENSION_POINTS`：

```typescript
/** see_image_provider：list，承载可插拔视觉后端（多 impl 共存，按 app_config.see_image.type 单点路由）。 */
export const SeeImageProviderPoint: ExtensionPoint = {
  id: 'see_image_provider',
  cardinality: 'list',
  description: '__MSG_extpoint.see_image_provider.description__',
};
```

- **cardinality=`list`**：注册表枚举多个 impl 共存（minimax_m3 / zhipu_image）；tool 按 `app_config.see_image.type` 精确选一个调用，**不并发融合**（一次理解仍由一个 vender 答）。
- **group=`vision`**：分区（v0.0.71 起 group 归属在 `app/plugins/groups.json`，不在 EP 常量上）。新增 `vision` group（extPoints=`["see_image_provider"]`），承载未来其他视觉 provider 类 EP。
- **scope 激活**：`app/plugins/scopes/default.yaml` 加 `vision` group → `see_image_provider` → impls `[minimax_m3, zhipu_image]`（在的就是 enabled）。

## 4. see_image Tool 层

```typescript
const seeImageTool: Tool = {
  definition: {
    name: 'see_image',
    description:
      'Understand local image(s). Input a question + local image paths (relative to workspace or absolute); returns a text understanding. Multiple images are ordered. Never pass base64 — pass file paths.',
    inputSchema: {
      type: 'object',
      required: ['text', 'imagePaths'],
      properties: {
        text: { type: 'string', description: 'question / instruction about the image(s)' },
        imagePaths: { type: 'array', items: { type: 'string' },
          description: 'local image file paths (ordered; relative to workspace or absolute). Never base64.' },
      },
    },
  },
  defaultTimeoutMs: 90000,   // 视觉理解较慢（多图 base64 出站 + 模型推理），高于 web 工具 30s

  async run(input, ctx) {
    // 1. resolveProvider：读 app_config.see_image → 按 type 在 list EP 精确匹配（3 错误分支，不静默回退）
    const { provider, cfg } = resolveProvider(ctx);
    if (!provider) return errorResult('see_image 未配置 vender type（app_config.see_image 缺失或 type 未配置）');
    if (!provider.isAvailable(cfg)) return errorResult(`vender ${provider.label} 不可用（凭证未配置?）`);
    // 2. 解析 + 校验 imagePaths（非空数组；resolve 相对路径 + 存在/可读/图片格式；tool 层不读内容→base64）
    // 3. provider.understand(text, absPaths, cfg, ctx.signal) 在 try/catch 内（含 zhipu 图数≠1 抛错）
    // 4. serializeResult + wrapExternalContent + truncate(WEB_TOOLS_MAX_CHARS) → textResult
  },
};
```

### 4.1 resolveProvider（与 web_search 同构）

读 `ctx.config.appConfig.get('see_image','default')` → 取 `data.type` → 在 `ctx.config.pluginManager.getExtensionImpls(SeeImageProviderPoint)` 中 `find(p=>p.id===type)` → `cfg = credentials[type] ?? {}`。凭证从不进协议，仅运行时 cfg 入参透传。**复用 web_search 已注入的 `ctx.config.appConfig` + `ctx.config.pluginManager`（session-config 构造期注入，无新增装配）。**

### 4.2 路径 resolve + 校验（tool 层，不读内容）

- 相对路径经 `ctx.workdir` resolve 成绝对路径（`path.isAbsolute(p) ? p : path.resolve(ctx.workdir, p)`）；LLM 直接给绝对路径也兼容。
- 逐路径校验：文件存在 + 是文件（`fs.promises.stat`）+ 扩展名 ∈ `{png,jpg,jpeg,gif,webp}`。**只做 stat + 扩展名判断，不读文件内容**（base64 归 provider）。
- 校验失败 → errorResult（见 §4.3 分支 4~6）。校验通过的**绝对路径**数组传给 `provider.understand`。

### 4.3 错误分支（均返 ToolError，不静默回退）

| # | 分支 | content 文本 |
|---|------|-------------|
| 1 | `app_config.see_image` 缺失 / `data.type` 未配置 | `see_image 未配置 vender type（app_config.see_image 缺失或 type 未配置）` |
| 2 | `type` 对应 impl 未激活 | 同 1（provider undefined 走同一 errorResult） |
| 3 | `isAvailable(cfg)===false`（key 空） | `vender {label} 不可用（凭证未配置?）` |
| 4 | imagePaths 非数组 / 空 | `see_image: imagePaths is required（非空本地路径数组）` |
| 5 | 某路径不存在/不可读 | `see_image: 图片路径不存在或不可读: {path}` |
| 6 | 某路径非图片格式 | `see_image: 不支持的图片格式: {path}（支持 png/jpg/jpeg/gif/webp）` |
| 7 | `understand` 抛错（API 错误 / zhipu 图数≠1 / key 空防御） | `see_image provider "{label}" 调用失败: {msg}` |

> 分支 1~3 = PRD「未配置报错三分支」（对齐 web_search `resolveProvider`）。zhipu 单图约束的报错经 provider 抛 Error → 分支 7（msg 含「智谱视觉 vender 仅支持 1 张图片，当前传入 N 张」）。

Tool 注册到 `defaultTools()`（`registry.ts`），按 `definition.name='see_image'` 路由。TOOL_POLICY bound 见 §6。

## 5. 内置 vender（2 个独立 impl，1 plugin）

新 builtin plugin `app/plugins/builtins/see_image/`（`plugin.json` + 2 provider `.ts`），builtin-loader 自动发现（目录名==manifest.id）。两 impl 同 `see_image_provider` list EP，各自 key 隔离（`app_config.see_image.credentials.<implId>.apiKey`），`isAvailable(cfg)=!!cfg.apiKey`，构造器 `(implId,_cfg)` 只存 `this.id=implId`（cfg 不取凭证）。出站均走 `proxyFetch`（统一代理层；不改真实请求参数）。**零新第三方依赖**（仅 node `fs`/`path` + 复用 server 的 proxyFetch/undici）。

### 5.1 minimax_m3（MiniMax-M3 · anthropic 兼容 · 多图有序）

- **端点/写死常量**：`endpoint = https://api.minimaxi.com/anthropic/v1/messages`；`model='MiniMax-M3'`；`temperature=1.0`；`max_tokens=2048`（可调）。**全写死在 impl 内，不做配置项、不挂平台 LlmClient/provider/protocol**（req 裁决）。
- **请求 body（轻量自拼，照 `tests/e2e/vision_check.py` 实测蓝本）**：
  `{ model, max_tokens, temperature, messages:[{ role:'user', content:[ ...imageBlocks（按 imagePaths 顺序）, {type:'text', text} ] }] }`。
- **image block**：`{ type:'image', source:{ type:'base64', media_type, data:<裸b64> } }`（media_type 按扩展名推断）。**多图 = content 数组内按 imagePaths 顺序排多个 image block**（顺序即模型理解顺序）。
- **headers**：`Content-Type: application/json` + `Authorization: Bearer <cfg.apiKey>` + `anthropic-version: 2023-06-01`。
- **响应**：取 `result.content[]` 中 `type==='text'` 的 text 拼接为理解结果。
- **label**：`MiniMax · M3（多图视觉理解）`。
- 不复用 `encodeAnthropicMessages`（带 cache_control/tool 等平台耦合，用不上）；仅借「base64 image block 结构」知识 + record/replay fetch 装饰。

### 5.2 zhipu_image（智谱 GLM 视觉 · REST 直调 · 单图）

- **单图约束**：`understand` 首行 `if (imagePaths.length !== 1) throw new Error('智谱视觉 vender 仅支持 1 张图片，当前传入 ' + imagePaths.length + ' 张')`（不静默截取/降级）。
- **端点/写死常量**：`endpoint = https://open.bigmodel.cn/api/paas/v4/chat/completions`；`model='glm-4.5v'`（写死；若真 key 拒绝可换 GLM 视觉系模型名，用户自测）。
- **请求 body（OpenAI 兼容多模态，base64 data URL）**：
  `{ model, messages:[{ role:'user', content:[ {type:'text',text}, {type:'image_url', image_url:{ url:'data:<media_type>;base64,<b64>' }} ] }] }`。
- **headers**：`Content-Type: application/json` + `Authorization: Bearer <cfg.apiKey>`。
- **响应**：取 `result.choices[0].message.content` 为理解结果（OpenAI 兼容形）。
- **label**：`智谱 · GLM 视觉（单图）`。
- 与现有 `zhipu-api-provider.ts`（web_search REST）同骨架；req 事实澄清：不走 zai-mcp（packaged 零风险取舍，见调研 §4.4）。

### 5.3 plugin.json

```json
{
  "id": "see_image",
  "label": "__MSG_plugin.builtin.see_image.label__",
  "description": "__MSG_plugin.builtin.see_image.description__",
  "extImpls": [
    { "implId": "minimax_m3", "point": "see_image_provider", "impl": "./minimax-provider.ts",
      "description": "__MSG_plugin.builtin.see_image.impl.minimax_m3.description__" },
    { "implId": "zhipu_image", "point": "see_image_provider", "impl": "./zhipu-image-provider.ts",
      "description": "__MSG_plugin.builtin.see_image.impl.zhipu_image.description__" }
  ]
}
```
> 无 `configSchema`（secret 不进 manifest；凭证唯一源 = `app_config.see_image.credentials.<implId>.apiKey`，对齐 web_search v0.0.72 D1）。

## 6. 工具注册范围（TOOL_POLICY bound — 除 squad-chat 外）

`'see_image'` 加进 `TOOL_POLICY` 的 `playground-rocky` / `studio-leader` / `studio-mate` / `subagent` 四 bound（与 web_search 完全同款分布）；**不加 `studio-squad`**（squad-chat 群聊哑路由，bound 仅 `send_message`）。改 bound = 改源码经版本评审（`tool-policy.ts`，不进 dev-config/UI）。工具名字符串 `'see_image'` == `definition.name`。

## 7. 凭证配置（app_config.see_image group）

- **数据契约**：`app_config` 的 `see_image` group、`key='default'` 单实例，data 形 `{ type: string, credentials: Record<implId,{apiKey?}> }`（自由 KV group，无需 schema 预注册，对齐 web_search）。
- **端点**：`GET/PUT /config/app?group=see_image&key=default`（复用现有 `/config/app`，见 `specs/api/overall/03-config-center.md §2` + `08a-see-image-tool.md`）。secret（apiKey）走前端 `SecretInput` 展示层 mask。
- **前端**：`section-see-image-config.tsx` 自渲染 section（type 下拉 + 每 vender SecretInput，saveMode='item' 自管 GET/PUT），注入应用设置 → 工具 tab（`section-tab-panel.tsx` 的 `tools` case，紧邻 web_search/web_fetch 下方）。implId-agnostic（inventory 驱动下拉）。组件 spec + testid 契约由 coder 编码前置产出（`specs/ui/components/app-dev-config-page/section-see-image-config/`，照 `_conventions.md` + section-web-search-config 类比）。

## 8. @图片 mention（零前端改动）

`@file` mention 在消息文本内嵌 `<mention type="file" path="..." />`（相对 workspace 路径，见 `specs/tech/mention/message-content.md`）。LLM 读到路径文本 → 调 `see_image({text, imagePaths:[path]})`。tool 用 ctx.workdir resolve 相对路径 → 绝对路径读文件。base64 不进上下文，符合硬约束——**无需任何 mention 前端改动**。

## 9. 共性约定 + 边界

- 截断/包装：复用 `web-tools-utils.ts` 的 `wrapExternalContent`（untrusted 防 injection）+ `truncate(WEB_TOOLS_MAX_CHARS)`。
- 超时：provider 内部自带超时（建议 90s，视觉较慢）+ 透传 `ctx.signal`；tool `defaultTimeoutMs=90000`（engine 硬天花板 600s）。
- 出站：必走 `proxyFetch` 统一代理层（v0.0.190 起 AT record/replay 拦截层已删，不再有 pickWebFetch 决策）。
- packaged：零新第三方依赖 → build-plugins 自动扫描 `builtins/see_image` 编译 `.cjs`（server import external `@app/server`，undici/fs 已 external/builtin）+ copyResources 自动带 scopes/groups.json。**无需改 `build-plugins.ts`**，但 coder MUST 跑 `bun run scripts/build-plugins.ts` 验证产物含 `see_image/*.cjs`。

| 零件 | 归属 |
|---|---|
| SeeImageProvider 协议 + SeeImageResult + see_image_provider EP + see_image Tool + 2 impl | 本文 ✅ |
| EP cardinality/group 解析 | `plugin_system/[P0]extension_point_interface.md` |
| app_config.see_image group（凭证归属） | `specs/tech/config/[P0]app_config.md`（照 web_search §3.6 类比） |
| 共性约定（代理/截断/包装/超时） | `[P1]web_tools.md §2` |
| 串行执行 + ToolResultBlock 包装 | `[P0]tool_execution_engine.md` |
| tool bound 分布 | `[P0]tool_policy.md` |

> 变更历史见 `log.md` + `specs/tech/version_logs/v0.0.141.see_img/change_log.md`。
