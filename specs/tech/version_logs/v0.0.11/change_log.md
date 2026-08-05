# Tech Change Log — v0.0.11

> 增量记录 v0.0.11 相对 v0.0.10 的技术架构变更。
> 全量概念权威：`specs/tech/agent/`、`specs/tech/config/`、`specs/tech/app/`。
> PRD：`specs/prd/version_logs/v0.0.11/change_log.md`。
> v0.0.11 = **observability 配置化收尾**：dev_config.observability 单对象 → **列表** + `ObservabilityManager` composite（多 backend fan-out）+ 移除 ENV 兜底 + 应用图标 / 机器人头像（Rocky）。

## 1. Scope 与口径

**IN SCOPE（v0.0.11 新增/重构）**：

- **observability 配置列表化**：`dev_config.runtime.observability` data 从单对象改 `ObservabilityConfigItem[]`（id/name/type:'langfuse'/baseUrl/publicKey/secretKey/enabled/desc）。
- **`ObservabilityManager`**（composite adapter）：实现 `ObservabilityAdapter` 接口，持 child adapter 列表 fan-out + 双层容错（per-child try/catch + loop `safe()` 兜底）+ composite handle + 同步对 loop / 异步 shutdown。
- **移除 ENV 兜底**：`LANGFUSE_*` 不再读；纯 dev_config 列表驱动。
- **per-item Langfuse client**：每个 enabled 项一个独立 `LangfuseAdapter` + 独立 langfuse SDK client（不同 baseUrl/凭证隔离 batch queue）。
- **bootstrap 注入点替换**：`createObservabilityAdapter(cfg)` → `createObservabilityManager(items)`。
- **不热更新**：配置改动重启 / 下个 session 生效。
- **应用图标 + 机器人头像**：`reqs/v0.0.11/icon.png` → electron 多尺寸图标 + web 机器人头像 asset；机器人名 **Rocky**（from hail mary project）。

**OUT OF SCOPE（保持 v0.0.10 不变）**：

| 项 | v0.0.11 状态 |
|----|------------|
| `ObservabilityAdapter` 接口（overall §6） | **不动**（manager 实现它，接口零改） |
| `LangfuseAdapter` / `NoopAdapter` / types | **不动**（LangfuseAdapter 被 manager 持有为 child，自身逻辑不变） |
| `agent-loop-observability.ts` 埋点 | **零改动**（manager 透明替换，论证见 `observability_manager.md §9`） |
| OTel backend / 多 vendor 扩展 | future（type 字段预留，v0.0.11 仅 langfuse） |
| 配置热更新 / session 级 manager 重建 | future（重启 / 下 session 生效） |

## 2. Observability 配置：single → list + Manager + 移除 ENV

**为什么**：用户要求 observability 是列表（dev 可配多条：self-host + cloud 双写、staging/prod 隔离），并明确要求 agent loop 调一个 "observability manager"，对每个 enabled item fan-out、异步、容错、不影响 loop。v0.0.10 的单 adapter + ENV 兜底是初版（`reqs/v0.0.10/bugs.md`），列表化是配置化的正确终点。

**关键实现点**：

- **dev_config schema**（`specs/tech/config/[P0]dev_config.md §3.4.1`）：`runtime.observability` data = `ObservabilityConfigItem[]`；字段 id/name/type:'langfuse'/baseUrl/publicKey/secretKey(secret)/enabled/desc。
- **`ObservabilityManager`**（`specs/tech/agent/observability/[P0]observability_manager.md`）：composite adapter，fan-out + 双层容错 + composite handle；空列表/全 disabled 等价 Noop。
- **移除 ENV 兜底**（`app/server/src/observability/index.ts`）：删 `process.env['LANGFUSE_*']` 读取；凭证只来自 dev_config 列表。
- **per-item client**：每 enabled 项独立 `LangfuseAdapter` + 独立 SDK client（避免不同 baseUrl 的 batch queue 串项目）。
- **bootstrap 替换**（`app/server/src/bootstrap.ts`）：`createObservabilityAdapter(cfg as ObservabilityConfig)` → `createObservabilityManager(items as ObservabilityConfigItem[])`。
- **flush 双触发沿用**：node SIGTERM/SIGINT + electron before-quit 都调 `shutdownObservability()`；内部从 `singletonAdapter.shutdown()` 改 `manager.shutdown()`（`Promise.allSettled` fan-out 各 child）。
- **测试 env_start 改造**：`tests/api/env_start.sh` + `tests/e2e/env_start.sh` 不再注入 `LANGFUSE_*`；改为 seed 一条 dev_config.runtime.observability 列表项（用真机 langfuse 凭证，沿用 v0.0.10 真机验证基线）。

