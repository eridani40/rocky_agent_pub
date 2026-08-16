# v0.0.349 测试计划 — provider 删除入口 + 方案 dangling 双语义 + BUG-003/004 批修

> 依据：`change_plan.md`（158fde636，决策①-⑨）+ `task.json`（T1-T3）+ api 契约 `21-model-routing.md §2.7`（dangling 双语义权威段）/`§2.2`（PUT 校验）/`02-llm-chat.md §5.1`（DELETE /provider）。
> 本文档只钉验证门禁与覆盖映射；AT case 文件后续按需建（本文 §3 已给规格），本文档不建 case。

## 0. 范围概览

| 项 | 结论 |
|---|---|
| 变更性质 | 后端仅 session-config ~12 行（决策④全 dangling 降级，**唯一后端行为变更**）+ 前端 providers 详情页删除入口 + 方案编辑器 dangling 预检/红描边 + BUG-003/004 纯前端批修 |
| 不动面 | DELETE /provider 端点（tombstone 既有）/ PUT 校验（§2.2 既有）/ routing_loop 跳过（S2 既有）/ resolve 链 / 渠道 native（350 边界） |
| UT | MANDATORY：change_plan 变更清单 4 组测试（provider-detail 删除流 / editor dangling 预检+行 / session-config 双分支 / BUG-003/004 红→绿）+ 全量 `tsc -b` |
| AT | **不新增持久 case**（§3 判定）；跑既有冒烟集回归 + **临时 case 1 条**（全 dangling 400 黑盒实证，规格 §3.2，执行时建） |
| ET | **临时 case 2 条**（删除全链 + 全 dangling chat 呈现）+ 既有 et7 回归顺带 BUG-004；BUG-003 UT 红→绿独占不占 ET |
| 视觉保真 | 无新设计稿（红描边=既有 danger token、ConfirmModal=既有组件）→ 无独立视觉验收，红描边存在性并入 ET step 用 vision_check.py 判定 |

## 1. 路径→case 映射

需求路径（reqs/v0.0.349 三点 + BUG-003/004）→ 覆盖层：

| 路径 | 语义（决策/契约） | UT | AT | ET |
|---|---|---|---|---|
| P1-a 详情页删除入口：danger 按钮 + ConfirmModal 通用警示 + 确认后 DELETE→列表消失回 list；新建态不渲染 | 决策①②③；02 §5.1 DELETE 既有 | ✅ provider-detail 删除流（4 断言：已存渲染/新建不渲染/确认触发 onDeleted/取消不触发） | —（端点零改动） | ✅ 临时 ET-1 步骤 1-3 |
| P2-a 编辑拦保存（服务端）：PUT 含 dangling 条目 → 400 `model routing plan item: model not found or disabled` | §2.7-2 + §2.2 校验表（S4 既有，零改动） | —（纯函数 UT 既有） | ✅ **既有 mr_tc2 场景 4 已覆盖**（非法引用 400）→ 冒烟回归承担 | — |
| P2-b 编辑拦保存（前端本地预检）：validatePlanLocal(+providers) → itemModelInvalid 实时显示拦保存；单参缺省兼容 | 决策⑤ | ✅ editor/section dangling 预检 UT（3 断言） | —（纯前端） | ✅ 临时 ET-1 步骤 4-5 |
| P2-c 失效条目视觉：trigger「模型不可用: mid」（S5 既有）+ 红描边 | 决策⑥；冻结视觉契约（仅描边） | ✅ PlanItemRow invalid UT | — | ✅ 临时 ET-1 步骤 4（vision_check 判红边） |
| P3-a runtime 全 dangling：挂载方案全部候选拿不到 → chat/run 降级 400 `MODEL_NOT_CONFIGURED`（message 含「方案内所有模型不可用」），非未捕获 500 | 决策④；§2.7-1；**T1 唯一后端改动** | ✅ session-config UT 双分支（全 dangling throw ModelNotConfiguredError / 部分 dangling 首可用） | ✅ **临时 AT case**（§3.2，确定性零 LLM） | ✅ 临时 ET-2（UI 错误呈现非崩溃） |
| P3-b runtime 部分 dangling：跳过失效候选继续（S2 既有）+ 真实降级链（熔断→降级成功） | S2/S7 零改动回归面 | ✅ T1 UT「部分 dangling」分支 | ✅ **既有 mr_tc4**（分支 2 挂载真调 LLM 降级链=T1 改动函数下游，必跑） | — |
| P3-c 删 provider 后 GET/PUT 不可见（tombstone） | 02 §5.1 实现说明，零改动 | — | 临时 AT case 步骤内含（DELETE 后 GET :id 404） | — |
| B3 BUG-003 SaveBar 首存 dirty 残留：首存即显「已保存」 | 决策⑦；react-dirty-aggregation-state-not-ref | ✅ 复现 UT 红→绿（saveTab 收敛） | —（纯前端 state） | —（UT 独占；ET-1 若路过设置页可顺手观察，非门禁） |
| B4 BUG-004 删方案 trigger 显 planId：detached 含 playground → 前端清态 | 决策⑧ | ✅ 复现 UT 红→绿（删除回调清态 + squad pick 路径） | —（数据侧既有，detached 契约 mr_tc1 已断） | ✅ **既有 et7 回归**（case 场景即复现路径：删方案不刷新看 trigger）+ et6（squad merged select） |
| 回归面 | provider/model CRUD + 方案库 CRUD/挂载/降级链全链 | ✅ `bun run test` 全绿 | ✅ 冒烟集全量回归 | ✅ et7 + et6 |

