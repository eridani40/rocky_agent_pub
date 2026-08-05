# v0.0.141.see_img — PRD 变更日志（see_image 视觉理解工具）

> 日期：2026-07-14
> 类型：新增（new feature — LLM tool）
> 对应 overall：新增工具，overall 归属由 doc-modifier 阶段 5 落定（见 §6）
> 概念权威源：`specs/tech/agent/tools/[P1]web_search_tool.md`（多 vender 工具架构范式）+ `specs/prd/overall/07-web-tools.md`（web_search 产品化表达）+ 调研报告 `specs/research/v0.0.141-see-image.md`
> 用户裁决：`reqs/[working] v0.0.141.see_img/req.md`

## 变更摘要

新增 **see_image（视觉理解）** 工具：给 agent 一个「看图」能力——输入一段文字 + 若干本地图片路径，输出对图片的文字理解结果。**完全复用 web_search 的多 vender 架构范式**（provider 协议 + list 扩展点 + `app_config` 凭证路由 + 未配置精确报错），仅把「search(query)→结果列表」换成「understand(text, imagePaths[])→文字理解」。

双 vender：
- **minimax_m3**（MiniMax-M3，anthropic 兼容视觉端点，多图有序）
- **zhipu_image**（智谱 GLM 视觉，REST 直调，仅支持 1 图）

本工具**无独立前端展示页面**；仅需在应用设置里配置 vender 的 API key（照 web_search 的 SecretInput section 模式，一笔带过，见 §2.4）。

## 1. 产品定位

**一句话**：agent 能「看懂」用户本地的图片——`@` 一张图问「里面有什么」，agent 调 see_image 得到文字理解后再作答。

**核心价值**：
1. **视觉理解开箱可用**：双 vender 覆盖（MiniMax 多图 / 智谱单图），凭证独立于平台 LLM provider 配置体系。
2. **上下文零污染（硬约束）**：图片 base64 绝不进入主 agent 对话上下文——tool 入参只有本地路径 + 文字，出参只有文字理解结果。避免大量图片数据撑爆上下文。
3. **可插拔**：与 web_search 同范式，未来可加其他视觉后端（协议不变、工具零改动）。

## 2. 功能需求

### 2.1 工具边界（契约）

| 维度 | 契约 |
|------|------|
| 工具名 | `see_image` |
| 输入 | `{ text: string, imagePaths: string[] }` —— 一段文字提问 + **本地图片路径数组**（相对 workspace 或绝对路径） |
| 图片顺序 | **有序，顺序有语义**——按 `imagePaths` 数组顺序传给 vender，模型据此理解图片先后关系 |
| 输出 | **纯文字理解结果**（vender 对图片 + 文字的综合理解），经 untrusted 包装后作为 ToolResultBlock 回 LLM |
| **硬约束（不可违反）** | **base64 / 图片二进制内容绝不进 tool 入参或出参**。读文件 → base64 只在 vender provider 实现内部 → 出站 API 传输环节存在；对话上下文中只有本地路径（入）与文字理解（出） |

### 2.2 vender 行为差异

| vender | implId | 多图支持 | 图片数约束 | 端点/协议 |
|--------|--------|---------|-----------|----------|
| MiniMax-M3 | `minimax_m3` | **支持多图有序** | imagePaths ≥ 1（多张按顺序传） | anthropic 兼容视觉端点（base64 image block，模型/温度=1.0/endpoint 全写死在 impl 内，不做配置项） |
| 智谱 GLM 视觉 | `zhipu_image` | **仅支持 1 图** | **imagePaths.length ≠ 1 → 工具报错** | REST 直调 GLM 视觉 API（image base64，用户已定案：不走 MCP） |

- **zhipu 单图约束**：当选中 vender=`zhipu_image` 且传入图片数 ≠ 1（0 张或多张）时，工具直接返回明确错误（`isError:true`，提示「智谱视觉 vender 仅支持 1 张图片，当前传入 N 张」），不静默截取、不降级。
- **minimax 多图**：按 imagePaths 顺序放多个 image block，顺序即模型理解顺序。

### 2.3 未配置 vender 的行为（用户裁决）

