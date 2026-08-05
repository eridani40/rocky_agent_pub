# Tech 版本变更日志 - v0.0.3（plugin_system / config P0 简化定稿）

> 主题：把 plugin_system 与 config 的 P0 简化定稿落地——术语统一 contribution→ext impl、身份=string、两张独立 config 表、砍 point/EP 级 config、record 只在写入时生成（树来自 registry）、impl 导出类（非 activate）、API key 全用 string、默认 enabled。

## 变更概要

| 类型 | 文件 | 变更 |
|------|------|------|
| 改名 | `plugin_system/[P0]contribution_and_manifest_interface.md` → `[P0]ext_impl_and_manifest_interface.md` | git mv；全文 contribution→ext impl；`contributes`→`extImpls`；`Contribution`→`ExtImpl`（implId 必填、唯一 key）；删 activate 引用，impl 改为「导出类」；§3.6 新增「impl 导出类（非 activate）」决策；version 1.2→2.0 |
| 改 | `plugin_system/[P1]plugin_lifecycle.md` (→2.0) | 删 `activate(ctx)` 契约、PluginModule/PluginActivateContext/ContributionRegistry/HostCapabilities；四相改为 discovery→manifest-registry→enable→get 时实例化；强调 discovered=registered、无"已激活"中间态、唯一闸 enabled；P0 注 native 注册 |
| 改 | `plugin_system/[P0]plugin_manager_interface.md` (→2.0) | §3.4 静态注册改为「登记 ext impl 类（按 point+implId 索引）」；§1 getExtensionImpls 返回 enabled 的 ext impl 按当前 config 实例化的对象；selectExclusive→setExclusive；术语 ext impl |
| 改 | `plugin_system/[P0]extension_point_interface.md` (→2.0) | 删 `configSchema?` 字段；§3.8 重写为「EP 是 contract（代码常量），无 point 级 config」；selectExclusive→setExclusive、setPriority→setOrder、id→implId；术语 ext impl |
| 改 | `plugin_system/[P0]overview.md` (→2.0) | §2.5 管理矩阵改 2 级（plugin+ext impl），删 point 级行；API key 用 pluginId/implId；删 activate/HostCapabilities/activation-plan；§4 文件地图 contribution→ext_impl；默认 enabled（native 全开，origin 标 P1）；§5 关键决策补「身份=string」「impl 导出类」「默认 enabled」 |
| 改 | `config/[P0]plugin_config_service.md` (→2.0) | API key 全 string：setEnabled/setImplEnabled/setExclusive(改名自 selectExclusive)/setOrder(改名自 setPriority, 仅 ordered)/setImplConfig/setConfig/persist/inventory；删 setPointConfig、删复合 key、删 TrustPolicy(标 P1/future)、删 HostCapabilities 引用；P0 默认全开；inventory 树来自 registry 代码 |
| 改 | `config/[P0]plugin_config.md` (→2.0) | 删 `PointConfigRecord`；`ImplConfigRecord`→`ExtImplConfigRecord`（去 pointId/pluginId 复合 key，仅 implId）；PluginConfigRecord 补 enabled 字段、id 改可选；§5 两张独立 collection（plugin_config/ext_impl_config），engine file；强调 record 只在写入时生成、树来自 registry |
| 改 | `config/[P0]overview.md` (→1.3→2.0) | PluginConfig 改为 2 级（plugin+ext impl）/ 2 张表，删 point 级；§3 关系图 Contribution→ExtImpl；§5.2 API 列表改 string key；§6 overlay 模型强调「树来自 registry、record 只在写入时生成」；默认表 P0 全开 |
| 改 | `deps.md` | 板块 8 描述补 ext impl；10→8 边 Contribution→ExtImpl；§关键证据文件补「两级 config 表 + string key API，P0 默认全开」 |
| 改 | `persistence/[P0]overview.md` §7 | plugin_system+config 边界补「plugin_config/ext_impl_config 两张独立 collection（key=pluginId/implId），稀疏 delta，树来自 registry」 |
| 改 | `plugin_system/[P1]discovery_and_install_interface.md` | manifest 字段指向 ext_impl_and_manifest；discovery「绝不 import 代码」→「绝不实例化 impl 类」；P0 无 discovery 相；启用/信任策略标 P1 |
| 改 | `plugin_system/[P1]isolation_and_threat_model.md` | 「启用激活后」→「enabled 并 get 实例化后」；§3.2 P0 native 全开、P1 origin 策略；边界表 activate(ctx).host→impl 类实例化注入 config |

