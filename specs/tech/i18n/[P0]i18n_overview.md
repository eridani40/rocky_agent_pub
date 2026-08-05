---
type: spec
title: i18n 基础设施 P0（中英双语）
priority: P0
status: active
updated: 2026-07-08
since: v0.0.59
related: [[P0]app_config.md, ../../api/overall/02-llm-chat.md, ../../app/frontend/[P0]tech_stack.md]
---

# i18n 基础设施 P0（中英双语）

## 1. 概述

**管什么**：i18n 机制层——KKV 占位符协议、locale bundle 物理结构 + key 命名、react-i18next 集成（init / useTranslation / changeLanguage）、locale 开关链路、type-vs-dynamic 渲染判定、displayReason 后端范式样板。
**不管什么**：具体页面文本迁移（→ Batch 2 后续版本）；配置体系逐项 i18n 清单（→ PRD S6 梳理产物）；后端产生本地化文案（→ 后续版本预留）；LLM prompt / 用户数据 / 自由文本（→ 硬边界 §2）。
总览见 `[index.md`](index.md)。

本版本（v0.0.59）= **基础设施 + 梳理清单 + displayReason 范式样板**。前端任何硬编码文本可经 `t(key)` 替换为当前语言；切换 locale 立即生效；缺翻译走兜底链；缺 key 开发期报错。页面级迁移走 Batch 2（不在本版本）。

## 2. 范围与硬边界

### 2.1 IN-SCOPE（i18n 候选 — UI 上能看到 → i18n）

- **前端静态 UI**：按钮 / 标题 / placeholder / tab / tooltip / 菜单 / 副标题 / aria-label / 表单 label
- **后端产生但显示在 UI 的可枚举 type 字段**：displayReason category（LlmErrorCategory）、finish_reason 等 → 后端发 type code、前端按 locale 查表

### 2.2 OUT-OF-SCOPE（硬边界 — 不翻译，原样直展）

| 类别 | 字段 |
|---|---|
| **LLM 向内容** | system / agent prompt、用户输入、LLM 回复正文 |
| **用户数据**（字面数据） | squad name/desc/charter、member name、session title、provider/model label、board 工作项、user_memory、用户自建 skill |
| **动态自由文本** | error_message（厂商/模型原始返回，无法提前枚举，类同模型输出） |
| **迁移范围** | 其余前端页面、HTTP 错误体 i18n、内置 plugin.json label 等 → Batch 2 / 后续版本 |

> 一刀切原则：**UI 上能看到 → i18n**；逐元素按此判定，不再分类纠结（PRD §2.1 划分线）。

## 3. KKV 占位符协议（四规则）

**KKV** = key × language → value。前端渲染一段文本时按以下四规则顺序判定（req §核心机制锁定）：

| 规则 | 输入 | 输出 | 用例 |
|---|---|---|---|
| **(1) 字面文本** | 字符串是非占位符（用户数据、动态自由文本、LLM 回复） | **直接展示**，不查表 | squad name=`"我的团队"`、error_message=`"rate limit exceeded"` |
| **(2) 占位符 key** | 字符串是 i18n key（`<ns>.<scope>.<leaf>` 形态，由前端硬编码调用 `t(key)`） | 按 `lng` 查 KKV 翻译后展示 | `t('chat.sendButton')` → 当前 zh-CN 查得「发送」/ en 查得 "Send" |
| **(3) 当前语言缺翻译** | key 在当前 lng 的 bundle 中不存在 | 按 **当前 → en → zh-CN** 顺序兜底（始终有文本可见） | `chat.foo` zh-CN 缺、en 有 → 显示 en 文本 |
| **(4) 三级全缺** | key 在所有 lng 的 bundle 中都不存在 | **开发期报错**「资源 xxx 不存在」+ 渲染位置占位提示 | console.error + 红字 `【资源 chat.foo 不存在】` |

