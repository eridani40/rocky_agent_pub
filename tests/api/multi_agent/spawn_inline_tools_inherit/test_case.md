# spawn_inline_tools_inherit

**Module**: `multi_agent` · **覆盖契约**: `specs/api/overall/10-multi-agent.md` §2/§4 + `10a-multi-agent-tool-ref.md` §1（agent 工具 inline spawn 副作用经 HTTP 可观测）
**版本**: v0.0.222 — subagent tools 默认继承 profile `toolBound`（修 `agent-tool.ts:330` `?? []` 降级 bug）

## 被测行为（v0.0.222 修复）

parent LLM 调 `agent(action=spawn)` 做 **inline spawn（不带 templateRef）且不传 `tools` 参数** 时：
- **修复前（bug）**：`agent-tool.ts:330` `childConfig.tools ?? []` 把 `undefined`（未指定=该继承 bound）降级成 `[]`（显式空），`resolveToolSet` 走交集得**空工具集** → subagent 无任何工具可用。
- **修复后**：去 `?? []` 透传 `undefined`，`resolveToolSet`（session-type-policy.ts:92）走 `undefined → new Set(bound)` 全集分支 → subagent 继承 subagent profile `toolBound`（19 工具，含 `read`/`bash` 等）。

> **与既有 `agent_spawn_sync` 的区分**：那条 case 用 `templateRef=explorer`，`eff.tools = explorer.tools`（非空数组）→ `?? []` 是 no-op → **从不触发本 bug**，故修复前后都 pass，不能充当 v0.0.222 回归门。本 case 刻意走 inline spawn（无 templateRef + 不传 tools）→ `eff.tools = undefined` → 命中修复路径。

## 链路设计

1. 建 parent session（playground + minimax），save `sid` + `workspaceDir`。
2. `files` 植入 marker 文件到 `workspaces/{sid}/probe.txt`（内容含唯一 token `TOOLPROBE_7QK9X2`）。
3. 订阅 parent `agent_loop` 流。
4. `POST /session/{sid}/messages` 驱动 parent 调 agent 工具 inline spawn 一个子 agent，子任务 = 读 `{ws}/probe.txt` 并原样返回内容。**消息正文不提 tools 参数**，让 LLM 自然省略 → 命中修复路径（而非负向指令「不要传 tools」反而诱发 LLM 显式传 tools）。
5. `wait` parent `run_end`（sync spawn 同步等 child 完成）。
6. `poll GET /children` 拿 `terminated[0].sessionId`（sync 完成后 child 落 terminated 组）。
7. `GET /session/{child}` 验 `derivation=subagent` + `parentSessionId exists`（inline spawn：`subAgentTemplateType` 应为 null/缺省）。注：check rhs 不做 `{var}` 插值（框架惯例），精确值等价由 step 8 marker 兜底。
8. **核心断言**：`GET /session/{child}/messages` → `.items[-1].content[0].text ~= "TOOLPROBE_7QK9X2"` —— subagent transcript 末条 assistant 回复含 marker token = subagent 用 `read` 读到了文件 = **subagent 有 read 可用 = 继承了 bound 全集（非空）**。
9. `GET /session/{sid}/usage` → `.sub.llmCallCount >= 1`（child 真跑过 LLM，递归上报 parent.sub）。
10. teardown `DELETE /session/{sid}`（child 随父联级清理）。

## 断言面

| 断言 | 信号含义 |
|------|---------|
| `main.run_end==1 / absent(error)` | parent run（含 sync spawn）正常完成 |
| `GET /children terminated[0]` 存在 | inline spawn 真的派生了 child session |
| `child.derivation==subagent` + `parentSessionId exists` | child 是本 parent 派生的 subagent（契约 §2） |
| **`child transcript ~= "TOOLPROBE_7QK9X2"`** | **subagent 用 read 读到 marker → 有工具可用 → 继承 bound 全集（修复生效）** |
| `parent.sub.llmCallCount >= 1` | child 递归 LLM 跑过（usage 上报链路） |

## 已知 flaky / 残留风险（重要 — 执行前知会）

本 case 的可观测信号必须穿过「双 LLM + 工具调用链」才能落到断言，存在固有的、黑盒设计期无法消除的不确定性。逐条列出，供 orchestrator/executor 裁决：

1. **parent LLM 可能显式传 tools（静默不覆盖，不可检测）**：若 parent 在 inline spawn 时 unsolicited 显式传 `tools:[...]`，则 `eff.tools` 非 undefined → 走交集分支（非修复路径）→ case 在 bug 态也会 pass = **静默不覆盖**。`subAgentConfig.tools`（解析后工具集）是内部字段不暴露 HTTP（10-multi-agent.md §2），故 **AT 无法检测此情形**。缓解：消息正文完全不提 tools（不给 LLM 显式传 tools 的暗示），让 LLM 自然省略 → 命中修复路径。MiniMax 在中性任务上省略可选参数是大概率行为，但非 100%。

2. **`read` 工具的路径策略未由 spec 担保**：marker 写在 parent workspace `<DATA_DIR>/workspaces/{sid}/probe.txt`，case 通过 `{ws}`（parent `workspaceDir` 绝对路径）把绝对路径喂给子任务，指望 subagent 的 `read` 能读 parent workspace 下的绝对路径。若 `read` 被沙箱限制在 child 自身 workspace（`<DATA_DIR>/workspaces/{childSid}`，不含 marker），则**修复后也读不到 → 假 fail**。此项需执行轮据 `last_run/steps` 实测确认；若 read 沙箱到 child workspace，本 case 不可行（需改用 `bash echo` 等不依赖文件路径的探针，但 `bash` 是否在 bound 内同样需确认）。

3. **transcript content 形状（`.items[-1].content[0].text`）未由既有 case 验证**：若 MiniMax-M3 末条 assistant 消息 `content[0]` 非 text（如 reasoning block 在前），断言路径落 `<missing>` → 假 fail（fail 自解释会列实际可用键）。执行轮据 `last_run/steps/NN/responses.json` 核对真实 messages 形态调整路径。

4. **LLM 转述 marker 的保真度**：subagent 读到 token 后其 final 回复应原样含 `TOOLPROBE_7QK9X2`（token 为 code-like 大小写+数字串，LLM 倾向原样 echo）；parent 是否再原样转述不影响本 case（断言点在 child transcript，非 parent 回复）。

## 与 UT 的关系（gate 取舍建议）

- **UT（`spawn-action-direct.test.ts` 三态）= 本修复的精确门**：直接断言落库点 `subAgentConfig.tools === undefined`（非 `[]`）+ resolveToolSet 分支，白盒、确定、零 LLM 不确定性。这是更精确的回归门。
- **本 AT = 端到端行为层补充验证**：在双 LLM 链路通的常见路径下，验证「不传 tools → subagent 真能用工具」这一用户可感知后果。价值在于覆盖 UT 触达不到的 resolveToolSet → agent-loop → 工具执行的集成链路；代价是上述残留 flaky。
- **建议**：首轮真调跑；若 fail 落在风险点 2/3（结构性假 fail，非 marker 缺失）→ 说明本场景黑盒不可靠断言，**回退豁免 AT、UT 兜底**（test-plan §不覆盖项已留此口径）；若 pass 则作为行为层冒烟留存。