## 核心原则成文 / 重申（本批首次写入或强化）

1. **身份 = string**：plugin / ext impl 是代码定义的，身份就是 string（pluginId/implId），无额外实体 id；config record 存 string 作逻辑 key，ULID 物理主键可选。
2. **两张独立 config 表**：`plugin_config`（key=pluginId）+ `ext_impl_config`（key=implId），不共用、无复合 key、无 point 级表。
3. **point/EP 级 config 砍掉**：EP 是 contract（代码常量），需要配置写死在 EP 定义里，不进数据表、无 point 级 record。
4. **树来自 registry、record 只在写入时生成**：config 页面渲染的树 100% 来自 plugin registry（代码），不读 config 表；config 表是稀疏 delta，绝不是存在性来源。
5. **impl 导出类（非 activate）**：registry 持有 ext impl 的类，get 时按当前 config 实例化（config 改 → next-get 反映新实例）；无 activate(ctx)、无 HostCapabilities（P1/future）。
6. **API key 全用 string**：PluginConfigService 全部方法 key 用 pluginId/implId，无复合 key。
7. **默认 enabled**：P0 全是 native 受信 → 默认全开；origin 来源/TrustPolicy 是 P1。

## grep 核验

- `grep -rn "contribution\|Contribution\|PointConfigRecord\|setPointConfig\|HostCapabilities\|activate(ctx)" specs/tech/`（排除 version_logs）：仅剩迁移注释（"原 ImplConfigRecord 改名"、"吸收原 ConfigBackend"）与决策/反例中说明性引用（"非 activate"、"无 activate(ctx)"、"无 HostCapabilities"、"原 activate 模型残留"）——无任何指向已删契约的失效引用或残留字段定义。
- 复合 key `(pointId, pluginId, implId)`：已清除（ExtImplConfigRecord 仅 implId）。
- 文件名 `ext_impl_and_manifest_interface.md`：所有引用（extension_point_interface、plugin_manager_interface、overview、discovery_and_install、plugin_lifecycle）一致。

## 文件清单（plugin_system + config 改后）

```
plugin_system/
├── [P0]ext_impl_and_manifest_interface.md   (v2.0, 改名+重写)
├── [P0]extension_point_interface.md         (v2.0, 删 configSchema+§3.8 重写)
├── [P0]overview.md                          (v2.0, 2 级矩阵+默认 enabled)
├── [P0]plugin_manager_interface.md          (v2.0, 类登记+get 时实例化)
├── [P1]plugin_lifecycle.md                  (v2.0, 删 activate 契约)
├── [P1]discovery_and_install_interface.md   (术语同步)
└── [P1]isolation_and_threat_model.md        (术语同步)
config/
├── [P0]overview.md                (v2.0, 2 级/2 表)
├── [P0]plugin_config.md           (v2.0, 删 PointConfigRecord+改名 ExtImplConfigRecord)
└── [P0]plugin_config_service.md   (v2.0, string key API+默认全开)
```

---

## 第二批变更（v0.0.3 LLM + Chat 架构补 spec 缺口 + 落地 API/UI spec）

> 主题：基于 PRD `03-llm-chat.md`（6 关键路径）+ researcher 报告（anthropic SSE thinking_delta），补 4 个 tech spec 缺口 + 产出 specs/api + specs/ui。落地「v0.0.3 chat 无 session、SSE 复用 protocol StreamEvent、内置 plugin 目录约定」三件事。

### 变更概要（第二批）