**判定要点**：
- 字面 vs 占位符的**判定责任在调用方**——前端组件硬编码调用 `t(key)` 即声明「这是占位符」；后端返回的字段（如 squad.name）由前端组件决定走哪条（用户数据 → 直展；type 字段 → 查表）。
- **「后端返回 i18n key」分两类**（v0.0.62 修订，原「后端永远不直接返回 i18n key 字符串」过于绝对）：
  - ❌ **运行时动态数据不当 key**（保留禁令本意）：用户数据 / LLM 输出 / squad.name / 动态自由文本（error_message 等）—— 原样直展不当 key（避免「key 漏迁移 + 显示 raw key」事故，原禁令本意）。
  - ✅ **产品代码声明占位符 key 允许**（放开）：manifest 等产品代码静态字段（builtin plugin 的 `label` / `description` / `extImpls[].description` / `schemaConfig.<key>.description`）可用 `__MSG_<key>__` 占位符声明 i18n —— 与前端组件里写 `t('chat.sendButton')` 同质（都是产品代码声明 i18n key），仅载体不同（JSON vs TSX）。详见 `[P1]manifest_i18n.md`。
- 规则 (4) 面向开发者抓漏迁移 key，不面向终端用户；生产构建仍保留报错（不做 silent fallback）。

> **manifest 等产品代码静态字段的占位符协议（`__MSG_<key>__` 语法 + 适用范围 / 不适用 / 字段格式不变 / 后端零改 / 单一数据源 / 新增 ext impl 强制同步）+ `resolveI18nField` helper 契约（签名 / 逻辑 / missing key 不 fallback / 通用性 / 落点 / UT 覆盖）详见 `[P1]manifest_i18n.md`**（v0.0.62+，本 §3 KKV 基础协议在 manifest 场景的扩展协议，业界标准 WebExtension `__MSG_` + react-i18next「backend returns keys」对齐）。

## 4. locale bundle 物理结构 + 命名空间拆分

### 4.1 物理结构

```
app/web/src/i18n/locales/
├── zh-CN/
│   ├── chat.json              # chat-page + chat 组件文本
│   ├── studio.json            # studio-page 文本
│   ├── providers.json         # providers 三级流文本
│   ├── plugin-config.json     # plugin-config-page 两 tab 文本
│   ├── app-dev-config.json    # app + dev config 三栏文本
│   ├── skill.json             # skill-page 文本
│   ├── connector.json         # connector-page 文本
│   ├── framework.json         # nav-rail / app-shell 等框架级文本
│   ├── common.json            # 跨 page 复用（确认/取消/保存/删除等通用词）
│   └── error.json             # 后端 type 映射：error.llm.<LlmErrorCategory> × 19
└── en/                        # 同结构同 key 集合
    └── (同 10 个 ns 文件)
```

- **物理形态**：build-time **静态 import**（不懒加载，PRD §5 决策）；i18next `resources` 直接吃 JSON 对象。
- **ns 名 = 一级 page 目录名**（对齐 `app/web/src/components/` 一级目录 + `specs/ui/components/` 一级目录），见 `_conventions.md §4`。
- **defaultNS = `'common'`**（跨 page 复用文本默认从这里查）。
- **error.json 独立 ns**：承载后端 type 字段映射（首版覆盖 `error.llm.*` **18 个** LlmErrorCategory leaf，对齐 `app/server/src/llm/caller/display_reason.ts` 的 `DISPLAY_REASON_TABLE` 18 行一一对应——历史 spec 误写「17 行 + rev2 新增 2 个 = 19」，实际表内 `MAX_TOKENS_TOO_HIGH` 只出现一次，总数为 18）。

### 4.2 key 命名规范

- **形态**：`<ns>.<scope>.<leaf>` —— dot.notation + camelCase leaf（嵌套对象）。
- **示例**：
  - `chat.sendButton` / `chat.inputPlaceholder` / `chat.tools.ariaLabel`
  - `error.llm.authInvalid` / `error.llm.rateLimited`（leaf = LlmErrorCategory 枚举值的 camelCase 形态）
  - `common.confirm` / `common.cancel` / `common.save`
  - `appDevConfig.appearance.theme.light`
