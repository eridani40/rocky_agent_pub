---
version: v0.0.89
work_block: ②
title: 默认模型 group + 请求设置 group
status: working
updated: 2026-07-07
---

# 工作块 ② — 默认模型 + 请求设置（playground 默认模型 tab 内两个新 group）

> 模型 tab 下新增两个 group：**playground 默认模型**（新 group `app_config/default_models`）+ **请求设置**（暴露 `app_config/llm_request/default` 已有字段，不引入新配置）。
> 决策来源：design-brief §1.2 + §6.3 / §6.4。

## 1. 现状（参考 spec）

- `app_config/llm_request/default` 嵌套对象（`[P0]app_config.md §3.4`）：`{timeout:{ttfb_s,stall_answer_s,stall_think_s,stall_tool_s,wall_max_s}, retry:{max_attempts,backoff_base_s,backoff_cap_s,jitter}, degradation, length, fallback_chain}`
- 现状请求调优参数在前端 dev config 页暴露（`page-dev-config.tsx` 的 `DEV_GROUPS` 含 `llm_request`），实际数据归属 app_config
- **无**「默认会话模型」/「默认整理模型」配置 — 用户每次开新 session 默认 `modelId=undefined`，由 `resolveProviderModel` 兜底取首个 enabled provider 的 default model
- squad 已有 `modelDefault`（per-squad，必填）；session `modelId?` 可空（保留字语义见工作块 ③）

## 2. 目标

### 2.1 新 group `app_config/default_models`（**N1**）

- **group**：`default_models`
- **key**：固定 `default`（单实例，全局一份）
- **data**：`{ chat?: string; summary?: string }`，两字段均 optional

```json
{
  "group": "default_models",
  "key": "default",
  "data": {
    "chat": "01KVC9A2...:claude-sonnet-4-6",
    "summary": "01KVC9B5...:gpt-4o"
  }
}
```

- **data.chat** = 默认会话模型 ModelRef（`providerId:modelId` 格式，由 arch 定 ModelRef 字符串编码；可空 = 未配）
- **data.summary** = 默认整理模型 ModelRef（compact / forked / skill 整理 / memory 整理用，可空 = 未配）
- **可空 + x 清除**：UI `key-model-picker` 选择后右侧显示 x 按钮，点 x 清空（写 `undefined` → 删字段，非空串）
- **缺失语义**：record 不存在 / 字段缺失 = 该类型无默认模型（resolve 链继续往下一步 fallback，详见工作块 ③）
- **消费方**：`resolveProviderModel` 改造读取，详见工作块 ③

### 2.2 暴露 `app_config/llm_request/default` 子字段（**不引入新配置**）

- 暴露两字段：
  - `timeout.stall_tool_s`（number，单位秒，工具调用 stall 超时）
  - `retry.max_attempts`（number，整数，LLM 调用最大重试次数）
- **不暴露**：`ttfb_s` / `stall_answer_s` / `stall_think_s` / `wall_max_s` / `backoff_base_s` / `backoff_cap_s` / `jitter` / `degradation` / `length` / `fallback_chain`（用户视角无关，YAGNI）
- **数据源不变**：仍是 `app_config/llm_request/default` record（data 嵌套对象），UI 仅渲染上述两子字段；保存 = PUT `app_config/llm_request/default` 含**完整** data（前端 GET → 改两字段 → PUT 全量 data，不能只 PUT 两字段以免覆盖其他字段）
- **缺失语义**：record 不存在 → `LlmRequestConfigService.get()` 返回 `DEFAULT_LLM_REQUEST_CONFIG`（`[P0]app_config.md §3.4`，已有），UI 显示默认值（stall_tool_s=120 / max_attempts=3）；保存时若 record 不存在则创建完整 record（其他字段写默认值）

## 3. UI 交互

### 3.1 playground 默认模型 group

- **位置**：模型 tab → 第二个 group（供应商和模型之下，请求设置之上）
- **title**：`playground 默认模型`
- **key**：
  - `chat`：label「默认会话模型」+ `key-model-picker`（详见 §3.3）
  - `summary`：label「默认整理模型」+ `key-model-picker`
- **x 清除按钮**：选了模型后右侧显示 x（testid `key-model-chat-clear` / `key-model-summary-clear`），点 x 清空字段（写入 `undefined`）
- **空状态**：未配时 picker trigger 显示占位「未配置」（灰色），不阻塞保存

### 3.2 请求设置 group

- **位置**：模型 tab → 第三个 group
- **title**：`请求设置`
- **key**：
  - `timeout.stall_tool_s`：label「工具 stall 超时（秒）」+ `key-number`（min=1, max=600, step=1）
  - `retry.max_attempts`：label「LLM 重试次数」+ `key-number`（min=0, max=10, step=1）
- **默认值显示**：record 不存在时显示 `120` / `3`（来自 `DEFAULT_LLM_REQUEST_CONFIG`），灰色提示「默认值」

### 3.3 `key-model-picker` 组件（**N1 + ui spec 待补**）

> 与 chat-input-bar 的 ModelPicker（工作块 ④）**不同的组件**：这是配置页 key 卡片形式的 model 选择器，不是输入框内小图标。

