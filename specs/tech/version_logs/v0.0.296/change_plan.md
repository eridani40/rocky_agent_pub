# v0.0.296 变更计划书 — bash 工具沙箱开关

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 变更概述

让用户能在应用设置 → 工具 tab 下切换 bash 执行引擎（开 = SecureBashEngine seatbelt 沙箱 / 关 = PassthroughBashEngine 直接 spawn）。解决嵌套沙箱（exit 71）问题。

三件事：
1. 后端 `bash-engine.ts`：新增 `PassthroughBashEngine` + `getBashEngine()` 读 app config 决定走哪个 engine
2. 前端 `section-tab-panel.tsx`：工具 tab 加第 4 个 section（bash）
3. 前端新增 `section-bash-config.tsx`：toggle switch + save/reset（saveMode='item'，同 see_image 范式）
4. i18n + 组件 spec

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bash-engine | app/server/src/tools/bash-engine.ts | `PassthroughBashEngine` | 新增 | class impl `BashEngine`，`exec()` 直接调 `runShell()`（与 SecureBashEngine 非 darwin 分支逻辑一致：不 spawn sandbox-exec，直接 spawn shell） | MUST impl BashEngine 接口；MUST NOT 加任何沙箱策略；MUST 复用现有 `runShell`（不另写 spawn 逻辑） | bash_tools.md §4；PRD §3.2 | +12 |
| bash-engine | app/server/src/tools/bash-engine.ts | `getBashEngine` | 修改 | 改为按 app config（group=runtime, key=bash_seatbelt）决策：`false` → PassthroughBashEngine；`true`/缺失/读取失败 → SecureBashEngine（现有行为）。配置在单例创建时同步读取（不依赖 DI 注入 AppConfigService——直接从 bootstrap 层注入的全局 appConfig 读取，与 observability 同范式） | MUST 保持进程级单例语义不变；MUST `bash_seatbelt===false` 才走 passthrough（缺失/true/异常均回退 SecureBashEngine）；MUST NOT 改 bash.ts 调用方式（`getBashEngine().exec(...)` 签名不变）；非 darwin 无变化（SecureBashEngine 内部非 darwin 分支本就走 runShell） | app_config.md §3.9 runtime group；PRD §3.2 | +15/-3 |
| bash-engine | app/server/src/tools/bash-engine.ts | `setBashEngineConfigReader` | 新增 | 注入配置读取函数的 setter（供 bootstrap 调用注入 `() => appConfig.get('runtime','bash_seatbelt')`）；默认值（未注入时）= 读不到 → 走 SecureBashEngine | MUST 默认安全（注入前 = SecureBashEngine）；MUST NOT 引入 DI 容器或构造函数耦合（轻量 setter 注入，同 `ce.setSessionStore` 范式） | 原则#6 Plugin 注入范式 | +8 |
| bash-engine | app/server/src/tools/bash-engine.ts | `_engine` | 修改 | 模块级单例变量，增加 `_configReader` 模块级变量（默认 null） | MUST 单例在首次 getBashEngine() 调用时惰性创建（读取 configReader 决策） | bash_tools.md §4.3 | +2 |
| bootstrap | app/server/src/bootstrap.ts | (bootstrap 装配段) | 修改 | 在 AppConfigService 初始化后、agent 装配前，调 `setBashEngineConfigReader(() => appConfig.get('runtime', 'bash_seatbelt'))` | MUST 在 getBashEngine() 首次调用前注入；MUST 用箭头函数延迟读取（appConfig 已 init 但惰性求值保证一致性） | app_config.md §3.9 | +3 |
| ui-config | app/web/src/components/app-dev-config-page/section-tab-panel.tsx | `SectionTabPanel` (case 'tools') | 修改 | 在 see_image section 下方新增第 4 个 `<div className="mt-8">`：标题 `t('group.bash.label')` + `<SectionBashConfig />` | MUST 放在 see_image 之后（第 4 个 section）；MUST 同 `<div className="mt-8">` 间距范式 | section-tab-panel.tsx case 'tools' | +6 |
| ui-config | app/web/src/components/app-dev-config-page/section-tab-panel.tsx | (import) | 新增 | `import { SectionBashConfig } from './section-bash-config'` | — | — | +1 |
| ui-config | app/web/src/components/app-dev-config-page/section-bash-config.tsx | `SectionBashConfig` | 新增 | 自渲染 section（saveMode='item'）：挂载 GET `/config/app?group=runtime&key=bash_seatbelt` 读 baseline（null→true）；ToggleSwitch 控制 draft；save → PUT `/config/app` body={group:'runtime',items:[{key:'bash_seatbelt',data:draft}]}}；reset → draft 回 baseline；含「重启生效」提示文案 | MUST saveMode='item' 自管 save/reset（同 see_image 范式，不消费 useAppSettingsConfig）；MUST 复用 ToggleSwitch primitive；MUST baseline null/缺失 → 显示 true；MUST dirty 时 save/reset 才激活；MUST save 后提示「重启生效」 | section-see-image-config.tsx（同构范式）；PRD §3.3 §4 | +120 |
| i18n | app/web/src/i18n/locales/zh-CN/app-dev-config.json | (group.bash + bash.* keys) | 新增 | `"group": {"bash": {"label": "Bash 工具"}}`；`"bash": {"sectionDesc": "沙箱（seatbelt）保护 — 在嵌套沙箱环境（如 Rocky agent 自身运行在沙箱内时）可关闭以避免 exit 71", "toggleLabel": "使用沙箱", "save": "保存", "reset": "重置", "saving": "保存中…", "restartNotice": "改动需重启应用后生效"}` | MUST 对齐 webSearch/seeImage key 命名范式 | app-dev-config.json seeImage/webSearch keys | +10 |
| i18n | app/web/src/i18n/locales/en/app-dev-config.json | (同上英文) | 新增 | 英文对应 key | — | — | +10 |