- **不用 snake_case**（与 JS 标识符不一致）；不用 kebab-case（与 i18next 嵌套对象不兼容）。
- **leaf 命名**：表达**语义**不表达位置（`sendButton` 而非 `bottomRightButton`）。

### 4.3 占位符插值

- react-i18next `interpolation` 默认 `{{name}}` 语法（如 `t('chat.welcome', { name: 'Alice' })` → bundle `"welcome": "你好 {{name}}"`）。
- `escapeValue: false`（React 已转义，避免双重转义）。

## 5. react-i18next 集成

### 5.1 init 配置（`app/web/src/i18n/index.ts`）

```typescript
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhCN_common from './locales/zh-CN/common.json';
// ... 其余 9 ns × 2 lng 静态 import

export const initI18n = (lng: 'zh-CN' | 'en') =>
  i18n.use(initReactI18next).init({
    resources: {
      'zh-CN': { common: zhCN_common, /* ... */ },
      'en':    { common: en_common,    /* ... */ },
    },
    lng,                                  // 启动期从 app_config locale.language 读
    fallbackLng: ['en', 'zh-CN'],         // §3 规则 (3) 兜底链 当前→en→zh-CN
    defaultNS: 'common',
    ns: ['common'],                       // 默认仅加载 common；各组件按需 useTranslation(ns)
    interpolation: { escapeValue: false },
    parseMissingKeyHandler: (key) =>      // §3 规则 (4) 缺 key 报错
      `【资源 ${key} 不存在】`,
    saveMissing: true,                    // 开发期触发 parseMissingKeyHandler
    react: { useSuspense: false },        // 启动期已 await init，不需要 Suspense
  });
```

### 5.2 启动期 init 链路（`app/web/src/lib/locale-init.ts`，对齐 theme-init BUG-001 范式）

```typescript
// main.tsx：在任何 React 渲染前 await（避免首屏闪烁/回退）
async function main() {
  await initThemeFromConfig();           // 已存在
  await initI18nFromConfig();            // 本版本新增
  createRoot(rootEl).render(
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  );
}
```

- `initI18nFromConfig()`：GET `/config/app?group=appearance&key=language`（**v0.0.89 改 group 名**：原 `locale` group 已合并入 `appearance`）→ `initI18n(lng ?? 'zh-CN')` + 设 `document.documentElement.lang = lng`（无障碍）；GET 失败 fallback `zh-CN`，永不抛错（对齐 theme-init 范式）。

### 5.3 useTranslation（组件侧）

```typescript
// 在组件内按需声明 ns
const { t } = useTranslation('chat');
return <button>{t('sendButton')}</button>;     // → "发送" / "Send"
```

- **多 ns 与跨 ns 取值**（**react-i18next v15 数组 ns 不自动跨 ns fallback**）：
  - `useTranslation(['chat', 'common'])` 仅声明「同时加载这两个 ns 到 t 查找上下文」，**不**意味着「chat key 缺失时自动去 common 查」——i18next 默认数组 ns 各 ns 独立，缺 key 不跨 ns 兜底（需 init 配 `fallbackNS: 'common'` 才会自动跨 ns；本版本 T1 未设此项）。
  - **跨 ns 取值用显式 ns**：`t(key, { ns: 'common' })` 或 namespace 前缀 `t('common:confirm')`。
  - **同 ns 内多 ns 加载场景**（如组件渲染同时用 chat + common 文本）：`const { t } = useTranslation(['chat', 'common']); t('chat.sendButton'); t('common:confirm');`（每条 t 显式指定 ns）。
  - **`fallbackNS` 列为后续优化项**：本版本保持显式 ns 取值（清晰可控）；如未来发现重复样板代码，再考虑 init 加 `fallbackNS: 'common'`（届时需更新本节 + §5.1 init 配置示例）。
