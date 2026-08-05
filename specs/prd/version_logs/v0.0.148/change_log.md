# v0.0.148 — session 级 effort 推理强度 + 审批模式（绿灯 / always 持久化）

> 两件 session 级、持久化的能力：① effort 4 档选择器（透传到 LLM wire）② 审批模式选择器（绿灯总开关）+ 纠正 v0.0.122 D2（always approve 改 per-session 持久化）。
> 概念权威源：`specs/ui/components/chat-page/component-input-model-picker.md`（input-bar 按钮行 + picker 模式）+ `specs/tech/agent/tools/[P0]tool_permission.md`（三层工具安全 / ApprovalManager）+ `specs/prd/overall/10-tool-permission.md`（审批产品语义）+ `specs/api/overall/04-agent-session.md`（session CRUD）。
> 无设计稿 → 视觉保真度门禁跳过。

## 0. 背景与动机

- **effort 缺位**：session 级只有 `providerId`/`modelId`，缺「本次会话推理强度」开关；Claude/OpenAI 厂商均已把推理强度离散化（`output_config.effort` / `reasoning.effort`），全链路无对应字段（net-new）。
- **always approve 名不副实**：v0.0.122 D2 决策 ApprovalManager 纯内存、重启清空，产品语义「永远同意」与实际行为（重启即失效）不一致；用户期待跨重启仍生效。
- **审批流程缺乏总开关**：危险操作（rm 通配）每次都弹卡，长任务里反复点同意很烦；缺一个 session 级「放行所有 ask」的快捷开关。

本版两件事维度不同，但都 session 级、都持久化，UI 落点都是 input-bar 按钮行（模型选择左侧）。

## 1. 功能 A：effort 推理强度（session 级 4 档）

### 1.1 产品语义

session 新增 `effort` 字段，4 档统一语义，每档映射到厂商具体 wire 值：

| 档位 | 语义（用户可感知） | Claude（`output_config.effort`） | OpenAI（`reasoning.effort`） |
|---|---|---|---|
| **默认**（缺省） | 不传，模型各自默认行为 | 不传字段 | 不传字段 |
| **低** | 省 token、快 | `low` | `minimal` |
| **高** | 更深思 | `high` | `high` |
| **超高** | 最强能力 | `max` | `xhigh` |

- **持久化**：`effort` 写进 session record（跨重启保留），换会话独立（每个 session 自己的 effort）。
- **生效范围**：本 session 后续所有 LLM 请求（主对话 + forked 旁路，如 compact summary、memory extract 等共享 session.effort）。
- **默认档语义**：默认档 = 不传 `output_config.effort` 字段（保持模型厂商默认行为），**不是**传一个 `"default"` 字面值。
- **厂商支持 gap**：当前 dev/test 模型 glm-5.2 / MiniMax 非 Claude/OpenAI，对 `output_config.effort` 的实际支持未验证——产品语义按「传了不支持则被厂商忽略」处理；AT 只验「wire body 含 `output_config.effort` 字段且值正确」契约，不验模型行为变化。

### 1.2 实现范围（仅 anthropic_messages）

- **只实现 anthropic_messages protocol**（项目唯一 protocol impl，`encodeAnthropicMessages`）；openai 映射（minimal/high/xhigh）**写进 spec 但暂不实现**（无 openai provider/protocol）。
- 落点（详见架构期 change_plan）：session schema 加 `effort` 字段 → `RequestParams` 加 `effort` → `encodeAnthropicMessages` wire body 注入 `output_config.effort`（默认档不注入）。

### 1.3 UI 落点

input-bar 按钮行（`[模型选择][发送][停止]`）模型选择左侧加一个 effort 选择器（21px trigger，hover 预览 + click 完整菜单，与 `component-input-model-picker` 同款交互模式）：

```
┌──────────────────────────────────────┐
│   ChatComposer / textarea（上段）     │
├──────────────────────────────────────┤
│     [effort][模型选择][发送][停止]    │  ← effort picker 在最左
└──────────────────────────────────────┘
```

