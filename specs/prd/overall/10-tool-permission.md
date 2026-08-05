## 10. 工具权限系统

> 工具执行安全的三层能力：策略层（执行前决策）/ 审批层（危险操作人工确认）/ 执行层（可信容器兜底）。
> 首次引入 [v0.0.122.approval]，范围=bash 工具。概念权威源：`specs/tech/agent/tools/`（tool_permission / bash_tools / tool_execution_engine）+ `specs/tech/agent/agent_interface_and_loop/[P0]agent_hitl.md` + `specs/ui/components/chat-page/component-pending-approval-card.md`。

### 10.1 概念：三层工具安全 [v0.0.122.approval]

工具执行安全抽象为三层，代码层每个工具都有一个可选的 checkPermission 钩子：

1. **策略层**（checkPermission）——执行前检查工具 + 参数，产出 PermissionDecision 三态：
   - `allow`（直接通过）
   - `deny + reason`（直接拒绝，拒绝理由回灌 LLM，不执行）
   - `ask + reason + approvalKey`（请求审批，进审批层）
2. **审批层**（ApprovalManager + 审批卡）——策略层判 ask 时，若该 approvalKey 未被「永远同意」则弹审批卡；用户选「同意 / 拒绝 / 永远同意」后回填。
3. **执行层**（SecureBashEngine + seatbelt）——即便前两层放行，实际执行仍在可信容器内，屏蔽脚本里的间接危险操作（参数层漏网兜底，纵深防御）。

**设计原则**：挂载安全策略是 Engine 本身的行为——改 bash 安全策略只需改 SecureBashEngine 的 policy 挂载，bash tool 代码零改动。

### 10.2 bash 策略层 — 两条策略 [v0.0.122.approval]

**描述**：bash 工具执行前检查命令，按内置策略列表（可扩展）产出决策。deny 优先于 ask。
**优先级**：P0
**用户故事**：作为用户，我希望危险的通配删除先问我、访问我私钥目录被直接拒绝。

| 策略 | 命中条件 | 决策 |
|---|---|---|
| `ssh-read` | 命令引用 `~/.ssh` / `$HOME/.ssh` / `/Users/*/.ssh`（含 ls/cat 等任何形式） | deny「禁止访问 ~/.ssh 敏感目录」 |
| `rm-wildcard` | 命令名 `rm` 且任一参数含字面 `*`（按 `;` `&&` `\|\|` `\|` 拆段取 token） | ask「rm 通配删除，需用户批准」，approvalKey=`bash:rm-wildcard` |

- 检测为 best-effort 参数级（不做完整 shell AST）；间接绕过由执行层兜底。
- 其他工具的 checkPermission 未实现 = 视同 allow（行为不变）。

**验收标准**：`ls ~/.ssh` 直接拒绝不执行；`rm -rf *` 触发审批卡；普通 bash 无额外关口。

### 10.3 审批层 — 审批卡 + 三选项 [v0.0.122.approval]

**描述**：策略层判 ask 且未永远同意时，agent loop 悬挂（复用 v0.0.101 HITL），chat 输入区上方渲染审批卡。
**优先级**：P0
**用户故事**：作为用户，当 AI 要执行危险 bash 时，我希望看到卡片展示命令 + 拦截原因，一键同意 / 拒绝 / 永远同意。

**用户行为链路**：策略层 ask → 引擎查 ApprovalManager → 未同意则挂起 → SSE require_human_input → 前端 mount 审批卡 → 用户点三按钮 → POST /messages toolReply{handleType:'approval', payload:{decision}} → 后端按 decision 编辑占位 block → 卡片 unmount → loop 续跑。

**界面要素**（component-pending-approval-card）：
- 挂载：chat-input-bar 内、composer 上方（与提问卡 / enqueue-view 同位互斥）；`subState==='need_approval'` 时渲染。
- 内容：工具名 + 参数（bash 即 command，等宽字体）+ 拦截原因。
- 三按钮：同意（allow）/ 拒绝（deny）/ 永远同意（allow_always）。
- 可见性门控：`pendingToolCalls.length > 0`（非 session.running，suspended 排除 running）；composer 提问态保持可用；审批卡出现/消失不导致 composer 位移（占位固定）。
- recover：切走切回 / 重启后 GET /pending-tool-call peek 队首重渲染。