- **type 映射查表**：见 §6。

### 5.4 changeLanguage（实时切换 + 持久化 — v0.0.89 改 appearance group read-modify-write）

```typescript
// 用户在设置页切语言时调用
async function changeLanguage(lng: 'zh-CN' | 'en') {
  await i18n.changeLanguage(lng);                    // 实时切，不刷新
  document.documentElement.lang = lng;
  // v0.0.89: locale group 合并入 appearance（含 theme + language 两 key）
  // read-modify-write: 先 GET appearance 整组 → 改 language → PUT 整组（含 theme 避免覆盖）
  const existing = await fetch('/config/app?group=appearance').then(r => r.json());
  const items = existing.items ?? [];
  const others = items.filter(it => it.key !== 'language');
  await fetch('/config/app', {
    method: 'PUT',
    body: JSON.stringify({
      group: 'appearance',
      items: [...others, { key: 'language', data: lng }]
    })
  });
}
```

- 切换实时生效（react-i18next 内部触发组件重渲染，无需刷新）。
- 持久化走 `PUT /config/app?group=appearance` **整组提交**（含 `theme` + `language` 两 key，read-modify-write 避免覆盖 theme；**v0.0.89 group 名从 `locale` 改 `appearance`**——locale group 已废弃合并入 appearance）。
- **切即生效保持**（不走 page-tab 级 dirty）：`component-locale-card` onChange 直接调 `changeLanguage`（不进 page-tab save-bar 流，design-brief §1.2 硬约束）；与 theme 切换同款「切即生效」语义。

## 6. locale 开关链路 + 后端是否需要 locale（结论）

**链路**（**v0.0.89 group 名改 `appearance`**：原 `locale` group 已合并入 `appearance.language`）：`app_config.appearance.language` → `initI18nFromConfig()` 启动期读取 → i18next `lng` + `document.documentElement.lang`；切换经 `changeLanguage(lng)` → 实时切 + 持久化 PUT（read-modify-write 含 theme）。

**后端是否需要 locale —— 结论：本版本不需要**。理由：

| 字段类别 | 本版本处理 | 后端是否需 locale |
|---|---|---|
| **可枚举 type**（displayReason category 等） | 后端发 code（`errorCategory: 'AUTH_INVALID'`），前端按 locale 查 `error.llm.authInvalid` 表 | ❌ 不需要（后端只发 code） |
| **用户数据**（squad name / session title / provider label / user_memory） | 原样直展（用户字面数据，不翻译） | ❌ 不需要（后端只发数据） |
| **自由文本**（error_message / LLM 回复） | 原样直展（无法提前枚举，类同模型输出） | ❌ 不需要（后端只发原文） |
| **后端产生本地化文案**（HTTP 错误体 + localized message、内置 plugin.json label） | **本版本不做**（PRD §2.2 OUT-OF-SCOPE，后续版本） | ⚠️ 未来扩展点（HTTP `Accept-Language` header 或 body 字段） |

**「一个开关驱动三件事」**（PRD §3.1）：本版本只驱动第 1 件（前端 t() 查表）；第 2 件（后端按 locale 选 UI 文案）= 未来扩展；第 3 件（LLM 输出语言引导）= 仅开关语义预留（不实现）。**后端 locale 链路（HTTP request 怎么传 locale、server 怎么读到）本版本不实现**。

## 7. type 字段 vs 动态文本处理（核心判定流程）

前端组件渲染一个后端字段时按以下流程判定：

```
renderBackendField(field):
  ┌─ field 是可枚举 type? (errorCategory / finish_reason / step_kind 等)
  │   YES → t(`<ns>.<leaf-of-code>`)  查 locale 表
  │         例：errorCategory='AUTH_INVALID' → t('error.llm.authInvalid')
  │              finish_reason='length'      → t('chat.finish.length')
  │         查到 → 展示本地化文案
  │         查不到 → 走 §3 兜底链 / §3 规则 (4) 报错
  │
  └─ field 是自由文本? (error_message / squad.name / session.title / LLM 回复)
      YES → 原样展示 field 值，不进 i18n
            （用户数据 + 模型输出，不翻译，硬边界 §2.2）
```

