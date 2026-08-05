# Hermes Agent 长期记忆与技能体系调研笔记

> **调研对象**：Hermes Agent（Nous Research 开源，2026 年 2 月发布，"会自我进化的 agent"）。
> **核心论点**：Hermes 把**记忆/技能/反思**做成"编排循环内置组件"（非可选模块）。三件少有人同时做到的事实现"越用越聪明"：**运行时技能学习 + 持久多层记忆 + 离线进化管线（GEPA）**。
> **来源**：官方文档（curator/cron/memory-providers/personality/llms.txt）+ 源码级拆解（53AI、lzw.me hermes-book、阿里云、xmsumi）+ GitHub Issues（#13578/#22357/#25322/#18369 等）。

---

## 一、五支柱：Memory / Skills / Soul / Crons / Self-Improvement

| 支柱 | 角色 | 落地形式 | 触发 |
|------|------|----------|------|
| **Memory** | 知道"你是谁、环境如何" | `MEMORY.md` + `USER.md` | 写入：agent 自主 + 后台 review；读取：session 启动冻结注入 |
| **Skills** | 知道"事情怎么做" | `~/.hermes/skills/{cat}/{name}/SKILL.md` + references/scripts/templates | `skill_manage(create/patch/edit/delete)`；progressive disclosure |
| **Soul** | 知道"我是谁"（静态、手写） | `SOUL.md`（system prompt **slot #1**，先于一切） | 人工编辑；缺失回退默认 |
| **Crons** | 让 agent "能自己醒来干活" | `cron/jobs.json` + gateway 每 60s tick | 自然语言或 cron 表达式；可挂 0/1/N skill |
| **Self-Improvement** | 让记忆技能"自己维护、不腐烂" | Nudge Engine（后台 fork 影子 agent）+ Curator + GEPA | Memory Nudge 每 10 用户轮；Skill Nudge 每 10 工具循环；Curator 空闲 ≥2h + ≥7 天 |

闭环：**Soul 是固定的框，Memory/Skills 是框里运动的零件**。自改进发生在"Soul 定义的视角"内，不偏离身份。

**关键设计**：身份与记忆分离（SOUL 只放人格，不放项目细节）；Crons 是一等公民（内置 gateway，cron job 在隔离新 session 跑，可 `no_agent` 0 token）；**90 turns 硬上限**（子任务共享预算，防失控烧钱——自改进系统必要护栏）。

---

## 二、记忆形式：受限 2-file core + 8 external providers

### 2.1 三层记忆架构

| 层 | 形式 | 容量 | 注入 | 用途 |
|----|------|------|------|------|
| **Tier 1（core）** | `MEMORY.md` + `USER.md` | MEMORY **2200 字符**(~800 tok)；USER **1375 字符**(~500 tok)；合计 ~1300 tok | 启动**冻结快照**注入；session 内写入落盘但**不即时刷新** | 关键事实 + 用户画像 |
| **Tier 2（session search）** | SQLite + **FTS5 全文索引** | 无限（所有会话） | agent 主动调 `session_search` | 跨会话延续 |
| **Tier 3（external）** | 8 插件 | 取决于 provider | 每轮前 prefetch + 每轮后 sync + session 结束 extract | 深度持久记忆 |

### 2.2 Tier 1：冻结快照 + 容量百分比注入
```
MEMORY (your personal notes) [67% — 1,474/2,200 chars]
<entry>
§
<entry>
```
- **条目由 `§` 分隔**：无时间戳，纯密集事实，逼榨干水分。
- **冻结快照本质**：启动读进 system prompt，之后整个 session 用这"照片"。中途写入**立即落盘但本 session 看不到**——要等下个 session。
- **为什么**：**保护 prefix cache**。prompt 冻结 → KV cache 命中率稳定；实时刷新每轮重算前缀成本爆炸。Hermes 明确 trade-off：一致性 > 实时性。
- **容量到 ~80% 触发合并**：agent 必须合并相关条目成更密集版本。**容量上限本身是质量过滤器**。