| 类型 | 文件 | 变更 |
|------|------|------|
| 改 | `agent/providers_and_models/[P0]llm_protocol_interface.md` (v2.0→**2.1**) | §2 流式 `StreamEvent` 加 `thinking_delta` 变体（与 text_delta 平行独立）；新增 §3.6 决策「thinking_delta 与 text_delta 平行独立变体」；流式章节注明「/chat SSE 复用 StreamEvent，不另定 wire event」 |
| 新增 | `plugin_system/[P0]builtin_plugins_directory.md` (v1.0) | 内置 plugin 目录约定：`app/plugins/builtins/<pluginId>/plugin.json`；P0 静态注册扫描点；目录名=manifest.id 镜像校验；impl 路径相对 plugin 目录 |
| 新增 | `specs/api/overall/02-llm-chat.md` (v1.0) | server HTTP facade：`POST /chat`（SSE 复用 StreamEvent）+ `GET/PUT /config/{app,dev,plugin}` + `/provider` CRUD + `/provider/:id/model` CRUD；约定 chat 无 session/无持久化/带最近 10 条 message；credentials 响应脱敏 |
| 新增 | `specs/ui/overall/02-llm-chat.md` (v1.0) | web 渲染层：2 栏布局（左窄菜单 + 3 设置按钮下对齐）+ ChatPage（thinking 折叠 + answer text 流式，part key=`messageId:partIndex`）+ AppSettingsPage（theme）+ PluginSettingsPage（provider/model）+ DevSettingsPage（llm request 两 key）+ theme dark/light token 映射；全量 testid |

### 本批新增的核心原则（成文）

8. **`thinking_delta` 是 protocol `StreamEvent` 的独立变体**：与 `text_delta` 平行（不嵌进通用 `block_delta`），来自 anthropic 不同 content block 的 `index`。chat UI 按 `messageId:partIndex` 路由 delta 到不同 part。P0 仅 `anthropic_messages` impl 产出。
9. **`/chat` SSE 复用 protocol `StreamEvent`**：server 不另定 wire event，每条 `StreamEvent` 序列化为一条 SSE 帧原样推前端。简化协议层一致性（protocol/api/ui 三处同一份事件类型）。
10. **v0.0.3 chat 无 session/无持久化/带最近 10 条 message**：前端内存维护对话记录（刷新即失），发请求裁剪到最近 10 条；server 不建 session、不维护上下文窗口。YAGNI for v0.0.3 验证切片。
11. **内置 plugin 目录 = `app/plugins/builtins/<pluginId>/plugin.json`**：固定单一扫描点，目录名=manifest.id 镜像校验，impl 路径相对 plugin 目录。P0 不参数化扫描点、不接外部来源。
12. **chat part 用 `messageId:partIndex` 作 React key**：不依赖数组 index（anthropic SSE index 是协议层稳定 id，UI 按 index 路由 delta 到对应 part，乱序到达不抖动）。与 CLAUDE.md「以 message+part 为 key」原则一致。

### scope.in 7 项覆盖核对

| PRD scope.in 项 | 覆盖 spec | 状态 |
|---|---|---|
| 1. config 三域 service（AppConfig/DevConfig/PluginConfig，底经 CrudStore，overlay 增量） | `config/[P0]app_config.md` §5 / `dev_config.md` / `plugin_config_service.md`（v2.0 第一批）+ `api/02-llm-chat.md` §4 | ✅ 覆盖 |
| 2. plugin 静态内核（ExtensionPoint llm_provider/llm_protocol list + Registry + PluginManager.getExtensionImpls + PluginConfigService） | `plugin_system/[P0]*` v2.0 第一批 + `builtin_plugins_directory.md`（第二批，扫描点） | ✅ 覆盖 |
| 3. llm 三件套（provider ext impl + protocol ext impl + providerConfig/modelConfig + LlmClient 组装） | `agent/providers_and_models/[P0]llm_*_interface.md`（含 v2.1 thinking_delta）+ `builtin_plugins_directory.md`（llm_anthropic manifest 示例） | ✅ 覆盖 |
| 4. server HTTP facade（/chat SSE + /config + /provider + /model；LlmClient 调 Anthropic） | `api/02-llm-chat.md` §3-5（chat SSE 复用 StreamEvent + provider/model CRUD） | ✅ 覆盖 |
| 5. chat UI（2 栏布局 + 流式 thinking-answer + 选 model 按钮 + theme 切换） | `ui/02-llm-chat.md` §2-3 + §7（theme token） | ✅ 覆盖 |
| 6. 设置 UI（app theme + plugin providers_and_models + dev llm request） | `ui/02-llm-chat.md` §4-6 | ✅ 覆盖 |
| 7. 三层验证（UT + AT + ET） | `api/02-llm-chat.md`（AT 依据）+ `ui/02-llm-chat.md` §8（ET 覆盖映射，含 testid） | ✅ 覆盖（测试用例文件由 orchestrator 阶段 2.5 委派 coder 创建） |

