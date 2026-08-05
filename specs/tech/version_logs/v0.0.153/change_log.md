---
type: change_log
title: v0.0.153 — packaged prompt content 打包修复 + 硬编码 prompt md 化 + build 期资源自检
version: v0.0.153
date: 2026-07-15
related_prd: 无（纯技术修复，跳 PRD——无用户可感知交互变化，见 CLAUDE.md「PRD 参与边界」）
related_change_plan: specs/tech/version_logs/v0.0.153/change_plan.md
grounded: reqs/[done] v0.0.153.prompt_content_packaging/req.md + states/v0.0.153/task-board.md + states/v0.0.153/packaging-audit.md + states/v0.0.153/verify/packaged-verify.md
---

# v0.0.153 — packaged prompt content 打包修复 + 硬编码 prompt md 化 + build 期资源自检

> 一句话：**修复 packaged 环境 system prompt 全空的 Critical bug（build 期资源镜像缺失）+ 4 处遗留硬编码 prompt 迁 md 化 + 新增 build 期资源自检脚本（防复发）+ 顺带修复一个 readSessionType 归一化回归（BUG-004）**。

## 1. 动机

用户反馈：packaged（prod）环境下 squad leader 系统提示词只剩 team_roster 一句话、playground system prompt 为空。根因 = `app/server` 的 `tsc -b` 只编译 `.ts`，从不复制 `src/prompts/content/**/*.md` 正文文件进 `dist/`；`PromptHandler.readContent()` 按既有降级策略对缺文件静默返回空串（§3.3 设计初衷是容忍单文件读失败，不是为了掩盖整目录缺失）。dev 环境 Bun 直跑 `src`，`__dirname` 天然命中 content 目录，AT/ET 全绿测不到；packaged 跑 `dist`，`__dirname` 偏移到 `dist/prompts/`，目录整个不存在。

## 2. 变更总览

### 2.1 T1+T4：build toolchain 修复 + 资源镜像自检（`app/server/package.json` + 新增 `scripts/check-server-build-assets.sh`）

- `app/server` 的 `build` 脚本补 `cp -r src/prompts/content dist/prompts/`（整目录递归，与既有 migration yaml cp 同款风格），并在收尾追加 `bash ../../scripts/check-server-build-assets.sh`。
- 新增 `check-server-build-assets.sh`：`check_mirror()` 递归 `find` 枚举 src 侧文件、逐个核对 dist 侧同相对路径文件存在，缺失即打印 `MISSING: <dist>（源: <src>）` 并 `exit 1`；对 `prompts/content/*.md` + `migration/handlers/*.yaml` 两组做镜像比对。**不硬编码文件清单**——新增资源文件自动纳入校验。
- macOS `/bin/bash` 3.2 古董坑：`set -u` 下变量紧跟全角中文标点会误并入变量名，脚本内 echo 一律 `${var}` 显式括号规避。

### 2.2 T2：启动期资源完整性自检（`prompt-handler.ts` + `bootstrap.ts`）

- `readContent()` 签名加可选参数 `relPath: string | undefined = this.contentFile`（向后兼容，供同一 handler 实例读取多个 content 段，T3-c 的 `ForkedReminderHandler` 消费）。
- 新增导出 `CRITICAL_CONTENT_FILES`（17 项关键 content 文件清单）+ `checkPromptContentAssets(contentDir?)`（纯查询，`existsSync` 判断，不抛异常）。
- `bootstrap.ts bootstrapBuiltinPlugins()` 头部调用；`!ok` 时 `console.error` 显式告警，**只 log 不抛错**（不中断启动）。dev/test 下不误报。

### 2.3 T3：4 处硬编码 prompt 正文迁 md（逐字迁移，测试用「原常量快照比对」锁死）