**对应 spec**：`specs/tech/agent/observability/[P0]observability_manager.md`（新建 v1.0）+ `[P0]overall.md` v1.2（§7/§8 改）+ `specs/tech/config/[P0]dev_config.md` v2.3（§3.4.1/§5/§8 改）。

## 3. agent loop 埋点零改动（论证）

`LoopObservability`（`app/server/src/agent/agent-loop-observability.ts`）的 8 个方法全部走 `this.adapter.xxx(...)`。v0.0.11 把 `this.adapter` 实例从单 adapter 换成 manager（同实现 `ObservabilityAdapter`），调用代码/参数/handle 用法/`safe()` 兜底一字不改。**接口不变 = 埋点不变**。完整对照表见 `observability_manager.md §9`。

## 4. 应用图标 + 机器人头像（Rocky）

**为什么**：`reqs/v0.0.11/icon.png` 是用户提供的机器人形象（Rocky from hail mary project）。要求 app 图标和对话页机器人头像都换成它。

**关键实现点**：

- **electron app 图标多尺寸**（`app/electron/electron-builder.yml` + `app/electron/buildResources/`）：
  - electron-builder macOS DMG 需要 `.icns`（多尺寸 16/32/64/128/256/512/1024），Windows NSIS 需要 `.ico`（多尺寸 16/32/48/64/128/256）。
  - 资产处理方案：用 `iconutil`（macOS 自带）/ `png2icons`（npm）把 `icon.png`（1024×1024 源）一次性生成 `icon.icns` + `icon.ico`，放 `app/electron/buildResources/`（electron-builder `buildResources` 字段已指向此目录，见 `electron-builder.yml:15`）。
  - electron-builder 默认在 `buildResources/` 找 `icon.icns`（mac）/ `icon.ico`（win），文件名约定即可，yml 无需显式 `mac.icon` / `win.icon` 字段。
  - 主进程 BrowserWindow 也可读 `buildResources/icon.png` 作为窗口图标（dev 模式未打包时，dmg 不可用，BrowserWindow 用 png 兜底）。
- **web 机器人头像 asset**（`app/web/`）：
  - 把 `icon.png` 复制到 `app/web/src/assets/rocky-avatar.png`（或 `public/`）。
  - 对话页 agent avatar（`component-message-row.tsx` 左/右头像列，v0.0.10 是渐变底首字母 "R"）改为 `<img src={rockyAvatar}>`；保留 user avatar（首字母）不变。
  - 机器人名 "Rocky" 作为 agent 默认 displayName（session / 对话标题展示，涉及 `specs/ui/`，本 tech spec 不重叠）。
- **机器人名标 "Rocky"**：来源 `reqs/v0.0.11/req.md`（"机器人名字叫 Rocky from hail mary project"）；app productName / 对话默认标题 / agent 名统一改 Rocky（productName 改动归 `prod.env APP_NAME`，本 spec 不动 env）。

**资产处理工具链**：

```bash
# 从 icon.png (1024×1024) 生成 .icns + .ico
npx png2icons icon.png icon -all -i   # 产出 icon.icns + icon.ico（多尺寸内嵌）
mv icon.icns icon.ico app/electron/buildResources/
```

> 若源图非 1024×1024，先用 `sips -z 1024 1024 icon.png`（macOS 自带）resize。源图 `reqs/v0.0.11/icon.png` 是权威源，所有尺寸由工具派生（不手画）。

**对应 spec**：`specs/tech/app/package/[P0]packaging_toolchain.md`（buildResources 字段归属，已存在）+ 本 change_log §4（图标资产处理决策）。UI 展示（avatar 落点 / Rocky 名标）归 `specs/ui/`，本 tech spec 不重叠。

## 5. 文件级变更清单（汇总）

**新增**：
- `specs/tech/agent/observability/[P0]observability_manager.md`（v1.0，composite adapter 设计）。
- `app/server/src/observability/manager.ts`（impl — `ObservabilityManager` class + `createObservabilityManager` factory，**spec 阶段不写代码**）。
- `app/electron/buildResources/icon.icns` + `icon.ico`（从 `reqs/v0.0.11/icon.png` 派生）。
- `app/web/src/assets/rocky-avatar.png`（复制自 `reqs/v0.0.11/icon.png`）。

