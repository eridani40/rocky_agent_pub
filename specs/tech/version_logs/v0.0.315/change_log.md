# v0.0.315 — 解散团队弹窗大小写 bug 修复

> 单行 bugfix。解散团队弹窗 confirmLabel 被 `FIELD_LABEL`（含 `uppercase`）强制大写，导致 squadName 回显后用户无法精确输入匹配原队名。

## 改动

`component-squad-delete.tsx:100` — confirmLabel 的 label className 从 `FIELD_LABEL` 改为 `FIELD_LABEL.replace(' uppercase', '')`，去掉 uppercase 使 squadName 保持原始大小写。