| 消费方 | 原常量 | 新 content 文件 | 新 handler |
|---|---|---|---|
| `auto-naming-service.ts applyAiName()` | `NAMING_PROMPT` | `content/auto_naming.md`（`{{query}}` 占位符） | `AutoNamingHandler` |
| `routing-decision.ts`（`memory-manage.ts`/`skill-manage.ts`/`ConsolidationHandler` 三处消费） | `ROUTING_DECISION_PROMPT` | `content/routing_decision.md`（无占位符） | `RoutingDecisionHandler`（模块私有不导出，模块顶层即时求值） |
| `forked-reminder-injector.ts buildReminderText()` | 内联 `lines` 数组 + 三态字面量 | `content/forked_reminder/{skeleton,tools_none,tools_all,mode_tail_summary,mode_tail_memory_extract}.md`（5 文件） | `ForkedReminderHandler`（三态/modeKey 判断逻辑留在调用方，handler 只按 key 取文件+拼接） |
| `tick-message.ts buildHeartbeatTickMessage()` | `HEARTBEAT_TICK_PROMPT` | `content/tick_heartbeat.md`（无占位符） | `HeartbeatTickHandler` |

三处 `ROUTING_DECISION_PROMPT` 消费方（`memory-manage.ts`/`skill-manage.ts`/`consolidation-handler.ts`）**零代码改动**（单一源不变量维持，`git diff --stat` 实测确认）；`buildReminderText`/`buildHeartbeatTickMessage`/`applyAiName` 三处调用方签名不变，只内部实现改走 handler。原字面量末尾多无尾随换行，各 handler 统一 `.trimEnd()` 补偿保持产出逐字节相同。

### 2.4 BUG-004：readSessionType 'rocky' 归一化修复（squad KB，非原 change_plan 范围，packaged 验证附带发现）

`squad_reminder_shared.ts readSessionType()` 加 `k.role === 'rocky' → undefined` 归一化分支，对齐自身 `readSessionKind()` 注释语义（standalone = `!kind` 或 `role==='rocky'`）。修前 `identity.ts` 唯一反向判定消费方（`if (!sessionType)` 判 standalone）被 `'rocky'`（truthy）误导落入 studio 空分支，playground standalone 场景 identity.md 正文整段缺失——这是用户原始症状（「playground system prompt 为空」）的**第二根因**（第一根因是 BUG-001 打包缺失）。其余 11 个消费方全是正向匹配特定角色字符串，无回归（逐一核对，见 `../../squad/log.md` v0.0.153 条目）。

## 3. 打包链系统性审计（范围追加，`states/v0.0.153/packaging-audit.md`）

用户追加范围要求「统一 md 化 + 打包审计 + 防复发指引」。审计产出 Critical 1（= 本版 BUG-001 基线确认）+ Major 3 + Minor 7，已同步进 `../../app/package/[P0]packaging_toolchain.md §3.8`（第五类打包陷阱：编译期资源镜像）+ `§4.3`（按新增内容类型的防复发自检清单，四场景 A-D）。**Major/Minor 发现均未在本版本修**（范围纪律——审计只产报告，修复需用户决策开后续版本）：

- **BUG-002**（Major，open）：browser 工具 packaged 全灭——`browser-worker.cjs` 从不进 dist（与 BUG-001 完全同类）+ spawn 外部 `node`/`npx`（packaged GUI PATH 无）+ asar 内脚本外部进程读不到，三层叠加。
- **BUG-003**（Minor，open）：`WEB_PORT` 不在 runtime-config 白名单（潜伏，现状因唯一调用点未走 packaged 路径侥幸不爆）+ `@app/protocols` 无 build 产物、`main` 指向 `src/index.ts`（现状因全零 value import 侥幸安全，首个 value import 落地即崩）。

## 4. 偏离项（coder/reviewer 汇报 → doc-modifier 已同步进 spec）