## 2. UT 确认（change_plan 已钉死，本节确认覆盖即验收）

change_plan 变更清单 4 组测试 + T3 两个 bug 复现 UT：

1. `app/web/src/components/providers/__tests__/component-provider-detail.test.tsx`：删除流 4 断言（P1-a）
2. `app-dev-config-page/__tests__/` 追加：validatePlanLocal 二参（dangling 出 itemModelInvalid / 正常不出 / 缺省兼容）+ PlanItemRow invalid 红描边 + section providers 透传（P2-b/c）
3. `app/server/src/__tests__/` session-config：全 dangling → throw ModelNotConfiguredError（code=MODEL_NOT_CONFIGURED + message 含方案提示）；部分 dangling → 首可用候选正常（P3-a/b，**T1 验收含 SessionConfig.client 全消费方 grep 清单贴交付**）
4. BUG-003 saveTab 首存 dirty 收敛复现 UT（修复前红）；BUG-004 删除回调 detached 清态复现 UT（修复前红）——T3 验收要求红→绿双态贴交付汇报

门禁补充：`bun run test` 全绿 + 全量 `tsc -b`（typecheck 硬验收）；validatePlanLocal 单参既有 UT 必须全绿（向后兼容验收）。

## 3. AT 判定：不新增持久 case + 临时 case 1 条

**结论：不新增持久 AT case（3 条理由）；执行 = 冒烟集全量回归 + 临时 case 1 条（黑盒实证 T1 唯一后端变更，防 500 回归）。**

### 3.1 不入选持久库理由

1. **无新 API 面**：21 spec 仅注记（§2.7 语义段，端点/payload/错误码零新增）；DELETE /provider 是 v0.0.3 既有端点零改动；编辑拦保存 = §2.2 既有校验语义确认。
2. **dangling 编辑拦截已覆盖**：`mr_tc2` 场景 4「非法引用 → 400 model not found or disabled」与 dangling 条目命中同一校验函数同一错误——provider 删除后的 dangling 条目 PUT 就是这个 400，冒烟回归承担。
3. **冒烟集治理**：现库 34 条已超 ≤20 治理线（历史负债，非本版范围），普通 feature 不新增持久 case。

但**「改后端逻辑默认走 AT」适用**：T1 改 session-config（分支 2 client 组装），全 dangling 从未捕获 500 → 结构化 400 是行为变更，且**确定性可黑盒触发**（见下）——不入持久库但必须临时实证。

### 3.2 临时 AT case 规格（`mr-tmp349-full-dangling-400`，执行时建文件跑，不入 tests/api/）

全确定性 HTTP 事务，**零 LLM**（400 在 client 组装时机降级 throw，不会真调 provider，key 无效不影响）：

| # | 操作 | 断言 |
|---|---|---|
| setup1 | POST /provider（label `zz-mr349-a`，enabled，key 任意）→ save pid | `.provider.id exists` |
| setup2 | POST /provider/{pid}/model（`zz-mr349-m`，enabled） | `.model.modelId == "zz-mr349-m"` |
| setup3 | PUT /config/app 方案 `zz-mr349-plan`：items=[{pid, zz-mr349-m, priority1}]（此刻 provider 存在 → 合法 200） | `.ok == true` |
| setup4 | PUT /config/app group=model_routing key=default `{playgroundPlanId: zz-mr349-plan}` 挂载 | `.ok == true` |
| setup5 | POST /session（modelId 缺省=default）→ save sid | `.id exists` |
| 1 | DELETE /provider/{pid} | `.ok == true`（tombstone，对外=已删） |
| 2 | GET /provider/{pid}（P3-c 顺带） | `status: [404]` |
| 3 | POST /session/{sid}/chat（任意 prompt，不触发真调用） | **`status: [400]` + `.code == "MODEL_NOT_CONFIGURED"` + `.message ~= "方案内所有模型"`**（核心：修复前此处 500） |
| teardown | 挂载清空（PUT data:{}）+ DELETE 方案 | `.ok == true` |

