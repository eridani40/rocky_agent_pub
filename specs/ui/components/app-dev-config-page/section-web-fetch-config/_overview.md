# section-web-fetch-config（应用设置 → 工具 tab → 网络抓取 自渲染 section）

> 层级: section
> `specs/api/overall/08-web-tools.md §5`（app_config web group 契约 + jinaApiKey redact/merge）

## 1. 概念定位
网络抓取是 **tools tab 内的一个自渲染 section**，与「网络搜索」section 同 tab，紧邻其下方。
仅暴露 jinaApiKey 一个字段（jinaEnabled / jinaTimeoutMs 不做 UI，范围纪律）。
- GET `/config/app?group=web`：整组响应 items[]；jinaApiKey 后端 redact 为 `"***"`；从未配过则响应不含该条目（返空）。
- PUT：用**单 key PUT** `{group:'web', key:'jinaApiKey', data:'...'}`（安全：不会误覆盖同组的 jinaEnabled/jinaTimeoutMs）。

## 2. 数据模型（UI 侧契约）
- 记录缺失（从未配过）→ baseline = `''`（空）。
- 后端 GET 返 `'***'` → baseline = `'***'`（展示为 mask）。
- PUT `{group:'web', key:'jinaApiKey', data}` 单 key 提交：data = `'***'`（未改）→ 后端保留原值；data = 真值 → 落盘。

## 视觉基线
参照 section-web-search-config 同款规格：
- section 容器：（左边缘对齐父 config-area py-6 px-8，不另加 padding）。
