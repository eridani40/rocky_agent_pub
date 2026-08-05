# v0.0.18 PRD 变更日志

## 概述

**bugfix 版本**（无新 PRD 路径，需求来自 `reqs/v0.0.18/bugs.md`）。修复 v0.0.5–v0.0.17 长期存在的 plugin 排序双语义裂缝 + ordered 扩展点拖拽「只写一条」bug，并补三级 description 提升 ext point / impl 的可发现性。

一句话：**让 ordered 扩展点拖拽真正生效（刷新顺序不变）+ 用户在配置页能看懂每个扩展点 / impl 干什么。**

权威输入：`reqs/v0.0.18/bugs.md`。spec 权威源：`specs/tech/plugin_system/[P0]*.md`（删 ExtImpl.priority / effective order / exclusive 新机制）+ `specs/tech/config/[P0]*.md`（setPointOrders 批量 op）+ `specs/ui/components/plugin-config-page/`（组件 spec）。

---

## 1. PRD 层面变更

### 1.1 ordered 扩展点拖拽持久化语义（`04-config-center-ui.md` §3.9.4 + 路径 5）

- **旧（v0.0.5–v0.0.17）**：拖动后前端发单条 `setOrder(implId, order)`，存在三个 bug（闭包旧 state、取错被拖项、只写一条 record 导致 order 冲突）——结果「拖了不生效 / 刷新顺序乱」。
- **新（v0.0.18）**：拖动后前端**整个 ext point 组一起**发 `setPointOrders(pointId, orders[])` 批量 op（全量替换 + 清旧 record + 原子），落盘后**刷新页面顺序不变**（GET 返回 effective order 与拖动后一致）。
- 关键断言扩展：order 变更不改 enabled；enabled 变更不改 order；**刷新后顺序稳定**（新增）。

### 1.2 三级 description 呈现（`04-config-center-ui.md` §3.9.4）

- **EP header**：扩展点标题区显示 `pointDescription`（来自 `ExtensionPoint.description`，代码硬编码，缺省空串不渲染）。
- **impl 行**：implId 主标题下副文本显示该 impl 的 `description`（来自 `ExtImpl.description`，代码硬编码，缺省空串不渲染）；适用 exclusive / list / ordered 三种 impl 组件。
- plugin 级 description（`plugins[].description`）v0.0.5 已有，不动。

> description 是**代码定义属性**（plugin / ext point / ext impl 三级），不进 plugin_policy 配置；inventory 透传给 UI 只读呈现，用户不能改。

---

## 2. 用户路径影响

无新路径。**路径 5（ordered 扩展点拖拽 + 独立开关）** 补充断言：拖动后整组批量持久化 + 刷新顺序不变 + EP header / impl 行展示 description。

---

## 3. 不在范围

| 排除项 | 理由 |
|--------|------|
| multi-point 批量 setOrders | 决策 4「甚至可多个 point 一起」的多 point 版本留 follow-up，单 point 已足够修 bug |
| exclusive 内置 EP | P0 无 exclusive 内置 EP（grep 确认），新机制是契约准备，运行时影响为零 |
| 新 PRD 路径 | 本版本为 bugfix，无新功能路径 |