### 2.3 Tier 3：8 external providers（**只能激活一个**，core 永在）
| Provider | 独特性 |
|----------|--------|
| Honcho | 辩证式用户建模 + session 级注入（多 agent 首选） |
| OpenViking（字节） | 文件系统式知识层级 + 三级加载 + session 结束抽 6 类 |
| Mem0 | 服务端 LLM 抽取 + 去重（最省心） |
| Hindsight | 知识图谱 + **`reflect` 跨记忆综合**（独有） |
| Holographic | Local SQLite + **HRR 代数查询**（probe/reason/contradict）+ **信任分**（helpful +0.05/unhelpful −0.10） |
| RetainDB | delta 压缩 + 7 种记忆类型 |
| ByteRover | **pre-compression extraction**（压缩前抢救洞察） |
| Supermemory | **context fencing**（防召回污染）+ profile-scoped containers |

激活后自动流程（对 agent 透明）：① 注入 provider 上下文 ② 每轮前后台非阻塞 prefetch ③ 每轮后 sync ④ session 结束 extract。

**关键设计**：受限是特性（硬上限逼密度）；冻结快照保 cache（记忆与推理成本强耦合）；8 选 1 + core 永在（接口稳定，实现开放）；trust scoring + context fencing 护栏。

---

## 三、技能管理：progressive disclosure + 学习循环 + Curator

### 3.1 定义/存储/发现/触发
- **形式**：目录 + `SKILL.md`（YAML frontmatter + Markdown）+ 可选 references/scripts/templates/assets。
- **progressive disclosure**（token 高效命脉）：**L0** 全目录名字+描述（~3k tok 看完 catalog）｜**L1** 用到时加载完整 SKILL.md｜**L2** 钻进 references 深度文件。让"目录扩张 ≠ token 爆炸"。
- **触发**：`use_count`（sidecar `~/.hermes/skills/.usage.json` 追踪）。

### 3.2 来源与信任级别
- **builtin**（87 个）：Curator 可归档，**永不 patch/consolidate/delete**；少数 protected builtins 永不归档。
- **hub-installed**：**Curator 永不触碰**。
- **agent-created**（后台 review fork 创建）：**Curator 全权管理**。
- **user 手写/前台应用户要求**：`created_by: null`，**Curator 不管**。

### 3.3 学习循环：从经验创建技能
- **工具**：`skill_manage` 6 action：`create` / **`patch`（定向修补，token 高效，首选）** / `edit`（全文重写） / `delete` / `write_file` / `remove_file`。
- **创建触发**（满足其一）：① 完成复杂任务（5+ 工具调用）；② 遇错误死路找到 work 路径；③ 用户纠正；④ 发现非平凡工作流。
- **循环**：遇问题 → 试错解决 → 成功路径存 SKILL.md → 下次直接加载走已验证流程。
- **write_approval 门闸**（`config.yaml`）：`skills.write_approval: true` 时写入暂存 `pending/skills/<id>.json` 等用户批准。**防 agent 用更差版本覆盖手写定制**。
- **write origin 标签**：后台 review fork 写入 origin = `background_review`（唯一触发 Curator 管辖的路径）。

### 3.4 skill drift / context rot 解决——Curator
**触发（空闲检测，非 cron）**：距上次 ≥ `interval_hours`（默认 **7 天**）+ agent 空闲 ≥ `min_idle_hours`（默认 **2 小时**）。两者满足 → fork 后台影子 agent（独立 prompt cache，**永不触碰当前会话**）。全新安装首次只 seed `last_run_at`，延后一个周期才真跑（给用户时间 pin/opt out）。

**两阶段**：
- **阶段 1 确定性自动转移（无 LLM，永远开）**：30 天没用 → active→stale；90 天 → archived（移 `.archive/`，**可一键恢复**）；**永不自动删除**。
- **阶段 2 LLM 合并审查（单次 aux-model pass，max_iterations=8，默认关）**：需 `curator.consolidate: true`；fork agent 逐个审查 agent-created 技能，per-skill 决定 keep/patch/合并 umbrella/archive；**整包处理**（有 references/templates 必须整体保留/搬迁/归档，不能只压扁 SKILL.md）。

**状态机**：`active ─(30d)─▶ stale ─(90d)─▶ archived`，`restore`/`pin` 可逆。`pinned` 绕过自动转移（但 patch/edit 仍可进行）。

