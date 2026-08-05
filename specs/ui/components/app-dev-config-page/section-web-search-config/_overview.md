# section-web-search-config（应用设置 → 网络搜索 自渲染 section）

> 层级: section
> 本文是「网络搜索」section 的**概念权威源**：标题区 + type 选择控件 + 动态 credentials 字段 + saveMode + testid 命名。

## 1. 概念定位
网络搜索是 **app config 页内的一个自渲染 group**：
- 普通 group（appearance/logs）：`section-config-layout` 右侧渲染 KV key-card 网格。
- **web_search group**：type 选择控件（下拉选择框自 choice-cards）+ 选中 impl 时动态展示对应 credentials 字段；由本 section 整组 GET → 草稿态编辑 → 整组 PUT 提交。

## 2. 数据模型（UI 侧契约）
- record 缺失 / `type` 缺失 → UI 草稿态 `type = ""`（空选中）+ `credentials = {}`；保存按钮禁用直到选 type。
- 单实例（`key="default"`），全局一份。

## 视觉基线
参考  / `user-memory` 主流自渲染 section 范式：
- section 容器：（外层不另加 padding，左边缘统一对齐父 `config-area` 的 ）。
- 顶部标题区：纯 `<div>` 包裹，无 、无 ，
  靠父  与下方内容隔开。
