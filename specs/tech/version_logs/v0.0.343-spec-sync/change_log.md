---
type: change_log
title: v0.0.343 — spec↔code 同步审计 + 补同步修复
version: v0.0.343
date: 2026-08-13
related_reports: reports/spec-code-audit-300s-partA.md, reports/spec-code-audit-300s-partB.md
grounded: 老板 08-12 23:43 审计指令 + 08-13 09:22 修复拍板 + 双 doc-modifier 并行修复汇报
---

# v0.0.343 — spec↔code 同步审计 + 补同步修复

> 一句话：**逐版本审计 v0.0.300–342 全部版本日志的 spec↔code 同步度，拍板修复 30 项偏差，纯文档修正，src/ 零触碰。**

## 1. 背景

老板 08-12 23:43 要求审计 v0.0.300 起 spec 与代码的同步状况；08-13 09:22 拍板「修」。审计分 A（v301–323，doc-modifier）/ B（v324–342，doc-modifier2）两线并行。

## 2. 审计结果概要（30 个版本）

- 逐版本读 change_log/change_plan → 找对应 spec → grep 生产代码核实（渲染树/装配引用，非仅文件存在）。
- **30 项偏差**：PartA 13 项 + PartB 17 项。
- **spec 超前仅 2 处**，均为「引退役物」（退役组件 spec 已带 DEPRECATED 标记、消费方引用已清），**零凭空功能**。
- 成因集中在两类：编码期实现偏差缺 change_log（301/302/309/310 等只有 change_plan）；spec 更新滞后（316/317 SaveBar 统一、324-330 UI 重构）。

## 3. 修复内容（纯文档，src 零触碰）

**PartA 13 项（commit `1a9512572`，doc-modifier）**：301 avatar null→invisible 包裹偏离补记；302 KvConfigService 读缓存 + tailCache 零读 append；309 readSet 快照传入；310 ViewElement 第 4 kind + batch 断裂；316 三个工具 section 受控化 + section-bash-config 新建 spec；317 SaveBar 四处（member-panel / channel-form / provider-detail / SectionLogsConfig 新建 spec）；319 [P1]team_sync.md 服务层 spec 新建入 squad KB。

**PartB 17 项（commit `cc507835c`，doc-modifier2）**：324 文件树搜索裁剪树 + 搜索上限 100；325 只读态浏览器打开按钮；326 usage 环重构（36 环 + 百分比 + head 按钮 + 单门控）；327 搜索树 merge-expanded；328 getFileFormat 白名单；330 cleanup-chrome-debug.sh 契约；334.fix attach 即时清账 + userDataDir 候选注入 + change_log 补建。

## 4. 产出物

- 审计报告：`reports/spec-code-audit-300s-partA.md` + `reports/spec-code-audit-300s-partB.md`（偏差明细表 + 同步良好版本核对，均已入库）。
- 本次修复使 v0.0.300–342 全部版本 spec↔code 对齐；遗留原则：编码期偏离必须落 change_log（frozen 契约不改、偏离可见）。