DSL 注意：非默认 status 用 object-form；check 原子性一条一谓词；`{pid}` 插值仅 path/body。落 `states/v0.0.349/verify/api-test/` 留证。

### 3.3 冒烟集回归（api-test-executor）

`bash tests/api/lib/run_all.sh` 全量；**mr_tc1-4 必须全绿**——mr_tc4 走分支 2 挂载方案真调 LLM 降级链，是 T1 改动函数（buildClientFromCandidates caller 段）的直接下游，验证部分候选失败不被误伤（P3-b）。

## 4. ET（临时 2 条 + 回归 2 条，不入持久库）

### 4.1 临时 case（落 `states/v0.0.349/verify/e2e/` 留证，不写 tests/e2e/）

**ET-1：provider 删除全链 + dangling 编辑拦保存**（T2 主路径）：

1. 设置 → providers：新建测试 provider（或用可牺牲实例）→ 进详情页 → **SaveBar 右侧显「删除」danger 按钮**（视觉：danger 配色）
2. 点删除 → ConfirmModal 弹层含警示文案（方案条目失效/会话自动切换）→ 确认 → **列表中消失且回 list**
3. 对照：新建态（provider=null）详情页**无**删除入口
4. 进引用该 provider 模型的方案编辑器 → 失效条目 trigger 显「模型不可用: <mid>」+ **红描边**（vision_check.py 判边框颜色存在）；本地预检区显 itemModelInvalid
5. 点保存 → **被拦**（预检错误在，无 PUT 发出/保存不成功）
6. 清理失效条目后保存 → 通过（顺手验证不误拦正常条目）

**ET-2：全 dangling chat 错误呈现**（T1 UI 面；API 层已由 §3.2 AT 断 400）：

1. 方案 A 全条目引用将被删的 provider → 挂载 playground
2. 删除该 provider → 回 playground 发消息 → **显结构化错误提示**（方案内所有模型不可用/当前无可用模型类文案），**非 500/白屏/未捕获报错**
3. 留证 screenshot + steps/

**不入持久库理由**：删除全链是低频 destructive 操作（ET-1）+ 全 dangling 呈现已由临时 AT 承担 API 语义（ET-2 仅补 UI 呈现）；持久价值并入既有 et4（providers CRUD+i18n）语义域，冒烟集保持精简。

### 4.2 回归（既有冒烟集子集）

| case | 回归点 |
|---|---|
| et7 playground-plan-delete-fallback | 删方案后回退 + **BUG-004 场景即此 case 复现路径**：删后不刷新，trigger 回 placeholder（不显 planId）；reload 对照 |
| et6 squad-merged-select | squad 侧合并 select（BUG-004 squad pick 同步路径核对，T3 验收第 4 条） |

BUG-003 不占 ET：UT 红→绿独占（change_plan 决策⑦）；ET 路过设置页可顺手观察非门禁。

## 5. 视觉保真清单

无新设计稿 → **跳过独立视觉验收**。仅两点冻结契约在 ET-1 内验证（vision_check.py，禁 Read 看图）：

- 删除按钮 = 既有 danger 配色（照抄 ConfirmModal/danger 先例，无新发明——老板 UI 铁律）
- 红描边 = `border-danger` 仅描边、无新图标/行内文案（demo 冻结点）

## 6. 验证执行顺序

UT（含 BUG 红→绿）+ `tsc -b` 全绿 → code-review → AT（临时 case → 冒烟集全量，AT/ET 严禁并发，跑前 lsof 查 ET 端口段）→ ET（临时 2 条 + 回归 2 条，串行）→ doc-modifier（spec-sync 5 处 + change_log 两处）→ 合并（bump version）。

## 7. 门禁标准

- UT：`bun run test` 全绿 + 全量 `tsc -b`；T1 附 SessionConfig.client 消费方 grep 清单；BUG-003/004 附红→绿双态
- AT：冒烟集全绿（mr_tc1-4 必绿）+ 临时 case `mr-tmp349-full-dangling-400` pass（400+code+message 三断言）；LLM case 429/529/503 框架 skip 不算 fail
- ET：临时 ET-1/ET-2 + 回归 et7/et6 全部 blocking=0；红描边/删除按钮视觉断言 pass