## 文件级变更清单（汇总）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| app/server/src/tools/bash-engine.ts | 修改 | 新增 `PassthroughBashEngine` class；新增 `setBashEngineConfigReader()` setter + `_configReader` 模块变量；`getBashEngine()` 改为按配置决策 |
| app/server/src/bootstrap.ts | 修改 | 装配段注入 `setBashEngineConfigReader`（3 行） |
| app/web/src/components/app-dev-config-page/section-tab-panel.tsx | 修改 | import + case 'tools' 加第 4 个 section |
| app/web/src/components/app-dev-config-page/section-bash-config.tsx | 新增 | 自渲染 bash 配置 section（toggle + save/reset） |
| app/web/src/i18n/locales/zh-CN/app-dev-config.json | 修改 | 加 group.bash + bash.* keys |
| app/web/src/i18n/locales/en/app-dev-config.json | 修改 | 加 group.bash + bash.* keys（英文） |

## 影响面评估

**跨模块**：后端 bash-engine（核心）+ bootstrap（注入）+ 前端 section-tab-panel + 新建 section-bash-config + i18n。

**破坏性变更**：无。`getBashEngine()` 签名不变（`bash.ts` 零改动）；`BashEngine` 接口不变；`SecureBashEngine` 内部逻辑不动。

**关键设计决策**：

1. **配置注入方式 = setter（非 DI 构造函数）**：`bash-engine.ts` 不 import `AppConfigService`（避免 tools → config 跨层耦合）。由 bootstrap 在启动时调 `setBashEngineConfigReader(() => appConfig.get(...))` 注入一个读取函数。未注入时默认走 SecureBashEngine（安全默认）。与 `ce.setSessionStore(ss)` 注入范式一致（原则#6）。

2. **配置读取时机 = 单例惰性初始化时**：`getBashEngine()` 是进程级单例，首次调用时读 configReader 决策。**配置变更需重启生效**（与 observability/consolidation 一致，UI 已提示「重启生效」）。这是合理的——bash engine 在进程内持有很多 spawn 状态，运行时切换 engine 不现实。

3. **PassthroughBashEngine vs SecureBashEngine 非 darwin 分支**：SecureBashEngine 在非 darwin 时本就走 `runShell`（passthrough）。PassthroughBashEngine 是**显式独立 class**（不依赖 platform 判断），语义清晰、可测试。darwin + bash_seatbelt=false → PassthroughBashEngine（显式不走 sandbox-exec）。

**依赖顺序**：后端 bash-engine 改完 → bootstrap 注入 → 前端独立开发（不依赖后端改动）。

**风险点**：
- `_configReader` 未注入时必须安全回退 SecureBashEngine（已有测试 `bash-engine-group-kill.test.ts` 调 `getBashEngine()` 不注入 configReader → 必须仍返回 SecureBashEngine）
- UT 需 mock configReader 或测默认回退路径

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
