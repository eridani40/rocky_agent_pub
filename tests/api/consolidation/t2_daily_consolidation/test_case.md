# t2_daily_consolidation — 二级整理（天级）：模型未配置跳过 + 冗余 global memory 收敛

**模块**：consolidation
**断言面**：Resp（BlockResult 结构 + skippedReason 分支）+ SSE（种子写入 run_end 序列）+ 真实调 LLM（主力对 minimax / `MiniMax-M3`）
**触发方式**：`POST /test/consolidation/run`（test-only 同步端点，`specs/api/version_logs/v0.0.151.t2_consolidate/change_log.md`；不等真实 cron 到点——AT `wait`/`poll` 上限 60s 无法可靠等 `HH:mm` 粒度）
**测试模型**：主力对 `MiniMax-M3`（`providerId=01KVJMPG2EZ1078MCT9JH4J5HG`，= `tests/test.env` 的 `TEST_PROVIDER_ID`/`TEST_MODEL_ID`），两处注入：setup 的 `POST /session` 预绑定（`providerId`+`modelId`）+ step 4 的 `consolidation` group `data.modelId`（该字段是纯 modelId string，不带 providerId，见 `specs/api/overall/03-config-center.md` §2.6）。
> **不要切回 fallback 对**（`01KVX1JBFHG51E2X0KXPBG9B15` / `glm-5.2`）：该火山 provider 的 CodingPlan 订阅已过期，出站直接返 400，切过去必假 fail。历史背景：v0.0.164 首跑撞 MiniMax Token Plan 429 配额耗尽（非 case/产品问题）曾临时切 fallback；v0.0.190 起 429 已自动判 `skipped/reason=429`（不重试不阻塞），无需再靠换 provider 规避。
> **为何硬编码字面量**：AT DSL 插值只认 `{var}`（`save` 变量 + `case_id`），`interp.py` 不做 env 插值；框架也无 `USE_FALLBACK` 之类把 `TEST_PROVIDER_ID` 覆写进 case 的旋钮（`tests/api/lib/` 无该实现）。故 `providerId`/`modelId` 只能写字面量，与库内其他 case 惯例一致。

## 覆盖核心逻辑

新增二级整理机制（`specs/tech/agent/memory/[P0]consolidation_tier2.md`）的两条 PRD 关键路径：

1. **路径 5（模型未配置 → 静默跳过）**：`consolidation.modelId` 未设置 → `POST /test/consolidation/run` 返回 `200` + `skippedReason: "model_not_configured"`（不是错误，合法业务结果）；`GET /consolidation/status` 仍写入 `lastResult`（`lastRunAt`/`summary` 非空——"到点必执行一次"即便零改动也算已执行）。
2. **路径 4 + 路径 1（超限/冗余 → 收敛到限内 → 摘要可见）**：配置 `modelId` 后，走真实 `memory_manage` 工具（agent 调用）种入 2 条内容高度重复的 `global` memory 条目（`source='agent'`，走 agent 工具路径，非 UI POST——UI POST 固定 `source='user'` 不计入 tier2 处理范围，见 `memory_manage_tool.md §6.1` + `consolidation_tier2.md §4`）→ 触发整理 → 断言：
   - **v0.0.238 scope 必填（PRD §14.2.3）**：种子写入显式传 `scope=global`（不再依赖旧「不传 scope 默认 global」——v0.0.238 去掉默认值后不传 scope 会被工具拒绝 `invalid_input`，阻断 case）
   - 响应结构合同：`globalSkill`/`globalMemory`（各含 `action`/`detail`）+ `sessions[]` + `summary` 齐全，`skippedReason` 为空（对比路径 5 的非空分支）
   - 收敛信号（Step 11）：`globalMemory.action != "no_change"`（真实发生了合并/归档动作，而非无操作）+ `globalMemory.detail exists`
   - 无物理删除（Step 12）：触发后两条种子条目仍存在于 `entries[]`（不论是否被 archive，"archive 不删" 不变量）
   - 至少发生一次归档（Step 12）：`.entries[] any .archived == true`——只钉「有归档动作发生」，**不指定是 A 还是 B**（详见下节「断言取舍」）

## 断言取舍说明（Step 12：为何不钉「具体哪条被归档」）

两条种子含义相近但表述不对称，**LLM 保留谁 / 归档谁没有稳定规律**：
- A（`t2seed-pref-a-t2dc1`）：`「该用户明确表示所有回复都应保持简洁扼要，避免长篇大论，这是长期稳定的沟通偏好」`——政策式书面表达
- B（`t2seed-pref-b-t2dc1`）：`「用户偏好简短回答，不想要冗长解释，讨厌啰嗦的长篇大论」`——情感化重复表述 + 语气强

