/**
 * skill-types — skill 管理页共享类型 + 树转换工具
 * 参考: specs/api/overall/06-skill.md §8（SkillEntry）/ §6.2（SkillFileNode）
 *       specs/ui/components/skill-page/page-skill.md（SkillItem）
 *
 * 后端 API 契约（06-skill.md）：
 * - 标识用 `name`（kebab-case）+ `scope`（app|workspace）复合定位；name 即 id。
 * - 列表 GET /skill → { items: SkillEntry[] }（双层合并去重）
 * - 安装 POST /skill/install multipart → { skill: SkillEntry }
 * - toggle PATCH /skill/:name body {enabled} → { skill: SkillEntry }
 * - 删除 DELETE /skill/:name → { ok: true }（物理删除）
 * - 预览树 GET /skill/:name/tree → { tree: SkillFileNode[] }（**扁平数组带 path**，非嵌套）
 * - 预览文件 GET /skill/:name/file?path= → { path, content, truncated, binary }
 *
 * 注意：API 的 tree 是扁平数组（每项含 path），前端需转成嵌套树渲染——
 * 树转换纯函数与递归树视图已提升到 `components/common/file-tree.ts` 与
 * `components/common/component-file-tree.tsx`（skill 预览弹层与 academy skill browser 共用）。
 * 类型从 api-client re-export（唯一源在 api-client，避免双源漂移）。
 */
export type {
  SkillEntry,
  SkillFileNode,
  SkillFileContent,
} from '../../lib/api-client';
