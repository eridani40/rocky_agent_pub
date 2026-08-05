# train-adopt — academy adopt 旁路不变量（v0.0.221 两轴模型）

**模块**：academy
**断言面**：HTTP（adopt 后 task 状态不变 + 新 formal 版本 type/status + 可重复 adopt）
**版本**：v0.0.221（原 train-accept 重写：accept/reject/stop 路由删 → adopt 旁路；task 三态机）

## 覆盖核心逻辑

本 case 覆盖 academy adopt 旁路归档不变量（design §2.2 两轴解耦 + change_plan A.adoptVersion/B.adoptToFormal）：

1. **adopt → 新 formal 版本**（POST /academy/training-task/:tid/adopt body `{versionId}`）：
   - 响应 `{ newFormalVersionId, newLabel, newWorkspaceDir }`（adoptToFormal 按 seq 找下一空正式版号分配）
   - 新版本 GET → `type=formal` + `status=active`（adoptToFormal = copyVersionDir 复制 process 为新正式版）
2. **adopt 不改 task 状态**（旁路语义，生产⊥归档两轴解耦核心）：
   - adopt 前 task.status=paused → adopt 后 GET task 仍 status=paused + pausedReason 仍在
   - 多次 adopt 仍不改状态（生产轴完全不受归档轴影响）
3. **adopt 可重复**（同 process 版本可多次 adopt，每次产新 formal ULID + major 递增）：
   - 第二次 adopt 同 candidateVersionId → 又一新 formal versionId（2.0/3.0 major 递增）
   - GET 第二个 formal 版本 → type=formal/status=active（每次 adopt 产独立 formal record）

## setup 结构

setup 把 task1 推到 paused（multi maxTurns=2 + directive 引导 revise → coach 自主跑到 maxTurns/早停 →
status=paused + pausedReason），steps 只测 adopt 旁路不变量 —— 职责单一，不混入训练引擎链路断言
（那是 train-multiturn-flow 的职责）。

- POST classroom / student / dataset / grader（em）→ POST training-task（maxTurns=2 + directive）→
  **poll GET /training-task/:tid 直到 status=paused**
- save `process_vid = .task.candidateVersionId`（建任务即 fork 自 base，type=process 恒成立，安全 adopt 目标）

## 真调 LLM 调用次数

| 阶段 | LLM 调用 | 说明 |
|---|---|---|
| setup task1 coach 自主跑（maxTurns=2） | ≥3（coach LLM + revise sample） | maxTurns=2，directive 引导 revise |
| steps adopt（两次） | 0 | adopt 纯 store ops（fs.cp + putVersion + putStudent），无 LLM |
| **合计** | **≥3** | adopt 本身无 LLM 调用 |

## 设计决策与边界

- **原 train-accept 重写为 train-adopt**：v0.0.221 删 accept/reject/stop HTTP 路由 + propose 链；原 case
  测的「accept → done + reject → rejected」状态机已不存在（task 三态 pending/running/paused）。重写为
  测新 adopt 旁路语义（不改状态 + 可重复）。dir 改名 train-accept→train-adopt（仍 1 case 不增库）。
- **process_vid 选 candidateVersionId**：candidate 自建任务即 fork（type=process 恒成立）；
  temporaryBaselineVersionId 在 coach 未 revise 时仍指 base formal（type=formal）→ adopt 会 409
  process_required（adoptToFormal 校验 type）。candidate 是安全的 adopt 目标。
- **poll 到 paused 而非 running**：running 中 adopt 状态可能并发变化（coach 推进），断言「status 不变」
  会被 coach 并发推进污染。paused = 终态稳定，adopt 后 status 仍 == paused 是干净旁路证据。
- **pausedReason 不断具体值**：闭合 4 值（maxturns/completed/stopped/earlystop），具体哪个由 coach LLM
  行为决定（到达 maxTurns / 早停），非状态机硬保证 → 只断 exists。
- **newLabel 动态不断固定值**：adoptToFormal 按 seq 分配（初始 0.0 → 首个 adopt = 1.0 → 2.0/3.0...），
  check 右侧不插值（陷阱 1）→ 只断 `.newLabel exists`；具体值由 GET /version/{new_vid} 的
  `.meta.versionLabel exists` 间接存活。
- **两次 adopt 用同 versionId**：证明「可重复 adopt 同一 process 版」（design §2.2 可重复语义）。
  每次产新 ULID + major 递增（2.0/3.0），student.currentFormalVersionId 跟最新（BUG-001 修复，AT 不断
  此字段——UT AcademyStore.adoptToFormal 覆盖）。
- **teardown 省略**：task 已 paused（终态，coach 不再烧 LLM）；无 DELETE classroom 端点，残留无害
  （每轮新教室新 id，name 含 case 标识不冲突）。
- **count-based 不变量（formal 版本数 +2）AT 不可达**：DSL body 数组谓词只 any/all 无 count → 改写
  为存在性断言（GET /version/{new_vid} 返 type=formal 即证明产出了新 formal）；formal 版本计数不变量
  由 UT AcademyStore.adoptToFormal 覆盖。
- **poll 窗 180s**：coach run ~44s 起步（transcript 实证），连续真调累计更慢——单 poll 60s 窗恰逢/累计
  超时误判钉死（v0.0.215 round1 实证非功能 bug）。框架 poll.timeout 上限 180（v0.0.203 用户裁决专为
  trainer 真 LLM 多 turn 链路放宽）；case timeout 240 兜 worst-case（180 + adopt 快步骤 ~10 = 190 < 240）。

## spec↔change_plan 冲突点（doc-sync 待办）

- `specs/api/overall/18-academy.md` §2.4 accept / §2.5 reject / §2.6 stop 路由仍存在（spec 落后代码）；
  change_plan E 节明确三路由全删 + 加 adopt/pause/resume/update-task。本 case 按 change_plan E 节设计
  （spec 落后是常态，doc-modifier 阶段 5 同步 spec 对齐到代码）。
- `specs/api/overall/18-academy.md` §7 错误码表 `nothing_to_adopt`（accept 守卫）已无意义（adopt 旁路
  不校验 task 状态）；新错误码 `task_at_maxturns`（resume maxturns 硬终态）未列。doc-modifier 同步。

## 引用

- `specs/tech/version_logs/v0.0.221/change_plan.md` E 节（API handlers + routes：adopt/pause/resume/update-task）
  + A 节（adoptVersion 旁路不改状态）+ B 节（adoptToFormal 可重复 + student 指针同步）
- `specs/tech/academy/[P0]training_engine.md` §1（三态机 + adopt 旁路）+ §2（TrainingEngine.adoptVersion 接口）
- `specs/tech/academy/[P0]data_model.md` §6（adoptToFormal 可重复 INV）+ §4（pausedReason enum）
- `specs/api/overall/18-academy.md` §1.8/§2.2（GET version/task 契约；§2.4-§2.6 路由 spec 落后待同步）
- `states/v0.0.221/verify/test-plan.md` §4 AT 白名单 — 本 case 定义
