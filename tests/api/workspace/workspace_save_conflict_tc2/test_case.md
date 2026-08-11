# workspace_save_conflict_tc2

- 版本：v0.0.320 文件预览区
- 模块：workspace
- 设计：api-test-designer
- 契约依据：specs/api/version_logs/v0.0.320/change_log.md §1.2 + specs/api/overall/04-agent-session.md §2.6

## 目标

验证 `POST /session/:id/workspace/file/save` 乐观锁冲突检测：
expectedVersion 不匹配 → 409 {error:'conflict', currentVersion} 且不写盘；
force:true → 跳过校验直接覆盖 200。

## 前置（setup）

1. `POST /session {title}` → 200，取 `sid`（workspaceDir 自动建）
2. files 原语写 `workspaces/{sid}/conflict.md`（内容 A：`{marker: "initial-A"}`）

## 步骤与断言

| # | 请求 | 断言 |
|---|------|------|
| 1 | `GET file?path=conflict.md` | 200；`.version exists` + `.version ~= ":"`（save v1） |
| 2 | files 重写 `conflict.md`（内容 B，size 变大） | （模拟外部修改，version 必变） |
| 3 | `POST save {path, content:"overwrite-attempt", expectedVersion:"{v1}"}` | **409**；`.error == "conflict"` + `.currentVersion exists` |
| 4 | `GET file?path=conflict.md` | 200；`.content ~= "external-B"`（409 未覆盖，外部内容保留） |
| 5 | `POST save {path, content:"force-overwrite-content", force:true}` | 200；`.ok == true` + `.version exists` |
| 6 | `GET file?path=conflict.md` | 200；`.content == "force-overwrite-content"`（force 覆盖生效） |

## teardown

- `DELETE /session/{sid}`（204/404 容忍）

## 设计权衡（AT 边界）

- **currentVersion 只断 exists**：AT check 不支持跨响应比较（右侧不插值），
  不断言 currentVersion == 外部修改后的新 version；格式/存在性由本 case 覆盖，
  值正确性由 UT（session-workspace-file.test.ts）覆盖。
- **外部修改用 files 原语重写同路径**：内容 B 的 size 与内容 A 不同 →
  mtime 与 size 双变化保证 version 必变（避免同毫秒 mtime 相同的极端情形）。
- **expectedVersion 缺失分支**（last-write-wins）未覆盖——由 UT 覆盖；
  本 case 聚焦冲突 + force 两条核心路径。
- 不调 LLM，全确定性。