**护栏**：**pin**（只 agent-created 能 pin）；**tar.gz 快照**（每次真跑前对整树备份，留 5 份，`rollback` 可逆）；**usage telemetry sidecar**（`.usage.json`：use_count/view_count/patch_count/last_used_at/state/pinned，**审计友好无隐藏 DB**）；**更便宜 aux model**（如 gemini-3-flash）。每轮产出 `logs/curator/<ts>/` 的 `run.json` + `REPORT.md` + rename map。

**关键设计**：progressive disclosure 是命脉；patch 优于 edit；空闲检测而非 cron（趁 agent 闲）；**永不自动删 + 可回滚 + 可 pin**（自改进安全网）；telemetry 是 sidecar 文件非黑盒。

---

## 四、整合/反思：Nudge Engine + Curator + Crons

### 4.1 Nudge Engine（编排循环内置组件，非可选插件）
**两个独立 nudge 计数器**：

| Nudge | 计数维度 | 默认阈值 | 触发后 |
|-------|----------|----------|--------|
| **Memory Nudge** | **用户对话轮次** | 每 **10 轮** | fork 影子 agent，回顾近期会话，决定是否写 MEMORY.md/USER.md |
| **Skill Nudge** | **工具调用循环** | 每 **10 次循环** | fork 影子 agent，回顾近期工具序列，决定是否沉淀新 SKILL.md |

**为什么维度不同**：memory 累积"用户偏好事实"（轮次多→可能有新偏好）；skill 沉淀"工作流"（工具调用密集→有流程值得提炼）。**用对的维度数对的东西。**

**触发后执行**：① 计数器达阈值 → 回复照常交付（不阻塞）；② fork 全新 `AIAgent`（影子 agent，不同 system prompt，独立 review pass）；③ 提议写入 memory/skills；④ 写入受 `write_approval` 门闸约束；⑤ origin = `background_review`。

**已知 bug（佐证机制 + 揭示脆弱性）**：#22357（gateway session 重置 nudge 计数器→review 永不触发）；#18369（用户频繁 /new→到不了 10 轮阈值→自改进永不启动）；#8506（smart model routing 时 `_spawn_background_review` 无活动）；**#25322（后台 review fork 用全新 system string → 破坏 prefix cache，每次 nudge 重算前缀——"冻结快照保 cache"哲学的反面教材）**。Issue #13578 实测：`Nudge interval: 10` → 隐藏主模型负载约 **+10% 额外 API 调用**。

### 4.2 Curator（见 §3.4）
空闲检测（≥2h + ≥7 天）；确定性阶段（30d→stale, 90d→archived，永远开）；LLM 阶段（合并，默认关）；**永不自动删 + tar.gz 快照 + 可回滚 + 可 pin**。

### 4.3 Crons（一等公民）
gateway daemon 每 60s tick；job 在**隔离新 agent session** 跑；可挂 0/1/N skill；**`context_from` 串联**（Job B 注入 Job A 最近输出→多阶段管线）；**`wakeAgent` 预检门（$0）**（pre-run 脚本输出 `{"wakeAgent":false}` 则跳过 agent，用于"只状态变化才需 LLM"的轮询）；**no-agent 模式**（纯脚本，0 token，watchdog 专用）；`[SILENT]` 抑制（健康时不说话）；cron session 内禁用 cron 工具（防递归）；delivery 灵活（origin/local/telegram/.../all）。已知 bug #16756：CRON 不应用 SOUL.md（身份层缺失）。

### 4.4 Self-Improvement 闭环（反思→改进→**验证**）
- **反思**：Nudge 影子 agent 复盘会话；Curator fork 复盘技能库；**GEPA 读执行轨迹（不问 agent "你做得好吗"）**。
- **改进**：Memory 合并条目（密度↑）；Skills patch/合并/archive；GEPA 读轨迹→候选变体→LLM-as-judge（rubric 打分）。
- **验证（最易缺的一环）——GEPA 硬约束门闸**：① 完整测试套件 **100% 通过**；② 技能 **<15KB**；③ **缓存兼容性**保持；④ **语义目的不漂移**。最优变体**出 PR（非直接 commit）**→ 人工 review 合入。
- **为什么需 GEPA**：agent 倾向自我表扬；能自动生成技能的系统也能用更差版本覆盖手写定制。GEPA 通过"读轨迹而非问 agent"绕开偏差。成本 $2-10/次，无需 GPU。