**三选项回填语义**：
| decision | 后端处理 | 结果 |
|---|---|---|
| allow | 补跑原 tool.run（经沙箱）→ 真实结果 upsert 编辑占位 → success | 命令执行，结果回对话 |
| allow_always | 同 allow + ApprovalManager.recordAlways(sid, approvalKey) | 执行 + 本会话后续同类不弹窗 |
| deny | 占位编辑为 isError「用户拒绝执行：{reason}」→ fail | 命令不执行，LLM 收理由继续 |

**验收标准**：`rm *` 弹卡展示命令+原因；同意→跑+回填；拒绝→isError 回填 LLM 继续；永远同意→本会话同类不再弹。

### 10.4 永远同意 — per-session 持久化 [v0.0.122.approval / v0.0.148 修正]

**描述**：ApprovalManager 记录本会话内被选永远同意的 approvalKey 集合，**持久化到 session record（跨 app 重启保留）**。会话内命中同 key 免弹窗放行；换会话重置（per-session 范围）。
**优先级**：P0
**用户故事**：作为用户，一次会话里对某类危险操作点永远同意后同类不再打扰；跨 app 重启回同会话仍生效（「永远同意」名实相符），换会话仍重新问我，避免永久授权风险。

**功能交互细节**：
- 按 approvalKey 记忆（`{toolName}:{policyId}`，如 `bash:rm-wildcard`）：会话内命中同 key → 策略层 ask 被短路为 allow。
- **持久化范围 = per-session**：v0.0.148 修正 v0.0.122 D2 内存决策——持久化字段 `session.alwaysApprovedKeys: string[]`（落 SessionStore CrudStore），**跨 app 重启保留**该会话内的授权；换会话重置（session A 的 always 不影响 session B，同 key 在 session B 仍弹）。
- ApprovalManager cache-through + ApprovalStorePort：isApproved cache hit 不读盘；cache miss 读 session.alwaysApprovedKeys 填 cache；recordAlways write-through 写 session.alwaysApprovedKeys（updateSession read-modify-write 去重 merge）。

**验收标准**：会话 A 对 `bash:rm-wildcard` 永远同意后 A 内 `rm *xx` 不弹；重启 app 回 session A 仍不弹；session B `rm *` 仍弹。

### 10.5 执行层 — SecureBashEngine + seatbelt 沙箱 [v0.0.122.approval]

**描述**：bash 执行收编进 SecureBashEngine，在 macOS seatbelt 沙箱内执行，屏蔽脚本里对敏感路径的间接访问。
**优先级**：P0
**用户故事**：作为用户，即便 AI 用脚本间接读私钥（`bash -c 'cat ~/.ssh/id_rsa'`），系统级沙箱把它拦下让命令失败。

**功能交互细节**：
- 抽象：BashEngine.exec(command, opts) 提供执行能力，bash tool 只引用；现有 runShell 收编为 engine 实现。BashSecurityPolicy 声明式（id / description / denyRead[] / denyWrite[]），每次可加一条，命中即失败。本版挂一条 `{id:'ssh-read-block', denyRead:['~/.ssh']}`（engine 展开 ~）。
- macOS 实现：policies 编译成 seatbelt profile 字符串（`(allow default)` + 逐条 deny，黑名单制），经 `sandbox-exec -p <profile> <shell> -c <command>` 执行——系统自带二进制、profile 内联传参不写文件（兼容 packaged cwd=/ 护栏、零新依赖）。
- 命中表现：进程内读 `~/.ssh` 得 EPERM → 非零退出 → bash 返回 isError。
- 非 darwin：passthrough 普通执行；超时/abort/输出截断语义与现 runShell 一致。

**验收标准**：seatbelt 可用平台上 `bash -c 'cat ~/.ssh/id_rsa'` 被 OS 拦、非零退出 isError；普通 bash 行为不变。

### 10.7 审批模式 — 绿灯总开关 [v0.0.148]

**描述**：session 新增 `approvalMode: 'normal' | 'greenlight'` 字段（缺省 `normal`，持久化）。绿灯（greenlight）= session 级审批总开关，策略层 ask 时直接放行（不弹审批卡、不等用户回填），等价「本会话所有 ask 类危险操作自动同意」。
**优先级**：P0
**用户故事**：作为用户，长任务里反复点同意（rm 通配等 ask）很烦；我希望一个会话级开关切到绿灯，把这类审批全部放行。

**功能交互细节**：
- **维度 = session 级**（整个会话所有 ask 放行），与 always（approvalKey 粒度 per-session 持久化，§10.4）**正交**——两者都在 engine.execute ask 分支内判定，任一满足都 fall through 视同 allow。
- **可逆**：切回 `normal` 恢复审批（后续 ask 重新弹卡）。
- **安全边界（MANDATORY）**：绿灯**只动审批层**：
  - 策略层 `deny` 路径**保留**（如 `ssh-read` 仍直接拒绝，绿灯不绕过策略 deny）。
  - 执行层 SecureBashEngine 沙箱**不变**（绿灯放行的 bash 仍在 seatbelt 内执行，参数漏网仍被 OS 拦）。