### 实现范围（v0.0.3 coder 将做的，由 spec 推导）

- server：新增 `/chat` `/config/*` `/provider/*` 路由 + LlmClient 组装层（resolveProviderConfig deepMerge）。
- 内置 plugin：`app/plugins/builtins/llm_anthropic/`（provider.ts + protocol.ts + plugin.json）。
- web：AppShell（2 栏）+ ChatPage（SSE reducer）+ 3 设置页 + theme token CSS。
- config 三域 service 落地（AppConfigService / DevConfigService / PluginConfigService）底经 CrudStore。

### 内部一致性自查

- `thinking_delta` 三处一致：
  - **protocol**（`llm_protocol_interface.md` v2.1 §2 StreamEvent + §3.6 决策）：定义变体。
  - **api**（`api/02-llm-chat.md` §3.3）：`/chat` SSE 帧类型 `event: thinking_delta`，与 protocol 一一对应。
  - **ui**（`ui/02-llm-chat.md` §3.2 ChatPart.type + §3.4 reducer）：reducer 按 `thinking_delta` event 路由到 thinking part。
- 「chat 无 session」：api §1 + ui §1.1（currentView 内存路由，无 URL）+ PRD §5.1 一致。
- 「SSE 复用 StreamEvent」：protocol §2 注 + api §1 + §3.3 一致。
- 「内置 plugin 目录」：`builtin_plugins_directory.md` §2 + llm_anthropic manifest 示例与 `ext_impl_and_manifest_interface.md` §2 schema 一致（id + extImpls）。
- credentials 脱敏：api §5.4（响应 `"***"`）+ PRD §5.1（key 不下发前端）一致。

---

## 第三批变更（v0.0.3 实现落地后 — doc-modifier 阶段5 同步）

> 主题：v0.0.3 三层验证全通过（UT 386/AT 6/ET 4 + BUG-001 closed）后，把编码/验证过程中产生的实际决策、与 spec 文字的偏离、bug 修复补回 spec，使 specs 与代码 1:1。本批不新增 spec 文件，只补实现决策 + 修正 design_system dark hex。

### 实现决策与偏离（spec 文字与代码一致化）

| 决策点 | spec 文字 | 实现 | 处置 |
|------|------|------|------|
| **config 落盘路径重复层** | `app_config §5` dirTemplate=`app_config/{shardKey}/`，shardKey=group | 实际落盘 `app_config/{group}/app_config/<id>.json`（dirTemplate 与 entity 名重名导致多一层 `app_config/`） | **接受（方案 A）**：shard 按 group 正确分片，AC（不同 group 落不同 shard）满足；多一层目录不影响功能。spec 文字补此偏离说明，代码不动。 |
| **provider DELETE 用 tombstone** | `api §5.1` DELETE `/provider/:id` 删 provider | KvConfigService 无 delete 接口（v0.0.2 只提供 KV upsert/get/listGroup），实现用 `_deleted=true` tombstone 标记软删 | **接受（功能妥协）**：GET 过滤 tombstone 对外表现为已删；功能正确。spec 补实现说明，未来加 delete 接口时清理 tombstone。 |
| **`/chat` providerId = ULID** | `api §5.2` ProviderInstance.id 是 ULID，`/chat` providerId 命中 app_config providers 组 record | 实现按 ULID 解析 providerId，原 chat_tc1 用 record key 偏差（已修 case 反哺 tests/） | **spec 一致，无需改**。AT 发现并修正了 case 偏差。 |
| **theme 首屏初始化** | `ui §7` theme 由 appearance.theme 决定，切 data-theme + CSS 变量集 | 原实现仅在 AppSettingsPage 切换时设 data-theme，**首屏刷新未据 theme 初始化** → BUG-001（Major）。修复：新增 `lib/theme-init.ts` 共享 `initThemeFromConfig()` + `applyTheme()`，`main.tsx` 入口首屏渲染前 `await initThemeFromConfig()` 设 data-theme（无闪烁），AppSettingsPage 复用消除重复 | **代码已修，spec 补「首屏初始化」机制**（ui §7 + design_system §2.1 dark hex 注）。 |
| **bootstrap 改走 BuiltinLoader** | `plugin_system/[P0]builtin_plugins_directory.md` 扫描点是 builtin-loader | 原实现 `bootstrap.ts` 硬编码注册 `builtin.anthropic`（绕过 plugin 系统，T7 plugin.json 成死文件，pluginId 双源不一致）→ code-review T4 FAILED 第1次。修复：bootstrap 改调 `BuiltinLoader.loadAll()` 扫 `app/plugins/builtins/*/plugin.json`（pluginId=`llm_anthropic`，与 spec 一致）+ Promise 缓存 | **代码已修，spec 一致**。review 记 follow-up：llm-client-factory pluginId 硬编码（provider config 层走 implId 不受影响）。 |
| **builtin plugin re-export 用静态 import 赋值** | `ext_impl_and_manifest_interface.md` impl 导出类 | vite `export ... from` 跨 workspace 解析失败（app/plugins → app/server/llm 跨包），改用静态 `import * as` 后赋值导出 | **实现细节，spec 无需改**（manifest 形态不变）。记录于本 log 供未来排查。 |

