# v0.0.350 测试计划 — 四渠道 coding plan native 类型 + 额度/余额查询

> 依据：`change_plan.md`（a604c605a，决策①-⑩ + 风险 5 条）+ `task.json`（T1 后端/T2 前端）+ PRD `specs/prd/v0.0.350-native-coding-plans-and-balance-query.md` §2.1-2.4/§3 P-A~P-D + api `02-llm-chat.md` 1.8 §5.6（GET /provider/quota 契约）+ 实测 `specs/research/v0.0.350-live-verify.md`（四渠道真调全通）。
> 本文档钉验证门禁与覆盖映射；AT 临时 case 规格 §3.2（建文件按 349 流程另行派单），ET case.md 由 executor 按本文档现场操作。

## 0. 范围概览

| 项 | 结论 |
|---|---|
| 变更性质 | 后端：ProviderName union +4 / queryQuota 可选能力接口 / 4 native impl（挂 llm_anthropic plugin）/ POST+PUT name 白名单 / **新端点 GET /provider/quota**（聚合+错误隔离）；前端：类型选择器 KeyChoiceCards + preset 联动 + 额度总览 footer（use-quota-polling 5min/30s 双 tick）+ i18n |
| 不动面 | protocol impl（anthropic_messages 零改动）/ 既有 provider CRUD 语义（name 缺省 anthropic_compatible 兼容）/ chat 链路（buildAuthHeaders 逐字节复用）/ mock 回退（default.yaml impls 首位不变） |
| UT | MANDATORY：quota-parsers 全矩阵（live-verify 四份实测响应原文作 fixture）+ handler 聚合/错误隔离/路由顺序 + name 白名单向后兼容 + 前端联动/footer（fake timers）+ 全量 `tsc -b` |
| AT | **不新增持久 case**（决策⑩钉死）；临时 case 1 条（§3.2：白名单 + 聚合路由不被吞 + invalid key 401→error.kind=auth 确定性真调）+ 冒烟集全量回归。**成功数值快照不进 AT**（需真 key，解析正确性由 UT fixture 独占背书） |
| ET | **临时 3 条**（P-A 配置流 / P-B+P-C 额度总览+刷新降级 / P-D 发消息）+ 回归 1 条（et4 同域组件）；环境策略 §4.3（从 prod app_config 拷渠道 record 或至少 1 真 key + 1 invalid key） |
| 视觉保真 | 无新设计稿（照抄既有卡片 + danger token 语言）→ 无独立视觉验收；两行模板/余额模板/友好词断言并入 ET-2（vision_check.py） |

## 1. 路径→case 映射

PRD §3 P-A~P-D（= 测试最低覆盖要求）→ 覆盖层：