沿用 web_search 的三错误分支，**均返回 ToolError，不静默降级、不跳过**：
- `app_config.see_image` 缺失 / `data.type` 未配置 → 「see_image 未配置 vender type」。
- `type` 对应 impl 未激活 → 「see_image type `{type}` 对应 impl 未激活」。
- vender 已选但 `isAvailable(cfg)=false`（API key 未填）→ 「vender {label} 不可用（凭证未配置?）」。

LLM 收到错误信息后可继续对话（如告知用户去配置 key）。

### 2.4 凭证配置（一笔带过，无独立展示页）

照 web_search 的凭证范式：凭证归 `app_config.see_image` group（`{type, credentials}` 数据形），前端在应用设置的工具 tab 下一个自渲染 section（type 下拉选 vender + 每个 vender 的 `SecretInput` 填 API key），保存走单实例 GET/PUT。**布局稳定性**：section 内控件尺寸位置固定，切换 type 时凭证字段区域高度稳定，不产生跳动。

> minimax_m3 的 key 用 test.env 现有 MiniMax key 即可测；zhipu_image 真 key 由用户自测。

### 2.5 工具注册范围

沿用 `TOOL_POLICY` bound 分布，**除 squad-chat（studio-squad）外的 agent 都可用**：
- 可用：`playground-rocky` / `studio-leader` / `studio-mate` / `subagent`（与 web_search 完全同款分布）。
- 不可用：`studio-squad`（squad-chat 群聊哑路由，只有 send_message）。

### 2.6 @图片 mention（零前端改动）

用户「@一张图片 + 提问」链路已天然可用：`@file` mention 在消息文本内嵌 `<mention type="file" path="..." />`（本地相对路径），LLM 读到路径文本 → 决定调 `see_image({text, imagePaths:[path]})`。tool 入参只有路径 + 文字，符合 base64 不进上下文的硬约束——**无需任何 mention 前端改动**。

## 3. 关键用户路径（MANDATORY — 测试最低覆盖要求）

| ID | 用户操作链路 | 预期结果 | 类型 |
|----|-------------|---------|------|
| **SI-1** | 配置 minimax_m3 key（应用设置 → 工具 → see_image section）→ 会话中 `@` 1~多张本地图片 + 提问 → LLM 调 `see_image({text, imagePaths})`（多图按顺序）→ vender 返回文字理解 → LLM 基于结果回复用户 | `isError:false`，返回图片的文字理解（多图时体现顺序语义）；base64 全程不进上下文；LLM 综合后作答 | API（真 vender，MiniMax test.env key） |
| **SI-2** | vender=`zhipu_image` 时调 `see_image` 传入图片数 ≠ 1（0 张或 2 张以上）→ 工具校验失败 | `isError:true`「智谱视觉 vender 仅支持 1 张图片…」；LLM 收到错误信息可继续对话（如提示改传 1 张 / 换 vender） | API |
| **SI-3** | 未配置任何 vender（`app_config.see_image` 缺失或 key 未填）→ LLM 调 `see_image` | `isError:true`，精确错误提示「未配置 vender / 凭证未配置」；不静默降级；LLM 可告知用户去配置 | API |

**路径数**：3 条（SI-1 主路径多图有序 + 基于结果回复 / SI-2 zhipu 单图约束报错 / SI-3 未配置报错）。每条至少 1 个 API case。

> **测试范围建议**：SI-1 为 LLM 参与 + 真 vender + 图片链路的核心场景（AT 入选标准），建议一条 AT 覆盖（MiniMax replay 双关）。SI-2 / SI-3 为确定性契约校验，可 UT 覆盖（不必占持久 AT 名额）。ET：本工具无独立前端页面（凭证 section 是 web_search section 的类比复刻），无需新增 ET case。最终范围由 orchestrator 在 test-plan 定，用户确认。

## 4. 范围边界

**IN（v0.0.141）**：
- see_image 工具（协议 + list EP + `app_config.see_image` 路由 + tool 层未配置报错三分支）。
- 2 个 builtin vender ext impl：minimax_m3（多图有序）/ zhipu_image（单图，REST 直调）。
- 凭证配置 section（照 web_search，一笔带过）。
- tool 注册到除 squad-chat 外 4 角色。