### design_system dark hex 补全

`design_system.md §2.1` 原只有 light（暖色 light）hex 表，T5 实现 theme 时 dark hex 暂用 `ui §7` 对照值，阶段5 由 doc-modifier 把 dark hex 补进 design_system（成为 dark/light 双套权威源，ui §7 已注明「以 design_system.md 为准」）。具体补丁见 `design_system.md §2.1` 修订。

### 三层验证结果（驱动本批同步）

- **UT**：386/386 全绿（T1-T7 累计 + BUG-001 修复新增测试）。
- **AT**：6/6 PASS（chat_tc1 / config×3 / provider×2），UT 380 + 5/6 case 首轮 checkpoint 语义偏差已在 states 副本修正并反哺 tests/。
- **ET**：首轮 1/3 PASS（chat_stream ✓ / app_theme ✗ BUG-001 / dev_llm+plugin_provider case 文案偏严），回归 4/4 PASS（BUG-001 closed，文案调整后全过）。
- **BUG-001**（Major）：theme 刷新不恢复 → coder 修（lib/theme-init.ts + main.tsx await）→ 回归 4/4 PASS → closed。

### 本批补丁文件清单

| 文件 | 变更 |
|------|------|
| `specs/tech/version_logs/v0.0.3/change_log.md`（本文件） | 追加第三批：实现决策与偏离表 + design_system dark hex 补全说明 + 三层验证结果 |
| `specs/tech/app/frontend/[P0]design_system.md` §2.1 | 补 dark hex 取值表（bg-base `#1f1a17` 等），成为 dark/light 双套权威源 |
| `specs/ui/overall/02-llm-chat.md` §7 | 补「首屏初始化」机制说明（main.tsx 入口 await initThemeFromConfig），引用 design_system §2.1 为 hex 权威源 |
| `specs/api/overall/02-llm-chat.md` §5.1 / §5.4 | 补 provider DELETE tombstone 实现说明 + credentials 脱敏确认（实现一致） |

### 文件清单（v0.0.3 实现 A 状态文件 — 合并时零容忍核对）

```
app/server/src/config/                       (T1: schema_defs + service + index)
app/server/src/plugin/                       (T2: extension-point/registry/plugin-manager/builtin-loader/plugin-config-service/policy-store/index)
app/server/src/llm/                          (T3: provider/protocol/client/resolve-provider-config 等)
app/server/src/handlers/                     (T4: chat/config/provider + sse-writer/mock-llm/llm-client-factory)
app/plugins/builtins/llm_anthropic/          (T7: plugin.json + provider.ts + protocol.ts)
app/web/src/components/AppShell.tsx          (T5)
app/web/src/components/chat/                 (T5: ChatPage/MessageBubble/ModelPicker)
app/web/src/components/settings/             (T6: AppSettingsPage/PluginSettingsPage/DevSettingsPage + ProviderForm/ModelForm)
app/web/src/store/{view,chat}-store.ts       (T5)
app/web/src/lib/{sse-client,api-base,theme-init}.ts  (T5+T6+BUG-001)
app/web/src/styles/tokens.css                (T5: data-theme dark/light 两套变量集)
```
