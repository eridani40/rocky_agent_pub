# PRD Change Log — v0.0.7

> 版本：v0.0.7 · 日期：2026-06-20
> 增量记录 v0.0.7 相对 v0.0.5 引入的产品需求变更。
> 全量产品定义见 `specs/prd/overall/`。
> v0.0.7 是 **provider/model config 页面重做 + provider 对象设计修正**：不新增功能域，重做 app config providers group 的交互模型，并修正 v0.0.6 误把 provider 配置挂到 ext impl schemaConfig 的设计错误。

## 摘要

v0.0.7 在 PRD 层做 **2 项变更**（落实 `states/v0.0.7/user_query.md` Part 1 + Part 2）：

1. **providers group 三级流 + 唯一保存 + diff-save**：app config 页 providers group 配置区从「扁平 provider 列表 + 内联展开 model」重做为 `list（provider 卡 + 添加提供商虚线卡）→ provider 二级页（连接配置 + 关联 model 列表 + save-bar）→ model 弹层（确定/取消）`。**唯一保存按钮在二级页**（testid `provider-save`），保存 = 前端 UI 算 draft/snapshot diff → 逐条调 `/provider` + `/provider/:id/model` CRUD。后端端点不变（见 `api/overall/02-llm-chat.md` §5）。
2. **provider 对象设计修正（Part 2）**：澄清 provider = 行为（ext impl）+ config 对象（app_config providers group 实例）。ext impl **不带 config**（v0.0.6 给 `anthropic_compatible` 加 schemaConfig 是错的 → 移除）。provider 配置只在 app config 的 provider 实例上。

## 数据模型扩展

### ModelInstance [v0.0.7] += label / enabled

```typescript
interface ModelInstance {
  modelId: string;
  protocolId: "anthropic_messages";
  contextWindow: number;
  maxOutputTokens: number;
  default?: boolean;
  label: string;      // [v0.0.7] 显示名（区分同 provider 下多个 model）；POST 缺省 = modelId
  enabled: boolean;   // [v0.0.7] 启停（关闭后在 chat 模型选择器隐藏）；POST 缺省 = true
}
```

### ProviderInstance（不变）

`{ id, name:'anthropic_compatible', label, baseUrl, credentials:{key}, enabled, models: ModelInstance[] }`。v0.0.7 新增可用端点：`PUT /provider/:id`（改 label/baseUrl/enabled/apiKey，见 `api/overall/02-llm-chat.md` §5.1）。

## 文档修订（overall 就地更新）

| 文件 | 修订内容 | 标注 |
|------|---------|------|
| `specs/prd/overall/04-config-center-ui.md` §3.9.2 | providers group 配置区说明补「v0.0.7 重做三级流」指引，指向 §3.9.7 | `[v0.0.7 modified]` |
| `specs/prd/overall/04-config-center-ui.md` §3.9.7（新增） | 新增「providers group 三级流 + diff-save」章节：设计原则 5 条 + 5 条用户路径（UC-3.9.7.1~5）+ ModelInstance 字段扩展说明 | `[v0.0.7]` |
| `specs/prd/overall/04-config-center-ui.md` 目录 + 版本块 | 目录补 §3.9.7 条目；版本 1.0 → 1.1 | `[v0.0.7 modified]` |

## 关键用户路径（v0.0.7 新增，MANDATORY — 测试最低覆盖）

| 路径 | 链路 | 关键断言 |
|------|------|---------|
| 添加 provider + model | 「添加提供商」→ 二级页填字段 → 添加 model 弹层确定 → 保存 | POST /provider + POST /provider/:id/model；保存后入列表 |
| 编辑 provider/model diff-save | 进二级页 → 改 label + 改 model 字段 + 删 model → 保存 | diff：PUT /provider/:id + PUT model + DELETE model；reload 反映最新 |
| 未保存返回丢弃草稿 | 改字段不保存 → 返回 list | draft 丢弃；list 显示原值 |
| dirty 指示 | 改字段 → 显「●」→ 保存 → 显「✓」 | dirty 状态反映 draft/snapshot diff |

## 范围边界（v0.0.7 PRD 层）

### IN SCOPE

1. providers group 三级流（list → detail → modal）+ 唯一保存 + diff-save。
2. ModelInstance += label / enabled。
3. provider 对象设计澄清（ext impl 不带 config，v0.0.6 schemaConfig 移除）。

### OUT OF SCOPE

- 后端 `/provider` `/provider/:id/model` 端点路径/方法/错误码（v0.0.7 完全不变，仅 PUT 落地实现 + body 扩展字段）。
- chat 链路、其他 config group（appearance / dev / plugin）。
- 旧 `ProvidersSection/ProviderForm/ModelForm.tsx` 删除（归 coder 实施）。

## 版本

version: 1.0