- 4 项可选（默认 / 低 / 高 / 超高），hover 预览当前生效档，click 展开完整列表。
- 选中即写 session.effort（PUT /session/:id 透传）→ 立即对后续 LLM 请求生效。
- session running 时 trigger disabled 但仍可见（同 ModelPicker）。
- **新控件 → 需建组件 spec**（`specs/ui/components/chat-page/component-input-effort-picker.md`，架构期/coder 先 spec 后实现）：复用 input-model-picker 的几何/菜单样式/testid 命名规则（trigger `chat-effort-picker` + menu `effort-picker-menu` + item `effort-picker-item-{level}`）。

## 2. 功能 B：审批模式选择器 + always 持久化纠正

### 2.1 always approve 改 per-session 持久化（纠正 v0.0.122 D2）

**产品语义变化（MANDATORY）**：
- **旧行为（v0.0.122 D2）**：ApprovalManager 纯内存，点「永远同意」→ 进程重启即清空，「always」名不副实。
- **新行为（v0.0.148）**：session 新增持久化字段 `alwaysApprovedKeys: string[]`；点「永远同意」→ 写 session 持久化 → **跨 app 重启保留**该会话内的授权。

**范围（per-session）**：
- 维度 = approvalKey 粒度（`{toolName}:{policyId}`，如 `bash:rm-wildcard`）。
- **跨重启**：用户在 session A 点「永远同意 bash:rm-wildcard」→ 重启 app 后回到 session A，同 key 的危险操作仍免弹。
- **换会话重置**：session A 的 always 不影响 session B（session B 同 key 仍弹）。
- 三层工具安全不变：策略层 `checkPermission`、执行层 SecureBashEngine 不动；只动审批层 ApprovalManager 的存储介质（内存 Map → session 持久化字段）。

### 2.2 green light（session 级总开关）

**产品语义**：session 新增 `approvalMode: 'normal' | 'greenlight'`（缺省 `normal`，持久化）。

- **normal**（默认）：审批层按现状走（ask 未在 alwaysApprovedKeys → 弹审批卡）。
- **greenlight**（绿灯）：审批层短路所有 ask——策略层判 ask 时直接放行（不弹审批卡，不等用户回填），等价于「这一类危险操作本会话全部自动同意」。
- **安全边界（MANDATORY）**：绿灯**只动审批层**：
  - 策略层 `deny` 路径**保留**（如 `ssh-read` 仍直接拒绝，绿灯不能绕过策略 deny）。
  - 执行层 SecureBashEngine 沙箱**不变**（绿灯放行的 bash 仍在 seatbelt 内执行，参数漏网仍被 OS 拦）。
- **维度**：session 级（整个会话所有 ask 放行），与 always（approvalKey 粒度）正交。

### 2.3 审批范围不扩大（维持 v0.0.122 现状）

- 仅 bash 工具挂 `checkPermission`：`ssh-read` → deny / `rm-wildcard` → ask。
- 其他工具 `checkPermission` 未实现 = allow（行为不变）。
- 绿灯/always 都只在「审批层放行」生效，不影响「策略层 deny」与「执行层沙箱」。

### 2.4 UI 落点

input-bar 按钮行模型选择左侧加审批模式选择器（与 effort picker 同款几何/交互，紧邻 effort picker）：

```
┌──────────────────────────────────────┐
│   ChatComposer / textarea（上段）     │
├──────────────────────────────────────┤
│  [审批模式][effort][模型选择][发送][停止]│  ← 审批模式 picker 在最左
└──────────────────────────────────────┘
```

- 两项可选：`normal`（普通，缺省）/ `greenlight`（绿灯）。
- trigger 图标语义化（如红/绿圆点 或 shield 图标，具体由组件 spec 定）。
- 选中即写 session.approvalMode → 立即对审批层生效。
- **新控件 → 需建组件 spec**（`component-input-approval-mode-picker.md`）：trigger `chat-approval-mode-picker` + menu `approval-mode-picker-menu` + item `approval-mode-picker-item-{mode}`。
- **审批卡（`component-pending-approval-card`）不动**：绿灯模式下 session 不进 `need_approval` 悬挂（审批层短路），故卡片根本不渲染；normal 模式行为完全同 v0.0.122。