**关键设计**：Nudge 是循环内置组件（自改进是心跳非外挂）；用户轮次 vs 工具循环分开计数；review fork 用不同 system prompt 是已知 bug（反证冻结快照哲学）；**反思→改进→验证缺一不可**；**GEPA 出 PR 不直接 commit（自动化到 PR 为止，合并权在人）**。

---

## 五、会话总结 / 二次反思

**跨会话延续**：Session A（Tier1 注入冻结快照 + Tier2 session_search + Tier3 每轮 prefetch/sync/结束 extract + Memory Nudge 每 10 轮 fork 写 + 结束全量 ingest）→ Session B（读到的 MEMORY.md 已含 A 的增量 ← 跨会话延续核心 + session_search 查 A 完整对话 + external 已索引 A 语义内容）。

**二次反思（关键）**：
- **记忆**：MEMORY.md 不是写一次定终身。下次 Nudge 重审近期会话 + 现有 MEMORY.md，可合并/重写/去重（Holographic `contradict` 检冲突；Mem0 服务端去重）/信任分调整。**容量 ~80% 强制合并（容量上限是演化强制力）**。
- **技能**：active→stale(30d)→archived(90d) 退役可恢复；Curator LLM 合并 umbrella；pin 护栏下持续 patch；GEPA 读轨迹离线进化 + 语义漂移检测；废弃是软的（归档可恢复，永不自动删）。
- **记忆废弃**：Holographic `fact_feedback` unhelpful −0.10 持续降分→召回靠后→软废弃；或显式 forget。

**关键设计**：跨会话延续 = 多通道冗余（core 精华 + FTS5 全文 + external 语义）；**二次反思内置非手动**（Nudge 每 10 轮，Curator 每 7 天，用户不用记"去整理"）；演化有强制力（容量）+ 安全网（永不删/可回滚/pin）+ 验证门（GEPA）；**废弃软且可逆，自改进系统不应有不可逆破坏性操作**。

---

## 六、对 rocky_agent 的启示

1. **给记忆设"硬容量上限 + 冻结快照"**：项目级/会话级记忆设字符上限（MEMORY.md ≤2200），到 ~80% 强制合并去重；注入冻结快照（保 prefix cache、逼密度、容量压力驱自动去重）；注入带容量 % 让 agent 知道"快满了该合并"。
2. **反思做成编排循环内置计数器**：主循环内置两语义计数器——每 N 次用户交互触发记忆 nudge、每 N 次工具调用触发流程 nudge；fork 影子 agent 后台跑不阻塞用户；写入受 write_approval 门闸约束。
3. **技能/流程资产用 progressive disclosure + Curator 状态机**：① L0 名字+描述 / L1 全文 / L2 引用 三层加载；② sidecar `.usage.json` 追踪使用；③ `active→stale(30d)→archived(90d)` 状态机（永不自动删 + tar 快照 + 一键回滚 + 可 pin）；④ 合并跑便宜 aux model；⑤ 改进优先 patch 而非 edit。
4. **自改进必须补"验证"——学 GEPA 约束门闸**：定期跑离线验证管线，读执行轨迹/历史 bug，对关键 skills/specs 提改进候选，硬约束：测试 100% + 体量不超标 + 语义不漂移 + **出 PR 不直接改**。
5. **身份层（SOUL.md）与项目层（AGENTS.md）职责严格分离**：SOUL 只放"agent 是谁"（人格/语气/边界，跨项目稳定），AGENTS 只放"项目怎么干"（架构/约定/路径）。身份层在 system prompt slot #1，缺失回退默认。对多 agent 编排尤其有价值（每 agent 有自己的 SOUL，共享项目 AGENTS）。

---

**Sources**: hermes-agent.nousresearch.com/docs(curator/cron/memory-providers/personality/llms.txt) · blog.dailydoseofds.com(masterclass) · developer.aliyun.com/article/1730226 · xmsumi.com/detail/3047 · 53ai.com(Openclaw/Hermes 架构复盘) · lzw.me/docs/hermes-book · medium/@xpf6677 · GitHub Issues #13578/#22357/#25322/#18369 · cloud.tencent.com/developer/article/2675949 · kenhuangus.substack.com
