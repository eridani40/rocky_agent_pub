# v0.0.141.see_img — API 变更日志（see_image 视觉理解工具）

> 日期：2026-07-14
> 类型：新增（new agent tool 协议面 + app_config group，无新增 HTTP 端点）
> 对应 overall：新增 `specs/api/overall/08a-see-image-tool.md`
> 权威：`specs/tech/agent/tools/[P1]see_image_tool.md`

## 变更摘要

新增 `see_image` agent tool 的 API 面。**无新增 HTTP 端点**——工具协议面（ToolDefinition + ToolResultBlock isError 分支）经 `POST /session/:id/messages` 触发 + SSE `tool_call`/`tool_result` 事件观察；凭证配置复用现有 `/config/app`；EP 经现有 `/config/plugin` inventory 透传。

## 1. 工具协议面（新增，无端点）

- `see_image` ToolDefinition：`name='see_image'`，`inputSchema={ required:['text','imagePaths'], properties:{ text:string, imagePaths:string[] } }`。**imagePaths 只承载本地路径，禁 base64**（硬约束）。
- 输出 ToolResultBlock：正常 = markdown 文字理解（wrapExternalContent untrusted + 截断 ~100k）；isError 分支 = type 未配置 / impl 未激活 / vender 不可用 / imagePaths 空 / 路径不存在 / 非图片格式 / vender 调用失败（含 zhipu 图数≠1）。详见 `08a-see-image-tool.md §2.2`。

## 2. app_config `see_image` group（复用 `/config/app`，无新增端点）

- `GET/PUT /config/app?group=see_image&key=default`，单实例 data 形 `{ type: string, credentials: Record<implId,{apiKey?}> }`（自由 KV group，无需 schema 预注册）。
- secret 语义对齐 web_search（`08-web-tools.md §5.1` v0.0.135）：GET 返明文，前端 SecretInput mask；PUT 整组 `items:[{key:'default', data:{type,credentials}}]`。
- 错误码沿用 `03-config-center.md` §2.3（400/404），无新增。

## 3. EP inventory 透传（复用 `/config/plugin`，无新增端点）

- `see_image_provider`（cardinality=`list`, group=`vision`）入 `BUILTIN_EXTENSION_POINTS` → `GET /config/plugin` inventory `tree.groups[].points[]` 自动含该 point + 两 impl（`minimax_m3` / `zhipu_image`）。

## 4. 关键用户路径 → AT/UT 映射

| ID | 路径 | 验证 |
|----|------|------|
| SI-1 | minimax 配 key → @多图有序 → see_image → 文字理解 → LLM 回复 | AT（MiniMax replay 双关，SSE tool_call/tool_result 观察，base64 不进上下文） |
| SI-2 | zhipu_image 图数≠1 → 报错 | UT（确定性契约，isError 含「仅支持 1 张图片」） |
| SI-3 | 未配置 vender → 报错 | UT（确定性契约，isError 含「未配置 vender type / 凭证未配置」） |

## 5. 无变更项

- 无新增/修改 HTTP 端点、状态码、请求/响应 schema（工具协议面走 tool_call/tool_result 事件；配置/EP 复用现有端点）。
- SSE `tool_call`/`tool_result` 事件形态不变（see_image 是新工具名，事件结构沿用 `04-agent-session.md §3.2`）。