## 3. Session 字段变更（产品语义，schema/protocol 实现归架构期）

`Session` 接口新增 3 个持久化字段（详见架构期 change_plan + api overall 同步）：

| 字段 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `effort` | `'default' \| 'low' \| 'high' \| 'max'` | `'default'` | effort 档位（4 档语义值，default=不传 wire 字段） |
| `approvalMode` | `'normal' \| 'greenlight'` | `'normal'` | 审批模式总开关 |
| `alwaysApprovedKeys` | `string[]` | `[]` | 本会话内「永远同意」的 approvalKey 集合（per-session 持久化） |

- **API 入口**：复用现有 `PUT /session/:id`（`specs/api/overall/04-agent-session.md §2.5`），`UpdateSessionBody` 扩 3 字段（都可选，部分更新语义）；前端 `updateSession` body 扩字段透传。
- **响应形状**：GET /session / GET /session/:id / PUT 响应都返完整 Session（含新字段）；零状态码变更。

## 4. 关键用户路径（MANDATORY — 测试最低覆盖要求）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| **UC-A**（effort） | 打开 session → 点 effort picker → 选「高」→ 发消息触发 LLM 调用 | session.effort 持久化为 `'high'`；LLM 请求 wire body 含 `output_config.effort: 'high'`；重启 app 回同 session 仍显「高」 |
| **UC-A2**（effort 默认档不传） | 新建 session（effort=默认）→ 发消息 | wire body **不含** `output_config.effort` 字段（等价未挂 effort 时的行为） |
| **UC-B**（always 持久化） | session A 触发 `rm *` 弹卡 → 点「永远同意」→ 重启 app → session A 再触发 `rm xx *` | 首次执行（写入 alwaysApprovedKeys=`['bash:rm-wildcard']` 持久化）；重启后同会话同 key 仍免弹直接执行 |
| **UC-B2**（always per-session 范围） | session A 永远同意 bash:rm-wildcard 后 → 切到 session B 触发 `rm *` | session B 仍弹审批卡（per-session 隔离） |
| **UC-C**（绿灯短路 ask） | session 切换到 greenlight → 触发 `rm *`（策略 ask） | 审批层短路，命令直接执行（不弹审批卡）；session.approvalMode 持久化为 `'greenlight'` |
| **UC-C2**（绿灯不绕 deny） | session greenlight 模式 → 触发 `ls ~/.ssh`（策略 deny） | 策略层仍 deny，命令不执行，LLM 收拒绝理由（绿灯只动审批层，deny 路径保留） |
| **UC-C3**（绿灯不绕沙箱） | session greenlight 模式 → 触发 `bash -c 'cat ~/.ssh/id_rsa'`（参数漏网） | 执行层 seatbelt 拦截 EPERM 非零退出（绿灯放行后执行层沙箱仍兜底） |
| **UC-D**（绿灯切回 normal） | session greenlight → 触发 rm 后 → 切回 normal → 再触发 `rm *` | 切回后审批卡正常弹出（绿灯可逆，normal 恢复 ask 审批） |

## 5. 范围与非目标

- ✅ session 加 3 字段（effort / approvalMode / alwaysApprovedKeys）+ 持久化 + PUT 透传。
- ✅ UI 加 2 个 picker（effort 4 档 + 审批模式 2 档），input-bar 按钮行模型选择左侧。
- ✅ protocol 层（anthropic_messages）注入 `output_config.effort`（默认档不传）。
- ✅ ApprovalManager 从内存 Map 改读 session.alwaysApprovedKeys + engine 绿灯短路。
- ❌ 不实现 openai protocol 的 effort 映射（写 spec 不实现，无 openai provider/protocol）。
- ❌ 不扩大审批范围（仍仅 bash `ssh-read`/`rm-wildcard`）。
- ❌ 不动策略层 `checkPermission` / 执行层 SecureBashEngine 沙箱（绿灯只动审批层）。
- ❌ 不做全局 / 跨 session 的 always approve（per-session 范围，换会话重置）。
- ❌ 不做规则配置 UI / 自定义策略（策略仍在代码内列表）。
- ❌ 无设计稿 → 视觉保真度比对门禁跳过。