| 路径 | 语义（决策/契约） | UT | AT | ET |
|---|---|---|---|---|
| P-A-a 类型选择器：5 项（1 通用 + 4 native 友好名）；选 native → baseUrl 自动填 preset + protocol 锁定只读 + 新建空 models 预填默认模型；切回通用不回填；已存改类型 baseUrl 保留 | 决策④；PRD §2.1/UC-1 | ✅ detail 联动 UT | —（纯前端） | ✅ 临时 ET-1 |
| P-A-b name 通道（后端）：POST/PUT name 白名单 5 值；白名单外 400；缺省 anthropic_compatible 兼容 | 决策⑤；api §5.2 | ✅ provider.test.ts 追加（白名单/400/向后兼容三断言组） | ✅ 临时 case step 1-3 | —（UT+AT 已独占） |
| P-B-a 聚合端点：GET /provider/quota → `{items}`；仅 4 native 参与（通用不进）；单渠道失败 item.error 不炸整体；零 native → items:[]；**路由不被 :id 正则吞（风险④/S6）** | 决策②⑦；api §5.6 | ✅ handler UT（聚合/隔离/空/路由顺序） | ✅ 临时 case step 4-6（路由不被吞 = AT 黑盒核心回归门） | —（ET-2 顺带端到端） |
| P-B-b 解析正确性：四渠道快照归一 QuotaSnapshot（kimi used 直读/glm unit 分桶/minimax 反转/status 门控/deepseek 余额） | 决策⑧⑨；PRD §2.3 全规则 | ✅ **quota-parsers UT 独占**（live-verify 实测响应原文 fixture，UT 主战场） | —（数值断言需真 key，不进 AT） | ✅ ET-2 端到端真数值（格式心证：整数%/两位小数/本地时间） |
| P-B-c 额度总览 UI：仅 list 页底部、仅 native 参与、空不渲染；额度型两行/余额型货币/余额不足/展开明细/上次更新/友好词 | 决策⑥；PRD §2.2/UC-4/7/8 | ✅ footer UT（模板×2/展开/空态） | — | ✅ ET-2 |
| P-C 5min 刷新 + 失败保留 + 30s 倒计时 | 决策⑥；PRD UC-5/6 | ✅ hook UT fake timers（interval+tick 零请求，**独占 5min 语义**） | — | ✅ ET-2 可验证口径（§4.2：首拉立即/倒计时文本走动/invalid 渠道错误态+其他渠道不受影响；真 5min 等待不做） |
| P-D 用 native provider 发消息：anthropic 协议复用 200 正常回复 | 决策①（buildAuthHeaders 复用）；PRD UC-3 | —（协议复用无新逻辑） | ✅ 冒烟回归（chat_send_reply 等真调链确认 provider 链无回归） | ✅ ET-3（1-4 渠道真调回复） |
| 错误与降级：401/403→auth「凭证已失效」；业务错误透原文；15s timeout | PRD §2.4；决策⑦ | ✅ handler UT（timeout 分类/错误隔离逐 item） | ✅ 临时 case step 4（invalid key → 401 确定性 → error.kind=auth） | ✅ ET-2（invalid 渠道条目错误态呈现） |
| 回归面 | provider CRUD / model-routing（POST /provider 不传 name 缺省路径）/ chat 真调 | ✅ `bun run test` 全绿 | ✅ 冒烟集全量（mr_tc1-4 建过 provider，天然回归 name 缺省兼容） | ✅ et4-crud-i18n（detail/fields/section 组件同域改动） |

## 2. UT 确认（change_plan 变更清单已钉死，本节确认覆盖即验收）