**修改**：
- `specs/tech/agent/observability/[P0]overall.md`（§7 注入 + §8 backend 表 + §10 版本 → v1.2）。
- `specs/tech/config/[P0]dev_config.md`（§3.4.1 observability 列表 schema + §5 消费链 + §8 版本 → v2.3）。
- `app/server/src/observability/index.ts`（移除 `createObservabilityAdapter` + ENV 读取；导出 `createObservabilityManager`；`shutdownObservability` 调 manager.shutdown）。
- `app/server/src/bootstrap.ts`（`createObservabilityAdapter(cfg)` → `createObservabilityManager(items)`；cfg 单对象 → items 数组）。
- `app/server/src/config/schema_defs/dev_config.ts`（若 data 形状有 typed guard，按列表更新；schema 本身 json 通用不强改）。
- `app/web/src/components/chat/component-message-row.tsx`（agent avatar 渐变首字母 → rocky-avatar.png img）。
- `tests/api/env_start.sh` + `tests/e2e/env_start.sh`（注入方式改：删 `LANGFUSE_*` export → seed dev_config.runtime.observability 列表）。

**不改**（关键不变量）：
- `app/server/src/agent/agent-loop-observability.ts`（埋点零改动）。
- `app/server/src/observability/{adapter,types,langfuse-adapter,noop-adapter}.ts`（接口/类型/child impl 不动）。
- `app/server/src/agent/context-types.ts`（`SessionConfig.observability: ObservabilityAdapter` 类型不变，只是实例从单 adapter 变 manager）。

## 6. 与 v0.0.10 spec 的差异（破坏性变更清单）

| 维度 | v0.0.10 | v0.0.11 | 破坏性 |
|---|---|---|---|
| dev_config.observability data 形状 | 单对象 `{vendor, publicKey, secretKey, baseUrl, enabled?}` | 列表 `ObservabilityConfigItem[]`（id/name/type/baseUrl/publicKey/secretKey/enabled/desc） | **是**（旧格式不兼容，dev 重配） |
| 字段名 | `vendor` | `type` | **是**（语义同，命名改） |
| 凭证来源 | dev_config（主）+ ENV `LANGFUSE_*` 兜底 | **纯 dev_config 列表**（ENV 完全移除） | **是**（依赖 ENV 的部署需迁移到 dev_config） |
| SessionConfig.observability 实例 | `LangfuseAdapter`（singleton）/ `NoopAdapter` | `ObservabilityManager`（composite，持 N 个 `LangfuseAdapter` child） | 否（实例类型变，但都实现 `ObservabilityAdapter`，对 loop 透明） |
| Langfuse client 数量 | 1（singleton） | N（per enabled item） | 否（内部隔离） |
| agent loop 埋点 | 直接调 adapter | 调 manager（背后 fan-out） | **否**（代码零改动） |
| ObservabilityAdapter 接口 | overall §6 | **不动** | 否 |
| flush 双触发 | node SIGTERM + electron before-quit | 同（manager.shutdown fan-out） | 否 |
| 配置生效 | bootstrap 读 → 注入 | 同（**不热更新**，重启/下 session 生效） | 否（与 v0.0.10 行为一致，仅显式声明） |

## 7. 验证结论（no-mock，真机 langfuse 凭证）

- **UT**：784 绿。
- **AT**（API）：3/3 PASS — dev_config observability CRUD（GET redact `"***"` 实测、PUT 占位 `"***"` merge 保留原值实测、PUT 真值落盘实测）；noop 空列表（langfuse 404 即无后端，loop 无感知）；manager 真链路（5 observation 上报 = v0.0.10 等价）。
- **ET**（E2E）：2/2 PASS — rocky（5/5：app 图标 + avatar + name）；dev_config（功能 + 视觉 compare 8/8，observability list/detail 对齐设计稿）。
- **Bug 闭环**：BUG-001 closed（manager parent handle 反查映射 `resolveParentPerChild`——核心设计点，见 `observability_manager.md §4.1`）；BUG-002 closed（observability list 视觉对齐）。
- **Code review**：CONDITIONAL PASS — Major = `lib/observability-api.ts` 与 `api-client.ts`/`chat-api.ts` 三份 `req` 重复（沿袭 v0.0.8 旧债），留技术债抽 `lib/http.ts`（见 `progress.md` 技术债节）。

## 8. 版本

version: 1.0（v0.0.11 新建：observability 配置 single→list + ObservabilityManager composite（fan-out/双层容错/composite handle/per-item client/移除 ENV/不热更新）+ agent loop 埋点零改动 + 应用图标（icon.png → icns/ico 多尺寸）+ Rocky 机器人头像 asset）。