| # | 偏离 | 类型 | spec 同步位置 |
|---|------|------|--------------|
| 1 | `checkPromptContentAssets(contentDir: string = CONTENT_DIR)` 比 change_plan 多一个可选参数（原计划零参） | 实现细节偏离，无害 | `../../agent/context/[P0]prompt_content_files.md §3.4` 按实际签名记录；理由=供 UT 注入临时目录测三态，避免动真实共享 `src/prompts/content`（vitest 并行跑撞其他测试文件），真实调用处仍零参、语义不变 |
| 2 | T3 四个 handler 内部对 `readContent()` 结果统一 `.trimEnd()`（change_plan 未逐条明写此步骤，但 T3-a 行已隐含"原实现无分隔符"约束） | 实现细节补充 | `[P0]prompt_content_files.md §7` 补第 8 条边界（content 文件末尾换行 vs 原字面量无尾随换行的补偿约定） |
| 3 | BUG-004 readSessionType 修复完全在原 change_plan 范围外（packaged 验证附带 finding，用户 query 范围内的「playground system 为空」第二根因） | 范围内追加 task，非违反 change_plan | `../../squad/log.md` + `[P1]prompt_sections.md §2` 新增条目 |
| 4 | 3 处 `[v0.0.153]` 注释前缀噪声（routing-decision.ts 1 处 + tick-message.ts 2 处 + Task3 一处）| Minor，reviewer 已直接 Edit 删除 | 无需 spec 同步（代码注释噪声，非 spec 内容偏差） |

## 5. 已知非本版本问题（留档，不阻塞本版验收）

- **AT drift 指纹对 Anthropic wire 格式的覆盖缺口**：`app/server/src/testing/recording-fingerprint.ts` 的 `computeFingerprintFromInit` 从 HTTP wire body 的 `messages[]` 里找 `role==='system'` 抽取 system 文本算指纹，但 **Anthropic 协议的 system 是顶层独立字段、不在 messages 里**——system prompt 变化（如本版 BUG-004 修复后 identity 段恢复）天然不进指纹、hash 恒定，AT replay 报告 `drift=0` 是**这个既有覆盖缺口**导致，不是「修复未生效」的信号（已用组装链 ground truth 交叉验证：debug 端点直接对照 system prompt 前后字符数差异，见 `states/v0.0.153/verify/packaged-verify.md` §BUG-004 修复复验）。是否补 `body.system` 顶层字段抽取进指纹，另议，非本版范围。
- **BUG-002/BUG-003**（打包审计发现，见 §3）：留用户决策是否开后续版本修复。

## 6. 影响（下游 agent 须知）

- **新增 content 文件时的义务**：新增/删除 `app/server/src/prompts/content/` 下的关键文件，必须同步维护 `prompt-handler.ts` 的 `CRITICAL_CONTENT_FILES` 清单（自检覆盖面）；build 期镜像校验（`check-server-build-assets.sh`）无需改动（自动镜像比对）。
- **打包相关改动**：任何新增非 `.ts` 运行时资源（`.md`/`.yaml`/`.json`/`.cjs` 等），须比照本版本模式（build cp + 镜像校验），见 `../../app/package/[P0]packaging_toolchain.md §3.8` + `§4.3` 四场景自检清单。
- **squad prompt 分流判断**：`readSessionType(ctx)` 现已对 `kind.role==='rocky'` 正确归一化为 `undefined`；新增消费方若用 `!sessionType` 做 standalone 判定，行为现已正确，无需额外处理。

## 7. 验收口径

- **UT**：全量 `bun run test` 632 files / 7425 tests，0 failures（含 T1/T2/T3/BUG-004 新增 UT：`check-prompt-content-assets.test.ts`、`auto-naming-handler.test.ts`、`routing-decision.test.ts`、`forked-reminder-handler.test.ts`、`heartbeat-tick-handler.test.ts`、`squad-reminder-providers.test.ts` 归一化 6 case、`prompt-studio.test.ts`/`mapper-delegate.test.ts` 回归用例）。
- **AT**：白名单 4 case（`auto_naming`/`memory_manage_write`/`compact_model_directive`/`chat_send_reply`）replay 4/4 pass、0 drift（含 BUG-004 修复后最终回归轮）。
- **ET**：本版本豁免（无前端/UI 可感知变更，test-plan §3 记录理由）。
- **Packaged 验证**（MANDATORY，打包相关改动）：三层全 PASS——产物层（asar 内 17/17 `.md` 与 src 逐字节一致）+ 运行层（packaged system prompt ≡ dev 基线，`checkPromptContentAssets` 零 missing 告警）+ plugin 链路层（`squad_role.cjs` 在 asar 布局加载成功，leader/mate 正文完整）+ T4 负向验证（故意缺文件 → build 阻断并指名）。详见 `states/v0.0.153/verify/packaged-verify.md`。