## 6. E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-E2E-1 | 新建 session → input-bar 见 `[审批模式][effort][模型选择][发送][停止]` 五控件 → 默认显示 `normal` + effort「默认」 | 两新 picker 渲染在模型选择左侧，trigger 21px，菜单脱流不位移 |
| UC-E2E-2 | effort picker click → 选「超高」→ 发消息 → LLM 回复期间观察请求 | session.effort 写入 `'max'`；后续 LLM 请求 wire body 含 `output_config.effort: 'max'`；菜单 hover 显「超高」selected |
| UC-E2E-3 | 触发 `rm -rf *` → 审批卡 → 永远同意 → 重启 app → 回同 session 再触发 `rm xx *` | 首次卡弹出 + 执行；重启后同类不再弹（per-session 持久化生效） |
| UC-E2E-4 | 审批模式切绿灯 → 触发 `rm *` → 触发 `ls ~/.ssh` | rm 直接执行不弹卡；ls ~/.ssh 仍策略 deny（绿灯不绕 deny） |

## 7. spec 待同步清单（架构期 / doc-modifier 阶段处理）

| spec 文件 | 待同步内容 | 处理阶段 |
|---|---|---|
| `specs/tech/agent/tools/[P0]tool_permission.md` §5/§10.4 | 删 D2「内存不落盘」决策，改 per-session 持久化（session.alwaysApprovedKeys）；加 green light 短路逻辑（engine.ts:193） | 架构期落 change_plan，doc-modifier 阶段 5 修 spec |
| `specs/prd/overall/10-tool-permission.md` §10.4 | 同步纠正 always 持久化语义；加 §10.7 绿灯模式（本版新增） | doc-modifier 阶段 5 |
| `specs/api/overall/04-agent-session.md` §2.1/§2.5 | Session 接口加 `effort` / `approvalMode` / `alwaysApprovedKeys` 三字段；UpdateSessionBody 扩三字段 | 架构期落 api version_log，doc-modifier 同步 overall |
| `specs/ui/components/chat-page/component-input-effort-picker.md` | 新建组件 spec（trigger/menu/item testid + 几何 + 视觉基线） | coder 先 spec 后实现（先 spec 后代码硬规则） |
| `specs/ui/components/chat-page/component-input-approval-mode-picker.md` | 新建组件 spec（同上） | 同上 |
| `specs/ui/components/chat-page/_overview.md` §4.11b | input-bar 按钮行从 3 控件（picker/send/stop）扩到 5 控件（approval-mode/effort/picker/send/stop） | doc-modifier 阶段 5 |
| `specs/tech/agent/session/[P0]session_store.md` | session schema 加三字段（落 CrudStore 持久化） | 架构期 change_plan |
| `specs/tech/llm/protocol/`（anthropic_messages） | `RequestParams.effort` + `encodeAnthropicMessages` 注入 `output_config.effort`（默认档不传） | 架构期 change_plan |

> 本 PRD 引用的概念（ModelPicker / ApprovalManager / 三层工具安全 / session CRUD）均与已有 ui/tech spec 一致，未发明新概念。两个新 picker 复用 `component-input-model-picker` 的几何/交互模式（21px trigger + hover 预览 + click 菜单 + 菜单脱流 absolute + z-popover），新概念（effort 字段 / approvalMode 字段 / alwaysApprovedKeys 字段）落点已在 ui/tech spec 中声明（session schema + input-bar 按钮行），架构期细化 method 级变更契约。