**两次真调实测方向相反**（都是 LLM 合理的语义判定，**均非产品 bug**）：

| 轮次 | A `archived` | B `archived` | 当时断言 | 结果 |
|------|-------------|-------------|----------|------|
| v0.0.164 首跑 | false | true | 强断「两条都 true」 | fail（A false）→ 改为只钉 B |
| v0.0.217 复跑 | **true** | **false** | 只钉「B == true」 | fail（B false）→ 证明钉任一条都 flaky |

结论：**「哪条被归档」= LLM 主观收敛方向，两个方向都真实出现过**，把它写进断言就是拿测试结果赌 LLM 选边——必然周期性假 fail（且每次都要人来重新归因「不是产品 bug」）。同一条 step 的 name 早已写明「archived 具体归属 LLM 主观、无硬保证」，断言却硬钉 B，属 case 自相矛盾的设计缺陷。

**现方案（v0.0.217 起）— Step 12 只钉客观不变量**：
- `.entries[name=t2seed-pref-a-t2dc1] exists` / `.entries[name=t2seed-pref-b-t2dc1] exists`——**archive 不删**（产品硬不变量，与 LLM 判归无关；必须带 `?includeArchived=true` 才看得到归档条目，见 `15-memory-ui.md §3.1`）
- `.entries[] any .archived == true`——**至少发生一次归档**，不指定 A 还是 B（DSL check 原子性禁布尔连接/嵌套，数组谓词内也不能复合 `name filter + archived`，故「A OR B archived」无法单条表达；`any` 是唯一可用的、不赌方向的客观形式）
- **删除** 任何 `.entries[name=X].archived == true` 形式的单条硬钉（不论 A 或 B）

**该 `any` 谓词的已知弱点（有意接受）**：AT 的 `DATA_DIR` 是 per-worktree 持久目录（跨轮不清），且本 case teardown 用 `DELETE /memory/global/<name>`（= 归档）收尾，故列表中可能已有残留 archived 条目 → 该谓词判定力偏弱（可能被残留满足）。它的定位是**底线断言**（守「归档动作存在 + 不物理删」），不是收敛的强证据；**收敛强证据在 Step 11**：`globalMemory.action != "no_change"` + `globalMemory.detail exists`（server 侧结构化分类结果，非本 case 猜测存储层状态）。宁可断言判定力弱一点，也不要拿 LLM 选边赌确定性——弱但真，强而 flaky 的假 fail 反而更贵。

## 环境风险披露（供 executor/orchestrator 参考）

- **DATA_DIR 跨轮持久化**：AT 环境的 `DATA_DIR` 是 per-worktree 持久目录（不随每轮清空），consolidation 的"各 session 整理"块会遍历 `sessionStore.listSessions()` 全量历史 session。多数历史 session 未写过 session-scope memory（本项目历史上仅 global scope 写入路径被验证用过），预期命中 Skip B（session memory 为空，零 LLM 调用），故本 case 主体触发的实际 LLM 调用数预期 = 2（seed 写入）+ 2（全局 skill block + 全局 memory block，session block 大概率全 skip）；若某次执行环境里恰好存在历史遗留的非空 session memory，会额外触发对应 session 的 forkedRun 调用，增加耗时/成本——`timeout: 240` 已留有余量，若仍超时需 orchestrator/executor 评估是否需要环境级清理或提高上限。
- **`lastFiredAt` 窗口起点**（`consolidation_tier2.md §3.1`）在 test-only 触发路径下如何取值，spec 未完全钉死（真实调度路径读 `job.lastFiredAt`；test-only 路径可能传 `null`）——不影响本 case 断言（依赖 Skip B 兜底，不依赖 Skip A 精确语义），仅供 orchestrator 知悉此为待观察的架构留白点。

## 引用

- `specs/api/version_logs/v0.0.151.t2_consolidate/change_log.md`（`POST /test/consolidation/run` 完整请求/响应契约 + gate + 副作用范围）
- `specs/api/overall/03-config-center.md` §2.6（`consolidation` app_config group）+ §2.7（`GET /consolidation/status`）
- `specs/tech/agent/memory/[P0]consolidation_tier2.md` §3（三段严格串行 + 双重 skip）§4（容量口径 source='agent'）§5（forkedRun 执行载体）
- `specs/tech/scheduling/[P1]consolidation_job.md` §7（test-only 端点设计定稿：不动 `lastFiredAt`、写 `lastResult`）
- `specs/api/overall/15-memory-ui.md` §4（`POST /memory/global` 固定 `source='user'`，故本 case 种子数据改走 agent 工具路径以获得 `source='agent'`）
- `specs/tech/agent/memory/[P0]memory_manage_tool.md` §6.1（agent 写路径 `source` 落盘契约）