- 落点：engine.execute ask 分支内、isApproved 判定前加 `if (config.approvalMode === 'greenlight') fall through`（deny 分支在 ask 之前天然不被绕过）。

**UI 落点**：input-bar 按钮行加审批模式 picker（`component-input-approval-mode-picker`，与 effort picker 同款几何），2 档平铺（普通 / 绿灯），选中即写 `session.approvalMode`（PUT /session/:id 透传）。绿灯态 trigger 色调 text-accent（视觉强调）。**`[v0.0.152]`** studio leader/mate 单聊 input-bar 已接入同款绿灯 picker + effort picker（复用本节契约零改动，session 级持久化同构），并补渲染审批卡修复此前 studio 单聊 `need_approval` 悬挂无出口的缺陷；squad 群聊裁决不放两 picker（`studio-squad` tool bound 无 bash，审批语义空洞）。详见 `specs/prd/version_logs/v0.0.152/change_log.md`。

**验收标准**：绿灯切到 greenlight → 触发 `rm *`（策略 ask）直接执行不弹卡；触发 `ls ~/.ssh`（策略 deny）仍 deny 不执行；切回 normal 再触发 `rm *` 弹卡。

### 关键用户路径

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | AI 执行 `rm *` → 审批卡 → 同意 | 命令执行，真实结果回填对话 |
| UC-2 | `rm *` 审批卡 → 拒绝 | isError「用户拒绝执行」回填，LLM 继续，命令未执行 |
| UC-3 | `rm *` → 永远同意 → 会话内再 `rm *xx` | 首次执行；第二次同 key 不弹直接执行；重启回同会话仍不弹（per-session 持久化）；新会话仍弹 |
| UC-4 | AI 执行 `ls ~/.ssh` | 策略层 deny，不弹窗，bash 返拒绝理由，LLM 可见 |
| UC-5 | AI 执行 `bash -c 'cat ~/.ssh/id_rsa'`（参数漏网） | seatbelt 拦截，EPERM 非零退出 isError |
| UC-6 | 审批挂起时重启 app → 切回会话 | session 仍 suspended，审批卡 recover 重渲染，可继续决定 |
| UC-7 | session 切绿灯 → 触发 `rm *`（策略 ask） | 审批层短路，命令直接执行不弹卡；session.approvalMode 持久化为 greenlight |
| UC-8 | 绿灯模式 → 触发 `ls ~/.ssh`（策略 deny） | 策略层仍 deny，命令不执行，LLM 收拒绝理由（绿灯不绕 deny） |
| UC-9 | 绿灯模式 → 触发 `bash -c 'cat ~/.ssh/id_rsa'`（参数漏网） | 执行层 seatbelt 拦截 EPERM 非零退出（绿灯放行后沙箱仍兜底） |
| UC-10 | 绿灯 → 触发 rm 后 → 切回 normal → 再触发 `rm *` | 切回后审批卡正常弹出（绿灯可逆，normal 恢复 ask 审批） |

### 10.6 范围与非目标 [v0.0.122.approval / v0.0.148 修正]

- ✅ 仅 bash 工具接 checkPermission；其他工具钩子可选未实现=allow。HTTP 端点零新增（复用 v0.0.101 HITL 通道）。
- ✅ v0.0.148：always approve 改 per-session 持久化（`session.alwaysApprovedKeys`，跨重启保留）；新增绿灯模式（`session.approvalMode`）；新增 session 级 effort 推理强度。
- ❌ 不做规则配置 UI / settings 持久化规则（策略在代码内列表）。
- ❌ 不做**全局 / 跨 session** 的 always approve（per-session 范围，换会话重置）。
- ❌ 不扩大审批范围（仍仅 bash `ssh-read`/`rm-wildcard`）；绿灯/always 只在审批层放行。
- ❌ 不动策略层 `checkPermission` / 执行层 SecureBashEngine 沙箱（绿灯只动审批层）。
- ❌ 不做 denyWrite 场景 / 网络隔离（类型保留 denyWrite 字段不挂策略）。
- ❌ 不做 EP 插件化策略挂载（未来需要再抽 EP）。
- ❌ 不对接 LSM / EndpointSecurity（用 sandbox-exec + seatbelt）。
