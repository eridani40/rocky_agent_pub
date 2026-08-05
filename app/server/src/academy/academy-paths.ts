/**
 * academy-paths — academy 域文件路径单点（spec §6.1）
 * 参考: specs/tech/academy/[P0]data_model.md §6.1（路径规范）+ §7（落盘示例）
 *       specs/tech/persistence/[P0]fs_crud_store_engine.md §2（CrudStore 路径）
 *
 * 职责：academy 域所有非 CrudStore 管理的文件路径（workspace 目录 + 工作区子文件）单点生成。
 * CrudStore 管理的 entity record JSON 路径由 schema.fs.sharding 自动决定，不走这里。
 *
 * 不变量（spec §6.1）：
 *   - 所有路径以 root（= resolveDataDir 展开后的绝对路径）为根，禁字面 ~（packaged 护栏 BUG-004）
 *   - workspaceDir 一旦确定不可变（INV-6），后续 fork/adopt 都复制不 rename
 *
 * 落盘布局（data_model.md §7）：
 *   {root}/academy/{cid}/
 *   ├── classroom.json                            （entity record, CrudStore 管）
 *   ├── students/{sid}/student.json               （entity record, CrudStore 管）
 *   ├── students/{sid}/versions/{label}/ws/       （formal 版本 workspace）
 *   │   ├── version.json                          （五元组快照：a/d/e）
 *   │   ├── AGENTS.md                             （b system prompt）
 *   │   └── .rocky/{skills,memory}/               （c/d skills+memory）
 *   ├── students/{sid}/versions/.work/{base}.{taskSeq}/{round}/ws/  （process 版本 workspace）
 *   └── ...
 */
import { join } from 'node:path';

/**
 * 教室根目录（所有 academy/{cid}/ 下内容）。
 * @param root       dataDir 绝对路径（resolveDataDir 展开后）
 * @param classroomId 教室 id
 */
export function classroomRoot(root: string, classroomId: string): string {
  return join(root, 'academy', classroomId);
}

/**
 * 学生根目录（版本树根）。
 * 路径：{classroomRoot}/students/{sid}/
 */
export function studentRoot(root: string, classroomId: string, studentId: string): string {
  return join(classroomRoot(root, classroomId), 'students', studentId);
}

/**
 * 学生 versions 目录（正式版 + 过程版统一树）。
 * 路径：{studentRoot}/versions/
 */
export function studentVersionsRoot(root: string, classroomId: string, studentId: string): string {
  return join(studentRoot(root, classroomId, studentId), 'versions');
}

/**
 * 正式版本 workspace 目录（含 AGENTS.md + .rocky/）。
 * 路径：{studentRoot}/versions/{label}/ws/
 * @param label 版本号字面量（如 '0.0', '1.0', '1.2.3'）
 */
export function formalVersionWorkspaceDir(
  root: string,
  classroomId: string,
  studentId: string,
  label: string,
): string {
  return join(studentVersionsRoot(root, classroomId, studentId), label, 'ws');
}

/**
 * 过程版本 workspace 目录。
 * 路径：{studentRoot}/versions/.work/{baseLabel}.{taskSeq}/{round}/ws/
 * @param baseLabel 基线正式版 label（如 '1.0'，非 vid）
 * @param taskSeq   任务序号（同 base 下递增）
 * @param round     轮次（1-based）
 */
export function processVersionWorkspaceDir(
  root: string,
  classroomId: string,
  studentId: string,
  baseLabel: string,
  taskSeq: number,
  round: number,
): string {
  return join(
    studentVersionsRoot(root, classroomId, studentId),
    '.work',
    `${baseLabel}.${taskSeq}`,
    String(round),
    'ws',
  );
}

/**
 * head teacher session workspace 目录（spec §7 head-workspace/）。
 * 路径：{classroomRoot}/head-workspace/
 */
export function headWorkspaceDir(root: string, classroomId: string): string {
  return join(classroomRoot(root, classroomId), 'head-workspace');
}
