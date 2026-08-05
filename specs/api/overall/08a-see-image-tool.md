# See Image Tool API（v0.0.141 — see_image 视觉理解工具协议面 + app_config 配置）

> version: 1.0 `[v0.0.141]` · 引入版本 v0.0.141 · 2026-07-14
> 管什么：v0.0.141 引入的 `see_image` agent tool（LLM 可调）的工具协议面契约（`ToolDefinition`：name/description/inputSchema + 输出 ToolResultBlock 形态 + isError 分支）+ app_config `see_image` group 凭证配置（复用 `/config/app`）+ `see_image_provider` EP inventory 透传。
> 不管什么：工具内部实现（base64 编码 / vender 出站 API / 路径 resolve 细节 → `specs/tech/agent/tools/[P1]see_image_tool.md`）；session/messages/SSE 通用契约（→ `04-agent-session.md`）；web tools（→ `08-web-tools.md`）。
> **本文件是 AT（API Test）see_image 域的唯一依据**：黑盒 curl + SSE 观察，不读代码。

## 1. 概述

see_image 让 agent「看懂」本地图片：输入一段文字 + **本地图片路径数组**（有序），输出对图片的**文字理解**。与 web_search 同范式（provider 协议 + list EP + app_config 凭证路由 + 未配置精确报错），仅把「search→结果列表」换成「understand→文字理解」。注册到 `defaultTools()`，LLM 经 `tool_call` 调用、产出 `tool_result`（详见 `04-agent-session.md` §3.2 + SSE `tool_call`/`tool_result` 事件）。**工具本身无独立 HTTP 端点**——契约是「input schema + 输出 ToolResultBlock 形态」。

**硬约束**：base64/图片二进制**绝不进** tool 入参（arguments.imagePaths 只有本地路径）或出参（ToolResultBlock 只有文字理解）——读文件→base64 只在 vender impl 内部。

**HTTP facade 面**（客户端直接调）：app_config `see_image` group —— 复用现有 `GET/PUT /config/app?group=see_image&key=default`（见 `03-config-center.md` §2）。**无新增端点**。

**EP inventory 面**：`see_image_provider`（`list`，group=vision）经 `GET /config/plugin` inventory 透传（见 `03-config-center.md` §3.1）。凭证归 `app_config.see_image`，**不走 ext impl configSchema**。

## 2. see_image 工具

### 2.1 ToolDefinition

```typescript
{
  name: "see_image",
  description: "Understand local image(s). Input a question + local image paths (relative to workspace or absolute); returns a text understanding. Multiple images are ordered. Never pass base64 — pass file paths.",
  inputSchema: {
    type: "object",
    required: ["text", "imagePaths"],
    properties: {
      text: { type: "string" },
      imagePaths: { type: "array", items: { type: "string" } }
    }
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | ✅ | 对图片的提问 / 指令 |
| `imagePaths` | string[] | ✅ | **本地图片路径数组**（相对 workspace 或绝对；**有序**，顺序有语义）。**禁 base64** |

### 2.2 输出 ToolResultBlock（content 为单个 text block）

| 分支 | isError | content[0].text |
|------|---------|-----------------|
| 正常 | false | markdown：`## Understanding (provider: <id>, count: <n>, took: <ms>ms)` + 文字理解正文；整段 wrapExternalContent 标 untrusted；超 ~100k 截断 |
| type 未配置 | **true** | `see_image 未配置 vender type`（`app_config.see_image` 缺失或 `data.type` 缺失） |
| type 对应 impl 未激活 | **true** | 同上（provider 解析不到走同一 errorResult） |
| vender 注册但不可用 | **true** | `vender <label> 不可用（凭证未配置?）`（isAvailable() 返 false；apiKey 未配） |
| imagePaths 非数组/空 | **true** | `see_image: imagePaths is required（非空本地路径数组）` |
| 路径不存在/不可读 | **true** | `see_image: 图片路径不存在或不可读: <path>` |
| 非图片格式 | **true** | `see_image: 不支持的图片格式: <path>（支持 png/jpg/jpeg/gif/webp）` |
| vender 调用失败 | **true** | `see_image provider "<label>" 调用失败: <msg>`（API 错误；或 zhipu 图数≠1 时 msg 含「智谱视觉 vender 仅支持 1 张图片，当前传入 N 张」） |