- **trigger**：button（`variant=outline`，与 `key-select` 同样式），高度 32px，宽度自适应内容 + max-width 240px + ellipsis
- **trigger 内容**：未配显「未配置」（灰）/ 已配显 provider label + model label（如「我的 OpenAI / gpt-4o」）
- **菜单**：dropdown（向右下展开，与 `key-select` 同方向），按 provider 分组（group label = provider label），每项 = model label + modelId mono 副标
- **模型列表来源**：每个 enabled provider 的每个 enabled 文本 model（`providers` group records → `data.models[]` filter `enabled && inputModalities.includes('text')`）
- **不显示**：默认项（无「a (默认)」双项语义 — 那是 chat 选择器才有的；这里选了就是固定 ModelRef，要清除用 x）
- **x 清除按钮**：trigger 右侧 16×16 灰色 x，hover 红；点击 = `onChange(undefined)`（清字段，不删 record）

### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-2.1 | 模型 tab → playground 默认模型 group → 点 chat picker → 选「我的 OpenAI / gpt-4o」 → 点 summary picker → 选「我的 OpenAI / gpt-4o-mini」 → 点页面级保存 | 后端 PUT `app_config/default_models/default` 含 `{chat:"<pid>:gpt-4o", summary:"<pid>:gpt-4o-mini"}`；UI 显已保存 |
| UC-2.2 | 承上 → 点 chat 右侧 x → dirty → 保存 | PUT `app_config/default_models/default` 含 `{chat: undefined, summary:"<pid>:gpt-4o-mini"}`（chat 字段从 data 删除） |
| UC-2.3 | 模型 tab → 请求设置 group → 改 stall_tool_s 从 120→180 → 改 max_attempts 从 3→5 → 保存 | 后端 PUT `app_config/llm_request/default` 含**完整** data（其他字段保持 snapshot 值）；UI 显已保存 |
| UC-2.4 | 未配 llm_request record → 打开模型 tab 请求设置 group | stall_tool_s 显「120」（灰提示默认值）；max_attempts 显「3」（灰提示默认值） |
| UC-2.5 | 承 UC-2.4 → 改 stall_tool_s=200 → 保存 | 后端 POST `app_config/llm_request/default` 完整 record（其他字段写默认值 `DEFAULT_LLM_REQUEST_CONFIG`）；下次打开其他字段仍是默认 |
| UC-2.6 | 无任何 enabled provider → 打开 chat picker | 菜单显空状态「无可用 provider，请先在供应商和模型配置」 |
| UC-2.7 | 切 provider.enabled=false → 之前选了该 provider 的 model 当 default_models.chat | 打开 picker 显示原值（不强制清除）；保存时若不改 → 保留原值（不校验 enabled，由 resolve 阶段兜底报错） |

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

### P4：默认模型 group 配置（chat/summary，可空+清除）
- 链路：
  1. 模型 tab → 配 chat + summary → 保存 → resolve 链读到（详见工作块 ③ P7/P8）
  2. 承上 → 清 chat（点 x）→ 保存 → resolve 链 fallback 到 squad / 手动 / 报错
- 关键断言：
  - data 字段空 = 不存在（非空串、非 null）
  - 清除 = `data.chat = undefined`（不删 record）
  - resolve 行为正确（看工作块 ③）
- UC：UC-2.1 + UC-2.2

### P5：请求设置 group 暴露 + 保存
- 链路：
  1. 已有 record → 改两子字段 → 保存 → 完整 data PUT（其他字段不丢）
  2. 无 record → 改两子字段 → 保存 → POST 完整 record（其他字段写默认）
  3. record 不存在 → UI 显示默认值
- 关键断言：
  - 保存时**不**只 PUT 两子字段（避免覆盖 `degradation` / `length` / `fallback_chain`）
  - 默认值显示来自 `DEFAULT_LLM_REQUEST_CONFIG`（不重复定义默认）
- UC：UC-2.3 + UC-2.4 + UC-2.5

## 5. 对齐 ui/tech spec（MANDATORY）

### 5.1 直接复用
- `key-number` primitive（`specs/ui/components/common/`，已存在）
- `component-key-card` 容器（已存在）
- `DEFAULT_LLM_REQUEST_CONFIG`（`specs/tech/config/agent/llm_caller/[P0]llm_request_config.md`，已存在）
- AppConfigService.setGroup 原子提交语义（`[P0]app_config.md §5`）

### 5.2 需 arch 补/改 ui/tech spec
- **N1**（`default_models` 新 group）：
  - tech `specs/tech/config/[P0]app_config.md` += §3.7（`default_models` group data shape）
  - tech `[P0]app_config.md §3.4` 末尾「group 集合」加 `default_models`
  - ui `specs/ui/components/common/` += `component-key-model-picker.md`（primitive：trigger + dropdown + x 清除 + provider 分组菜单）
- **N5**（暴露 `llm_request/default` 子字段）：
  - ui `specs/ui/components/app-dev-config-page/section-default_models-and-request.md` 新增（覆盖两个 group 的渲染）
  - tech 不动（数据归属与 schema 已有，仅 UI 暴露子集）
- **保存语义调整**：dev config 页的 `DEV_GROUPS` 含 `llm_request` 需迁出（v0.0.89 起归「模型 tab → 请求设置 group」，**不再属 dev**）— 影响 `specs/tech/config/[P0]dev_config.md §3.6.1` 该段需重写（迁移归 app_config 模型 tab，dev 删 `llm_request` group）

## 6. 不在本工作块

- chat-input-bar 内的 ModelPicker（工作块 ④）
- resolve 链具体逻辑（工作块 ③）
- dev→app 整体迁移（工作块 ⑤；本块仅涉及 `llm_request` group 在 dev 前端的归属迁移）
