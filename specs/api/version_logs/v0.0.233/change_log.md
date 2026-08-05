# v0.0.233 API change log — derive_academy 继承预检 + 同名裁决

> 对应 PRD：`specs/prd/version_logs/v0.0.233/change_log.md`（D1-D8 + P1-P5）。
> 技术权威：`specs/tech/version_logs/v0.0.233/change_plan.md` + `specs/tech/academy/[P1]derive_preview_conflict.md`。
> overall `specs/api/overall/11a-squad-endpoints.md` §2.1 / §2.5 已同步（[v0.0.233 modified] / [v0.0.233] 新增标记）。

## 1. §2.1 HireMemberBody derive_academy 分支扩 resolution?

`POST /squad/:id/member` 的 derive_academy 联合分支加可选 `resolution?: DeriveResolution`（同名裁决结果）：

```typescript
type ResolutionItem = { name: string; action: 'skip' | 'overwrite' };
type DeriveResolution = {
  skills?: ResolutionItem[];
  memory?: ResolutionItem[];
};
// hire body derive_academy 分支：resolution?: DeriveResolution
```

- **per-item 全清单**：由前端预览面板同名项 toggle 产出（每项 `{name, action}`）。
- **action 闭合枚举** `'skip' | 'overwrite'`（不引入其他值）。
- **undefined = 默认全 skip 同名 + 不同名 merge**（向后兼容；旧 client 不传 → 同名全 skip 安全默认）。
- **未在 resolution 列出 + 同名 → 默认 skip**；**未列出 + 不同名 → 默认 merge**；resolution 列出不同名项 → 后端宽容按 merge 走（忽略 action）。
- fresh / derive 分支带 resolution → accept-and-ignore（不消费、不 warn）。

零状态码变更、零 URL 变更（仍 `POST /squad/:id/member`）。错误码 `invalid_academy_source`（classroom 不存在 / version 非 formal+active）沿用。

## 2. §2.5 新增 POST /squad/:id/member/derive-academy/preview（预检 endpoint）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/squad/:id/member/derive-academy/preview` | derive_academy 派生前预检（读学生版本源 + squad 团队盘目标 → 列「将带入」清单 + 标同名；**纯只读无副作用**） | `{ classroomId, studentId, versionId }` | `200` + `PreviewResult` |

```typescript
interface PreviewResult {
  agentsMd: { exists: boolean };  // 个人差异文件无 sameNameConflict（带 memberId 无同名概念）
  skills: Array<{ name: string; sameNameConflict: boolean }>;
  memory: Array<{ name: string; sameNameConflict: boolean }>;
}
```

行为：squad 存在校验 → `resolveAcademyDeriveIdentity` 复用 hire 同函数校验三字段 + classroom 存在 + version formal+active（失败 throw `InvalidAcademySourceError` → 400 `invalid_academy_source`，与 hire 错误码一致）→ 源侧枚举 + 目标侧同名检测 → 返 PreviewResult（不写任何文件）。

错误码：`400` body 非法 / 三字段任一缺 / version 非 formal+active / classroom 不存在（均 `invalid_academy_source`）；`404` squad 不存在。

路由与 item match `/squad/:id/member/:mid`（3 段，`:mid`=`[^/]+` 不含 `/`）天然互斥（preview 是 4 段 path），无歧义。

## 3. 前后向兼容性

- hire body `resolution` 可选（undefined = 安全默认全 skip 同名）→ 旧 client 不传无影响。
- preview endpoint 纯新增，不影响现有 hire 端点。
- PreviewResult schema 见 `specs/tech/academy/[P1]derive_preview_conflict.md §2.2`。
