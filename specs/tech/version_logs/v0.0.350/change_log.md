# v0.0.350 tech change_log — 四渠道 coding plan native + 额度/余额查询

> 架构期产出（2026-08-15）：change_plan + task.json + spec 即时同步。编码期偏离在此追加。

## 架构期同步记录（architect，编码前）

| 文件 | 变更 | 依据 |
|------|------|------|
| `specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md` | §2 ProviderName +4 native；LlmProvider 加可选 `queryQuota?`；实现表扩 4 impl 行（含 glm 裸 key 特例）；新增 §3.5 native preset+额度查询决策段（查询域推导/impl 顺序约束/消费方） | change_plan 决策①②③⑤ |
| `specs/api/overall/02-llm-chat.md` | 1.7→1.8：§5.1 +GET /provider/quota 行；§5.2 ProviderInstance.name 放宽 ProviderName union；§5.4 错误表 name 白名单 5 值注记；新增 §5.6 quota 聚合端点契约 | 决策②⑤⑦⑧ |
| `specs/ui/components/providers/component-coding-plans-quota-footer.md` | 新组件 spec（职责/props/两模板/展开/轮询语义/消费方） | 决策⑥ |
| `specs/ui/components/providers/section-providers.md` | +[v0.0.350] 类型选择 + 额度总览挂载段 | 决策④⑥ |
| `specs/ui/components/providers/component-provider-fields.md` | +[v0.0.350] 类型选择器段（KeyChoiceCards+联动语义） | 决策④ |
| `states/v0.0.350/` | task.json（2 task）+ task-board.md + context.md 初始化 | 双轨状态管理 |

## 编码期偏离记录

| 偏离 | 说明 | 依据 | 记录人 |
|------|------|------|--------|
| `error_classify.ts` CLASSIFIERS Partial 化 | ProviderName +4 连带：Record 完整性检查逼迫为 4 native 显式建 classifier。改为 `Partial<Record>` + `?? CLASSIFIERS.anthropic_compatible!` 兜底（4 native 同 anthropic wire，错误形态同域，live-verify 实测背书）。行为零变化：原未知 provider 走 `??` 兜底路径不变，既有 UT（unknown_provider 兜底 anthropic）全绿 | change_plan 表外（ProviderName 扩宽连带消费方，团队原则 12「合理偏离必报」） | coder3（T1 commit c184dbbd9 报备） |
| `plugin-config.json` i18n（4 impl description）搁置 | `__MSG_*__` 解析在 app/web 层 = T2 禁碰线；T2 随前端一并补 zh/en | change_plan 决策④（i18n-web 归 T2） | coder3（T1 commit c184dbbd9 报备） |

## 审查期修复记录（code-reviewer2，Minor 直接修复）

| 文件 | 修复 | 性质 |
|------|------|------|
| `app/server/src/llm/caller/__tests__/error_normalization.test.ts` | +1 UT：4 native provider 走 ?? anthropic 兜底（探针=529→PROVIDER_OVERLOADED anthropic 专有映射），钉住 Partial 化零回归 | 死磕点⑦「独立验证」落地 |
| `app/server/src/handlers/provider-quota.ts` | NATIVE_QUOTA_NAMES 改由 PROVIDER_NAME_WHITELIST 派生（去 4 值字面量重复，防未来加渠道漂移）；删 L40 尾逗号 | Minor 冗余/风格 |

## T2 表外接线（coder3，commit `fc6a311a7`，review `d9d56a4b9` 报备采纳）

| 文件 | 接线 | 依据 |
|------|------|------|
| `framework/primitives/key-choice-cards.tsx` | +`labels?: Record<string,string>`（选项友好名映射，缺省回退 opt）+ testid 前缀链已可锚 | 类型选择器 5 类型需友好名（i18n type.*），primitive 原仅渲染 value 原文；既有 dark/light 调用方不传零影响 |
| `lib/config-crypto.ts` | 导出加密 record 的 `name?` 放宽 ProviderName（旧导出文件无 name → 可选，导入链缺省通用） | ProviderName +4 连带（配置导出/导入保型） |
| `lib/config-sync-import.ts` | provider 导入 name 透传（native 类型导入保型；旧文件无 name 缺省通用向后兼容） | 同上 |

## T2 review Minor（评估处置，不改码；`d9d56a4b9`）

1. **`component-provider-detail.tsx` 307 行跨组件 300 阈**：基线 273 + 本次 34，change_plan 预估 +40（313，plan 层已接受）；实现在预估内，超 7 行不值得为过线拆文件——**挂账：下次触碰该文件时外提 SectionTitle/头部子块**。
2. detail 头部 subtitle 显内部 id（`provider · kimi_coding_plan`）：沿用既有 subtitle 风格（原 anthropic_compatible 同显），主选择器已显友好名；后续 UI 打磨可换 `t(preset.labelKey)`，非本版义务。

## S7 补录（i18n 闭环，commit `1cc862d1e`）

T1 搁置的 `plugin-config.json` 4 native impl description 已随 T2 落地（zh/en 同 key 6/6 一致：kimi/glm/minimax 套餐 + 5h/周额度查询、deepseek 按量付费 + 账户余额）；plugin-config-page 测试 64/64 绿。T1 偏离表「搁置」项**闭环**。

## 验证汇总（doc-modifier2 代记，2026-08-15）

- **UT**：T1 全量 10698 绿 → T2 全量 **10718 passed**（+19：选择器/联动/透传 11 + footer/hook fake timers 8）+ `tsc -b` 0 error。
- **AT**：**5/5 pass**（临时 case `quota-tmp350-aggregate` 断聚合形状/错误隔离 + mr 冒烟回归；报告 `states/v0.0.350/verify/api-test/AT_report_T1T2.md`）。
- **review**：T1 `57cd240a4` PASSED（Minor 3 项已修 + 观察项 4 条）/ T2 `d9d56a4b9` PASSED（2 Minor 评估处置不改码，见上）。
- **ET**：et1/et2/et3 + et4 回归**进行中**（e2e-test-executor2 并行跑，结果落 `states/v0.0.350/verify/e2e/`，完成后由 leader 收尾验收——本 change_log 不占位预填结论）。

## 决策⑥演进追记（v0.0.363，doc-modifier）

> 版本轴历史不改写上文；决策演进在此追加。

350 决策⑥「**server 不缓存额度（每次现拉 15s 超时），前端 lastGood 持有最近成功值 + 5min 轮询**」已被 **v0.0.363 推翻**：server 起维护全局 QuotaStore（内存，不持久化）单一权威源 + QuotaSyncService 5min 后台同步（启动即首轮），`GET /provider/quota` 改读 store 秒回（空窗 `{items:[],lastSyncedAt:null}`），store 更新经 SSE topic `provider_quota` 推送；前端两消费端额度轮询删除，「打开触发增量」走新端点 `POST /provider/quota/sync`。lastGood 降级为断线/空窗兜底（server 侧恒有最近成功值）。详见 `specs/tech/version_logs/v0.0.363/change_log.md`（推翻理由：打开速度 + 全局一致刷新）。
