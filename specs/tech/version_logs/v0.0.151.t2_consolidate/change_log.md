# v0.0.151.t2_consolidate — tech 跨版本发布说明

> 天级 t2 整理任务（可进化 skills + memory 合并/淘汰/容量回收）。4 task 全 verified、全量 UT 7468 绿、AT record+replay 功能双绿（BUG-001 已修）、ET 回归绿。
> method 级变更契约：`change_plan.md`（5 模块 ~33 行）。本文件记录实际交付 vs change_plan 的偏差与补充。

## 交付概览

| 模块 | 交付 | KB log |
|---|---|---|
| memory/consolidation_tier2 | 新目录 5 文件（runner + 3 block + model-resolve）+ prompt handler + prompt md | `agent/memory/log.md` v0.0.151 块 |
| scheduling/consolidation_job | payloads + handler + adapter + cron-next + boot 装配 + router 分支 | `scheduling/log.md` v0.0.151 块 |
| api/consolidation-status | `GET /consolidation/status` 只读端点 + router 分支 | `api/version_logs/.../change_log.md` |
| config/app_config | consolidation group schema §3.16 | `config/log.md` v0.0.151 块 |
| ui/app-dev-config-page | 整理 tab + section-consolidation-config + i18n + summary 文案消歧 | （组件 spec 已落） |
| testing（BUG-001 框架修复，非 change_plan 内） | http-route-interceptor replay 短路门控改 `caseDeclared?.includes('http')` | `testing/log.md` v0.0.151 块 |

## vs change_plan 的实际偏差（coder decisions，已全部反映进 spec）

**T1 业务逻辑**（`runner.ts`/`global-*.ts`/`session-memory.ts`/`model-resolve.ts` + prompt）：
- BlockResult 解析口径走 `<result>action/detail</result>` 输出契约 + `parseResult()` 静态方法（change_plan 未规定格式，内部实现细节，已在 tier2 spec §6 注记）
- 两段全局 block 补防御性 try/catch（change_plan 只要求 per-session，纯增强不改变正常路径，已在 spec §5 注记 best-effort 范围）
- `{{capacity_limit}}` 填 `"当前/上限"` 占用格式（如 `"37 / 100"`，spec 未指定占位符内容，属实现细节）

**T2 调度接线**（`payloads/handler/adapter/cron/boot/router`）：
- 复用 T1 导出的 `ConsolidationAppConfigData` 类型不重复定义（DRY）
- boot 注册门 = `enabled===true`（modelId 缺失是 handler 内业务 skip 非 boot 门槛，按 `consolidation_job.md §3` 解决 change_plan 措辞矛盾）
- `BootSchedulerDeps` 三新字段 optional（保既有 `boot.test.ts` 编译，生产路径必传，已落 `consolidation_job.md §6`）
- Skip A 窗口起点 = `job.lastFiredAt`（null 回退 now-24h），按 `consolidation_tier2.md §3.1`，与 T1 runner 一致
- `boot.ts` 现 331 行超限（预存 308 行 T6 装配债 + 本任务 +33，已抽 `consolidation-boot.ts` 85 行减增量），reviewer 裁量记 backlog

**T3 状态端点**（`consolidation-status.ts` + router）：无偏离。`readLastResult()` 返回结构与 API §2.7 契约字段完全一致，handler 零转换直接透传 + try/catch 兜 500。

**T4 前端**（`section-consolidation-config.tsx` + i18n）：
- tab→内容分发实际在 `section-tab-panel.tsx`（v0.0.89 已抽出），change_plan 写的 `page-app-settings-merged.tsx` 仅穿 props——已在 `section-consolidation-config.md`「复用关系」订正
- hook 复用通用 `shallowDiff`/`handleKeyChange` 模式（非 `default_models` 专用模式），少 ~30 行——已在 `section-consolidation-config.md`「实现选型订正」段落记录
- enabled 开关 testid 定为 `key-boolean-consolidation-enabled`（骨架 spec 的 `key-toggle-*` 不符合代码库 boolean 控件命名约定，section spec 已订正）

## BUG-001（AT 框架修复，超出 change_plan 但阻塞 AT 验收）

- **现象**：`t2_daily_consolidation` AT case R4/R5 record 绿但 replay 轮 step11 `POST /test/consolidation/run` 返 `model_not_configured`（replay 轮 PUT /config/app 被静默伪造未真写盘）。
- **根因**：`app/server/src/testing/http-route-interceptor.ts` replay 短路未区分 case 是否声明 `stub:[http]`，对 AT 的 `requests` 步骤（`caseDeclared` 恒 undefined）也一律短路，伪造 `{"ok":true}` 未真调 dispatch。
- **修复**：门控改为 `if (!active.caseDeclared?.includes('http')) return null`（仅 ET case 声明 http 才短路）。
- **归因 B（框架问题，非产品 bug）**：`testing/` 全部 `NODE_ENV==='test'` 门控，生产路径完全不经过 `interceptHttpRequest`。
- 详见 `states/v0.0.151.t2_consolidate/bugs/BUG-001-AT双关replay轮consolidation配置读空-[fixed].md` + `specs/tech/testing/log.md` v0.0.151 块。

## 已知遗留（用户裁决可带遗留交付）

- **`t2_daily_consolidation` recordings 未落盘**：`baseline_model_drift` advisory 事件（case 用 glm-5.2 vs test 默认 MiniMax-M3，advisory 设计上"不算 fail"）被 `run_all` 聚合层 double_gate 硬翻 fail、阻断 recordings 落盘。属框架聚合层违背 advisory 语义的债，用户裁决不本版本修，记 backlog（见 `testing/record-replay.md §6` 新增项）。功能正确性已充分验证（record 轮真 LLM 整理 + replay 轮修 BUG-001 后双绿）。