**provider 解析**（list 单点路由）：`resolveProvider` 读 `app_config.see_image.default` → 按 `type` 在 `see_image_provider` list EP 全部 impl 中精确匹配 `impl.id` → `cfg = credentials[type] ?? {}` 传入。`isAvailable()` **禁止 I/O**（只查内存 `cfg.apiKey`）。**路径**由 tool 层用 `ctx.workdir` resolve 相对路径成绝对 + 存在/图片格式校验（不读内容→base64），校验通过的绝对路径传 vender。

**内置 vender（2 个独立 impl，plugin `see_image`）**：
- `minimax_m3`（label「MiniMax · M3（多图视觉理解）」，anthropic 兼容 `api.minimaxi.com/anthropic/v1/messages`，base64 image block，**多图按顺序**；model=MiniMax-M3 / temperature=1.0 / endpoint 写死）。
- `zhipu_image`（label「智谱 · GLM 视觉（单图）」，REST `open.bigmodel.cn/api/paas/v4/chat/completions`，image_url base64 data URL，model=glm-4.5v 写死；**imagePaths.length≠1 → 报错**）。

两 impl 凭证 apiKey 各走 `app_config.see_image.credentials.<implId>`（不进 ext impl configSchema）。

## 3. app_config `see_image` group（复用 `/config/app`）

**无新增端点**——复用现有 `GET /config/app?group=see_image&key=default` + `PUT /config/app`（见 `03-config-center.md` §2）。自由 KV group（无需 schema 预注册）。单实例 `key='default'`，data 形：

```typescript
interface SeeImageConfig {
  type: string;                                       // 选中的 vender implId（minimax_m3 / zhipu_image）
  credentials: Record<string, { apiKey?: string }>;   // 按 implId 隔离的凭证；apiKey secret
}
```

### 3.1 secret 语义（apiKey — GET 明文 + 前端 SecretInput mask）

对齐 web_search（`08-web-tools.md §5.1` v0.0.135 统一套路）：`GET` 返回 `apiKey` **明文**（secret mask 收敛前端 `SecretInput` 展示层）；`PUT` 整组提交 `{group:'see_image', items:[{key:'default', data:{type, credentials}}]}`。记录缺失（从未配过）→ GET `value` 为 null，消费方走「未配置 vender type」isError 分支。

## 4. EP inventory 透传（`/config/plugin` GET）

`see_image_provider`（`list`, group=`vision`）加入 `BUILTIN_EXTENSION_POINTS`。**无新增端点**——经现有 `GET /config/plugin` inventory 自动透传（见 `03-config-center.md` §3.1）：`tree.groups[].points[].impls[]` 中 `point='see_image_provider'` 节点含内置两 impl（`minimax_m3` / `zhipu_image`）。UI 渲染 type 下拉（应用设置 → 工具 → see_image section）；tool 按 `app_config.see_image.type` 单点路由。apiKey 凭证经 `PUT /config/app { group:"see_image", ... }` 写入（非 `/config/plugin`）。

## 5. AT 覆盖（PRD 关键用户路径 SI-1/SI-2/SI-3）

| 路径 | 覆盖 | 观察 |
|------|------|------|
| SI-1 minimax 多图有序 → 文字理解 → LLM 回复 | AT（MiniMax replay 双关） | `POST /session/:id/messages` 触发 run → SSE `tool_call`（name=see_image, imagePaths 数组）→ `tool_result`（isError:false，文字理解，无 base64）→ assistant 文本 |
| SI-2 zhipu 图数≠1 报错 | UT（确定性契约） | `tool_result` isError:true，含「仅支持 1 张图片」 |
| SI-3 未配置报错 | UT（确定性契约） | `tool_result` isError:true，含「未配置 vender type / 凭证未配置」 |

> 工具调用的「错误」走 ToolResultBlock 的 `isError:true` 分支（非 HTTP 错误码），经 SSE `tool_result` 事件观察。config app_config `see_image` 端点复用 `03-config-center.md` §2.3 错误码（400/404），无新增。

## 6. 版本

version: 1.0 `[v0.0.141]`：新建 see_image 工具协议面（ToolDefinition + isError 分支）+ app_config see_image group（复用 `/config/app`，apiKey secret）+ see_image_provider EP inventory 透传（list, vision group）。详见 `specs/api/version_logs/v0.0.141.see_img/change_log.md`。