**判定责任**：前端组件**按字段名**显式分支（`field === 'errorCategory'` 走 type 路径，`field === 'errorMessage'` 走直展路径）。**不靠字符串启发式**（如「以大写字母+下划线判定 type」不可靠）。

**首批覆盖的 type 字段**：
- `errorCategory`（LlmErrorCategory, 18 值）→ `error.llm.<camelCase>` × 18 keys（对齐 `display_reason.ts` 的 `DISPLAY_REASON_TABLE` 18 行一一对应）。
- `finish_reason` / `step_kind` 等 → Batch 2 覆盖。

## 8. displayReason 后端范式样板契约（零 API breakage）

**契约不变**（`specs/api/overall/02-llm-chat.md` v0.0.25 rev2 已锁）：

```typescript
RunErrorInfo = { errorCategory: LlmErrorCategory; displayReason: string; errorDetail?: string }
```

| 字段 | 后端行为（v0.0.59 不变） | 前端行为（v0.0.59 启用 i18n 后） |
|---|---|---|
| `errorCategory` | 后端发枚举值 code（如 `'AUTH_INVALID'`） | **优先** `t('error.llm.' + camelCase(errorCategory))` 查 locale 表 |
| `displayReason` | 后端继续发 zh-CN 兜底文案（`deriveDisplayReason()` 函数不变） | locale 表查到 → 用本地化文案；查不到 → **回退**用此字段值（zh-CN 兜底） |
| `errorDetail` | 后端发 raw provider message（debug tooltip 用） | 原样直展（不 i18n，属自由文本） |

**优势**：
- **零 API breakage**——旧 caller 直接读 `displayReason` 仍工作（zh-CN 兜底文案）。
- **前端 i18n 是纯前端行为**——后端透明，无需感知 locale。
- **后端 `display_reason.ts` 不动**——`deriveDisplayReason` 函数 + `DISPLAY_REASON_TABLE` 保持现状（仍作 zh-CN 兜底 + 兜底文案来源）。

**前端 error.json（zh-CN / en）覆盖 18 个 LlmErrorCategory leaf**（leaf = 枚举值的 camelCase 形态）：

```json
{
  "llm": {
    "authInvalid": "认证失败，请检查 API Key",
    "authForbidden": "API Key 无权限或地域受限",
    "rateLimited": "模型限流，请稍后重试",
    "providerOverloaded": "服务商过载，请稍后重试",
    "serverError": "服务商内部错误",
    "network": "网络错误，请检查网络连接",
    "streamIncomplete": "响应流中断",
    "emptyResponse": "模型返回空响应",
    "maxTokensTooHigh": "输出长度超限（请求参数越界）",
    "timeoutFirstChunk": "响应超时",
    "timeoutInterChunk": "响应超时",
    "contextLengthExceeded": "上下文过长且压缩失败",
    "maxTokensExceeded": "输出达到模型上限",
    "contentFiltered": "内容被审核拒绝",
    "modelNotFound": "模型不存在或未配置",
    "malformedToolCall": "模型工具调用格式错误",
    "badRequestOther": "请求参数错误",
    "abortedByUser": "用户已中断"
  }
}
```

> 18 行映射来自 `app/server/src/llm/caller/display_reason.ts` 的 `DISPLAY_REASON_TABLE`（代码实测 18 行，**不是 19**——历史 spec 误记为「17 + rev2 新增 2 = 19」，实际表中 `MAX_TOKENS_TOO_HIGH` 只出现一次，总数 18）。zh-CN 文案**与后端兜底表一致**（保证「回退 displayReason 字段」时与「locale 表查到」无视觉差异）；en 文案为新增翻译。前端 `app/web/src/i18n/locales/{zh-CN,en}/error.json` 各 18 leaf 一一对应。