1. `quota-parsers.test.ts`（+160）：四渠道解析全矩阵 + deriveQuotaBaseUrl 推导表（bigmodel.cn/z.ai/minimaxi/minimax.io/自定义代理）——**fixture = live-verify 四份实测响应原文**（T1 验收硬条件）
2. `provider-quota.test.ts`（+65）：聚合并发/单渠道失败隔离不炸整体/零 native→items[]/15s timeout 分类/label+fetchedAt/**路由顺序**（/provider/quota 不被 :id 吞）
3. `provider.test.ts` 追加（+35）：POST name 5 值白名单/白名单外 400/缺省兼容；PUT name 可选写入/白名单外 400/不传不变
4. 前端 ×2（+150）：detail 类型联动（baseUrl 填充/protocol 锁定/预填/切回不回填/已存保留）+ footer/hook（两模板/展开/LastGood/30s tick 零请求，fake timers）

门禁补充：`bun run test` 全绿 + 全量 `tsc -b`；default.yaml impls 首位 anthropic_compatible 不变（T1 验收，mock 回退依赖）。

## 3. AT 判定：不新增持久 case + 临时 case 1 条

**结论：不新增持久 case（决策⑩ + 冒烟集纪律：现库 34 条已超 ≤20 治理线）；临时 case 1 条 = 新端点确定性黑盒（路由不被吞 + 白名单 + 401 auth 隔离）；成功数值快照不进 AT。**

### 3.1 判定理由

1. **入选面评估**：本版唯一新 API 面 = GET /provider/quota + name 白名单——按 SOP「新后端端点应考虑入选」，但决策⑩架构已钉不新增持久（外部渠道 API 形状无官方文档、可能漂移，持久 case 会变维护负债）；折中走 349 同款**临时 case 模式**。
2. **AT 环境策略（额度查询真调问题）**：额度成功数值断言需四渠道真 key——AT 环境（test.env DATA_DIR）**不配真 key**（test.env 仅 minimax/volcengine 普通推理 key，无 coding plan key；secrets 亦无）。**结论：AT 不做成功数值断言**；解析正确性由 UT 用 live-verify 实测 fixture 独占背书（比 AT 真调更强：形状矩阵全覆盖），AT 只验协议管道（端点存在/聚合/隔离/错误分类）。invalid key 401 是确定性可测面（渠道端点真实可达，无需 secrets）。
3. **若强行 AT 真调数值会得到什么**：需把 boss 的 prod coding plan key 注入 test secrets（跨环境凭证扩散 + 额度消耗 + 渠道限流不确定性）——收益低于 UT fixture，拒绝。

### 3.2 临时 AT case 规格（`quota-tmp350-aggregate`，执行时建，不入持久库）

全确定性 + 1 次 invalid key 真调（401 快速返回，无 LLM 无额度消耗）：

| # | 操作 | 断言 |
|---|---|---|
| setup1 | POST /provider `{name:"kimi_coding_plan", protocolId:"anthropic_messages", baseUrl:"https://api.kimi.com/coding/", key:"sk-invalid-quota350"}` → save pid | `status 201` + `.provider.name == "kimi_coding_plan"`（白名单内落库） |
| setup2 | POST /provider `{name:"volcengine_ark", ...}`（白名单外） | `status: [400]` + `.error exists` |
| step1 | PUT /provider/{pid} `{name:"glm_coding_plan"}`（类型切换通道） | `.provider.name == "glm_coding_plan"` |
| step2 | GET /provider/quota → 200 | **`.items exists`（核心：路由不被 :id 正则吞——被吞则 404 直接 fail）** + `.items[] any .implId == "glm_coding_plan"` + `.items[] any .error.kind == "auth"`（invalid key 真调 → 401 → auth 分类，确定性）+ `.items[] any .fetchedAt exists` |
| step3 | DELETE /provider/{pid} | `.ok == true` |
| step4 | GET /provider/quota（零 native）→ 200 | `.items[0] absent`（空数组断言用索引不存在，`.size` 不可用） |
| teardown | DELETE /provider/{pid}（幂等） | `status: [200, 404]` |

DSL 注意：非默认 status object-form；网络抖动致 error.kind 偶发 network/timeout 时 executor 复跑单 case 即可（不重构断言）。timeout 90（聚合含 15s 保护窗）。

### 3.3 冒烟集回归（api-test-executor）

全量 `bash tests/api/lib/run_all.sh`；重点观察：mr_tc1-4（建 provider 不传 name → 缺省兼容路径）+ chat 系（provider→session→真调链，P-D API 侧回归）。

## 4. ET（临时 3 条 + 回归 1 条）

### 4.1 临时 case（落 `states/v0.0.350/verify/e2e/` 留证，不写 tests/e2e/）

**ET-1（P-A 配置流）**：
1. 设置→模型→providers→添加 → 类型选择器**5 项**（Anthropic 格式兼容 + Kimi Coding Plan + 智谱 GLM Coding Plan + MiniMax Coding Plan + DeepSeek（按量付费）；**无 volc**——验收 10）友好词（无内部术语）
2. 选「智谱 GLM Coding Plan」→ baseUrl **自动填** `https://open.bigmodel.cn/api/anthropic` + protocol 控件**锁定只读**（anthropic_messages 禁点）+ 新建空 models 预填默认模型一条
3. 填 API Key → 保存 → 列表出现该 provider
4. 对照：切回「Anthropic 格式兼容」→ 不回填；已存 provider 改类型 → 已自定义 baseUrl 保留

**ET-2（P-B 额度总览 + P-C 刷新降级，可验证口径）**：
1. providers 列表页底部显「额度总览」区（卡片外、仅 list 页；detail 页无）：真 key 渠道两行模板「5 小时额度 已用 X%（HH:mm 重置）/ 本周额度 已用 Y%」+ 套餐/会员档位徽标；deepseek「余额 ¥NN.NN」（整数%/两位小数/本地时间）；无 native 时不渲染空区块
2. 点击某渠道条目展开：套餐名/会员档位 + 两桶明细 + 完整重置时间 + 「上次更新 HH:mm」（boss 铁律展开区）
3. **P-C 可验证口径**（真 5min 等待不做，UT fake timers 独占）：①挂载列表页首拉立即展示；②重置倒计时文本存在（「约 N 小时后重置」）且 30s+ 前后两次截图对比走动；③invalid key 渠道条目显「凭证已失效，请检查 API Key」**且不隐藏其他渠道**（错误隔离 UI 面）；④已有值 + 上次更新保留（LastGood 呈现）
4. 视觉：照抄既有卡片语言（vision_check.py 判定，禁 Read 看图）

**ET-3（P-D 发消息）**：
1. session 模型选 kimi-for-coding（或任一 native 类型 provider 的默认模型）→ 发消息 → 200 正常回复（anthropic 协议，与通用类型无行为差异）
2. 渠道覆盖按环境真 key 数量裁剪（≥1 渠道真调回复即 pass；4 渠道全配则全测）；429/限流按 ET 惯例重试或降级记录

### 4.2 回归（既有冒烟集子集）

| case | 回归点 |
|---|---|
| model-routing/et4-crud-i18n | providers/方案同域组件改动（fields/detail/section）+ i18n 词表回归 |

### 4.3 ET 环境策略（真 key 问题，给结论）

- **首选**：executor 起 ET env 后，从 `~/.rocky_agent_prod/app_config/providers/app_config/*.json` **拷 4 渠道 provider record 进 ET DATA_DIR**（live-verify 2026-08-14 已真调全通，boss 授权过真调；只读拷贝不回写 prod）→ P-B 真数值全渠道 + P-D 可全渠道发消息
- **退路**（boss 不愿 prod key 进 ET 环境）：手工配 1 个真 key 渠道（推荐 kimi，key 最易获取）+ 1 个 invalid key 渠道（错误隔离口径）→ P-B 真数值 1 渠道 + 错误态 1 渠道；P-D 单渠道真调
- **兜底**（无任何真 key）：P-B 退化为骨架+错误态验证（额度区渲染/错误条目/友好词可测，数值模板不可测——记录降级不算 fail，UT fixture 背书数值正确性）；ET-2 判定降级为 small 可接受
- invalid key 渠道（`sk-invalid-*`）任何策略下都建 1 个（错误隔离 UI 面验证必需）

## 5. 视觉保真清单

无新设计稿 → 跳过独立视觉验收。冻结契约在 ET-2 内验证：额度总览照抄既有卡片+danger token 语言（老板铁律不自创）；百分比整数/金额两位小数/本地时间；文案全友好词（无 unit/base_resp/TOKENS_LIMIT 内部术语——验收 9）。

## 6. 验证执行顺序

UT（T1 parsers/handler/白名单 + T2 联动/footer fake timers）+ `tsc -b` 全绿 → code-review（T1/T2 各自）→ **AT 临时 case（T1 完成即可跑）→ 冒烟集全量**（AT/ET 严禁并发，跑前 lsof 查 ET 端口段）→ ET（T2 完成后：临时 3 条串行 + et4 回归）→ doc-modifier（spec-sync 4 处 + change_log 两处）→ 合并（bump version，与 349 攒包）。

## 7. 门禁标准

- UT：`bun run test` 全绿 + 全量 `tsc -b`；quota-parsers 必须用 live-verify 实测原文 fixture（T1 验收）；default.yaml impls 首位不变
- AT：冒烟集全绿（mr_tc1-4 + chat 系重点）+ 临时 case `quota-tmp350-aggregate` pass（路由不被吞 + 白名单 400 + error.kind=auth + 零 native items 空）
- ET：临时 ET-1/ET-2/ET-3 + 回归 et4 全部 blocking=0；ET-2 在「兜底」环境策略下降级 small 可接受（数值模板由 UT fixture 背书）；ET-3 至少 1 渠道真调回复