**OUT（明确排除）**：
| 排除项 | 理由 |
|--------|------|
| 独立的 see_image 前端展示页面 | 用户明确：无独立展示页，仅凭证配置一笔带过 |
| base64 / 图片内容进 tool 入参或出参 | 硬约束——防上下文爆炸（用户裁决，不接受其他方式） |
| zhipu 多图 | vender 能力限制，传入数 ≠1 即报错 |
| zhipu 走真 MCP（zai-mcp-server npx/stdio） | 用户定案改 REST 直调 GLM 视觉 API（packaged + record/replay 零风险） |
| minimax endpoint/模型名/温度做成配置项 | 用户裁决：全写死在 impl 内（model=MiniMax-M3 / temperature=1.0 / endpoint 固定） |
| 挂平台 LLM provider / LlmClient 配置体系 | 用户裁决：see_image vender 独立于平台配置，自带凭证 |

## 5. 设计决策（产品视角）

### 5.1 完全复用 web_search 多 vender 范式
see_image 与 web_search 同构（可插拔视觉/搜索后端、凭证独立、未配置精确报错），复用同一套「provider 协议 + list EP + app_config 路由 + cfg 入参透传」范式——降低认知与维护成本，未来加视觉后端零工具改动。

### 5.2 base64 只在 vender 内部（上下文零污染）
tool 入参/出参只有本地路径 + 文字，base64 仅在 provider 实现内部（读文件 → base64 → 出站 API）出现。杜绝图片二进制进入主 agent 对话上下文导致上下文爆炸——这是本工具区别于「直接把图片塞进消息」的核心产品约束。

### 5.3 未配置即报错（不静默降级）
沿用 web_search：任一凭证/vender 缺失分支都返回 ToolError，LLM 明确知道「没配好」而非静默得到空结果——可引导用户去配置。

### 5.4 vender 能力差异显式暴露为报错
zhipu 单图是 vender 客观能力限制；与其静默截取导致理解偏差，不如显式报错让 LLM/用户知晓（改传 1 张或换 minimax）。

## 6. 对应 overall 同步（doc-modifier 阶段 5）

本工具为新增，overall 归属由 doc-modifier 落定，建议：
- **新增简短工具章节**（或并入 agent tools 类清单）描述 see_image：定位 / 输入输出契约 / base64 硬约束 / 双 vender 行为差异 / 未配置报错 / 注册范围 / 关键用户路径。
- 若 `01-product-framework.md` 有功能全景/工具清单，登记 see_image 一行。
- 凭证 section 若需入 `04-config-center-ui.md`，照 web_search section 的表达最小登记（一句话指向）。

> doc-modifier 判断具体归属；本 change_log 为增量权威，overall 以此对齐。

## 7. 概念对齐（PRD ↔ specs，无新发明）

本 PRD 引用的概念全部对齐 web_search 已有范式，未凭空发明——具体的 EP id / 协议 interface / group 名是 web_search 概念的**同构实例**，由 architect 在 tech spec 落定（类比 web_search）：

| PRD 概念 | 对齐 spec（web_search 范式） | 关系 |
|---------|------------------------------|------|
| vender / provider（视觉后端可插拔） | `[P1]web_search_tool.md` §2 `WebSearchProvider` 协议 | 类比 → `SeeImageProvider`（架构期落 tech spec） |
| `see_image_provider` list EP（单点路由） | 同上 §3 `web_search_provider` list EP | 类比 → 新 EP（架构期落 tech spec） |
| 凭证配置 `app_config.see_image` group（`{type,credentials}`） | 同上 §2.5/§5.2 `app_config.web_search` group | 类比 → 新 group（架构期落 tech spec） |
| 未配置报错三分支（不静默降级） | 同上 §4 `resolveProvider` 三错误分支 | 直接沿用 |
| tool 注册 bound 分布（除 squad-chat） | `[P0]tool_policy.md` / 07-web-tools §7.2.5 | 直接沿用（4 角色，非 studio-squad） |
| SecretInput 凭证 section（type 下拉 + key input） | `specs/ui/.../section-web-search-config` | 类比复刻 → `section-see-image-config`（架构/编码期落 ui spec） |
| @file mention 传本地路径 | `specs/tech/mention/message-content.md` | 直接沿用（零前端改动） |
| record/replay 出站（pickWebFetch ?? proxyFetch） | `[P1]web_search_tool.md` §7 / `web_fetch_tool.md` | 直接沿用（tech 层，PRD 不细化） |