## 9. 设置页语言选择器（UI 契约摘要）

> 详细 UI 契约见 `specs/ui/overall/03-config-center.md` v0.0.59 段；此处仅给 e2e designer 用的最小契约。

- **挂载点**：app config 页（v0.0.47 合并页 `<PageAppSettingsMerged>`，根 testid = `page-app-settings`——**不是** `page-app-config`，对齐 `specs/ui/overall/03-config-center.md §2.2 [v0.0.59 corrected]`）三栏布局的 `locale` group（已预留 §3.3）。
- **控件**：`primitive-key-choice-cards`（两选项卡，禁原生 select per `_conventions §10`）。
- **testid**：
  - 卡片容器：`key-card-locale-language`
  - 控件容器：`key-card-locale-language-input`
  - 选项：`key-card-locale-language-zh-CN` / `key-card-locale-language-en`
- **行为**：onChange 立即 `changeLanguage(lng)`（实时切 + PUT 持久化），同 appearance.theme 模式（切即生效，不进 group save-bar）。
- **选项 label 本地化展示**：「中文」/「English」（zh-CN 下）/「中文」/「English」（en 下，中文选项始终显示「中文」自指）。

## 10. 文件变更清单（planner/coder 依据）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/web/package.json` | 修改 | 新增 `i18next` + `react-i18next` dependencies |
| `app/web/src/i18n/index.ts` | 新增 | i18next instance + `initI18n(lng)` + 导出 instance 供 I18nextProvider |
| `app/web/src/i18n/change-language.ts` | 新增 | `changeLanguage(lng)`：实时切 + `<html lang>` + PUT 持久化（spec §5.4） |
| `app/web/src/i18n/llm-error-category.ts` | 新增 | `camelCaseCategory()` SCREAMING_SNAKE→camelCase + `localizedDisplayReason()` 查表回退（spec §7/§8 helper，供 chat 组件消费） |
| `app/web/src/i18n/locales/zh-CN/*.json` | 新增 | 10 ns 文件（common/error 实质覆盖；其他 8 ns 起骨架，留待 Batch 2 填充） |
| `app/web/src/i18n/locales/en/*.json` | 新增 | 10 ns 文件（同上） |
| `app/web/src/lib/locale-init.ts` | 新增 | `initI18nFromConfig()`：GET /config/app?group=locale → initI18n(lng)；对齐 `theme-init.ts` 范式 |
| `app/web/src/main.tsx` | 修改 | main() 加 `await initI18nFromConfig()`；createRoot 包 `<I18nextProvider>` |
| `app/web/src/components/app-dev-config-page/component-locale-card.tsx` | 新增 | locale group 的语言选择器卡片（`primitive-key-choice-cards` 范式，testid 按 `03-config-center.md §2.3a`）；onChange 调 `changeLanguage` |
| `app/web/src/components/chat/*`（displayReason 渲染处） | 修改 | displayReason 渲染：从「直展 displayReason 字段」→「优先 `localizedDisplayReason(errorCategory, displayReason, t)`（内部 `t('error.llm.' + camelCase(errorCategory))` 查 locale 表，查不到回退 displayReason 字段）」 |
| `app/server/src/llm/caller/display_reason.ts` | **不改** | 后端兜底表保持现状（zh-CN 文案与前端 error.json zh-CN 一致；作向后兼容兜底） |

> **首批迁移范围（PRD §6 Batch 2）**：chat-page / studio-page / providers 实际文本迁移不在本版本；本版本仅基础设施 + displayReason 范式样板 + 设置页选择器。**v0.0.62 已落地 Batch 2 全量迁移（9 ns × ~580 leaf 填实 + 6 task verified + AT 6/6=100%）**——见 `log.md` v0.0.62 条目。

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
