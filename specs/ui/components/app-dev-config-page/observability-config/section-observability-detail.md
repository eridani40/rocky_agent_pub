# section-observability-detail

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/observability-config/section-observability-detail.tsx
> 视觉契约: reqs/v0.0.11/easy-opc-config-v10.html L476-553（ObsDetailEditor）+ reqs/v0.0.11/detail.png

## 职责
可观测性详情/编辑视图：breadcrumb + 头部（logo + 名称 + type + 启停）+「基础信息」section（name + type + baseUrl）+「认证密钥(仅本地)」section（publicKey + secretKey）+「物理层记录」section（logPhysical toggle）+ dirty 提示条。支持新增与编辑两种模式。
**dirty 判定（v0.0.317 D9）**：所有字段（含 enabled toggle）攒入 draft，计入 dirty；save/reset 移到 tab 级 aggregator（`useTabDirtyAggregator`），detail 只保留 dirty 指示条。
**数据源**：REST CRUD 无 SSE——draft 仅前端持有，通过 `onDraftChange` 上推父级攒入 tab 级 dirty，点 tab 级 SaveBar 保存时由父级合并整 list 后 `PUT /config/app`。
边界：不管列表（→ list）；enabled toggle 不再即时生效（v0.0.317 D9 改为攒 draft）。

## Props
- initialData: ObservabilityConfig;  // 新增时由父级构造空壳 {name:'',type:'langfuse',...}
- isNew: boolean
- onBack: () => void;                                    // 返回 list
- onDraftChange: (data: ObservabilityConfig) => void;    // draft 变化上推父级（v0.0.317 替代 onSave/onToggle）

## 状态 / 交互
- `draft: ObservabilityConfig`（受控编辑副本），初始 = initialData。
- `saved: ObservabilityConfig`（已保存基线），初始 = initialData。
- `dirty = isObservabilityDirty(draft, saved)`——enabled 计入 dirty（v0.0.317 D9）。
- 头部 toggle：`updateField('enabled', next)` → 仅更新 draft（计入 dirty，tab 级统一保存）；新增态禁用（无 id，先保存）。
- 字段更新（name/type/baseUrl/publicKey/secretKey/logPhysical）：`updateField` → `setDraft` + `onDraftChange(next)` 通知父级攒 draft。
- dirty 提示条（底部）：dirty 时显 dirtyHint 文案，非 dirty 时显 savedHint 文案。
- breadcrumb：「可观测性 / {name 或 新建配置}」；点「可观测性」→ `onBack`。
### name/type 竖排（用户决策②，MANDATORY，对设计稿差异）
设计稿 `f-row-inline`（横排一行两栏）→ **本 spec 改为竖排**：name 与 type 各占一整行 `f-row`，两行独立 full-width input。type input `disabled`，值固定 `langfuse`。

## 复用关系
- 被组合：`section-config-layout`（dev config 页 observability group → detail 视图）
- 复用 primitive：toggle、text input（直接 `f-input` 类 / `pr
