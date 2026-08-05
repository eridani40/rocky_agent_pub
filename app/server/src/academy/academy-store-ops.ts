/**
 * academy-store-ops — academy 域业务原语（fork / adopt / createInitial）
 * 参考: specs/tech/academy/[P0]data_model.md §6（Store 接口）+ §8（INV-5/INV-6）
 *
 * 拆分原因：academy-store.ts 纯 CRUD 已 ~190 行，加业务原语会超 300 限制。
 * 业务原语与 AcademyStore 实例解耦（首参传 store），便于 mock + 单测。
 *
 * 不变量：
 *   - INV-5 fork/adopt 原子性：copyVersionDir dst 非空抛错
 *   - INV-6 workspaceDir 不可变：fork/adopt 都复制；adopt 后 process 目录保留 status='adopted'
 */
import { ulid } from '../config/ulid';
import {
  formalVersionWorkspaceDir,
  processVersionWorkspaceDir,
} from './academy-paths';
import { copyVersionDir, writeVersionDirFiles, patchVersionJsonLabel } from './academy-version-dir';
import type { AcademyStore } from './academy-store';

/** forkVersionWorkspace 出参 */
export interface ForkVersionResult {
  versionId: string;
  workspaceDir: string;
}

/** adoptToFormal 出参 */
export interface AdoptToFormalResult {
  newFormalVersionId: string;
  newLabel: string;
  newWorkspaceDir: string;
}

/**
 * fork 版本工作区为新的 process 版本（spec §6 + INV-5）。
 *
 * 步骤：
 *   1. 读 baseVersion record（base 类型不限：formal 或 process 均合法，见下）
 *   2. 计算 process 版本路径：.work/{baseLabel}.{taskSeq}/{round}/ws/
 *   3. copyVersionDir（fs.cp recursive，dst 非空抛错，INV-5 原子性）
 *   4. 写新 process version record（status='active'）
 *
 * base 类型契约（multi-turn 迭代真实模型，对齐 training_engine §3）：
 *   - round 1：base = formal（task.baseVersionId → task.temporaryBaselineVersionId 初值）
 *   - round 2+：base = process（上一轮候选；improve 时 temporaryBaselineVersionId 被替换为候选 process 版本）
 *   fork = 物理复制 workspace → 新 process 版本；复制操作不依赖 source 类型，
 *   新 record 始终 type='process'。INV-5（原子性）/ INV-6（workspaceDir 不可变）与 base 类型无关。
 *   adopt 路径 INV 独立（adoptToFormal 自身校验 input.type==='process'，与 fork base 无关）。
 *
 * @param store    AcademyStore 实例（用于读写 record）
 * @param root     dataDir 绝对路径（resolveDataDir 展开后，禁字面 ~）
 * @param baseVersionId 基线版本 id（formal 或 process 均可）
 * @param classroomId   教室 id
 * @param studentId     学生 id
 * @param taskSeq       任务序号（过程版本号第 2 段）
 * @param round         轮次（过程版本号第 3 段，1-based）
 * @param createdFromTaskId 产出该版本的任务 id
 */
export async function forkVersionWorkspace(
  store: AcademyStore,
  root: string,
  baseVersionId: string,
  classroomId: string,
  studentId: string,
  taskSeq: number,
  round: number,
  createdFromTaskId: string,
): Promise<ForkVersionResult> {
  const baseVersion = await store.getVersion(classroomId, baseVersionId);
  if (!baseVersion) {
    throw new Error(`forkVersionWorkspace: baseVersion ${baseVersionId} 不存在`);
  }
  // 不校验 base.type：formal（round 1）与 process（round 2+ multi-turn 迭代临时基线）均为合法 fork 源。
  // 新版本始终 type='process'；spec training_engine §3 L134-136/174-177 明确 multi-turn 设计需要 fork-from-process。

  const dstDir = processVersionWorkspaceDir(
    root, classroomId, studentId, baseVersion.versionLabel, taskSeq, round,
  );
  // copyVersionDir 内部检查 dst 非空（原子性 INV-5）
  await copyVersionDir(baseVersion.workspaceDir, dstDir);

  // 过程版本号 3 段化：versionLabel 字段取 base 顶层 major（split('.')[0]），不拼完整 base.versionLabel
  // （base='0.0' → '0.{taskSeq}.{round}'；multi-turn base 是 process 版时只取顶层 major 不段数爆炸）。
  // dst 目录路径仍用 base 完整 label（路径唯一性，processVersionWorkspaceDir 内已拼）；
  // adoptToFormal 取 major 同此路径（见下方 split('.')[0]）。
  const baseMajor = baseVersion.versionLabel.split('.')[0] ?? '0';
  const newLabel = `${baseMajor}.${taskSeq}.${round}`;

  // 修复 BUG#1（v0.0.221）：copyVersionDir 只复制源 ws 整目录，源 version.json 的 versionLabel
  // 还是 base 的值（如 "0.0"），与下面 putVersion 写的 record.versionLabel 不一致。
  // 必须 patch workspace 内 version.json 的 versionLabel 字段。
  await patchVersionJsonLabel(dstDir, newLabel);

  const newVersionId = ulid();
  await store.putVersion({
    id: newVersionId,
    studentId,
    classroomId,
    versionLabel: newLabel,
    type: 'process',
    parentFormalVersionId: baseVersionId,
    taskSeq,
    roundNumber: round,
    createdFromTaskId,
    workspaceDir: dstDir,
    status: 'active',
  });

  return { versionId: newVersionId, workspaceDir: dstDir };
}

/**
 * 接受 = 复制临时基线为新 formal 版本（spec §6 + INV-6 不 rename 原 process）。
 *
 * 步骤：
 *   1. 读 processVersion record（必须是 process 类型）
 *   2. 找下一个空正式版号（基于 base.major 段 +1：1.0 → 2.0 → 3.0 ...）
 *   3. copyVersionDir(process.wsDir → formal.wsDir）
 *   4. 写新 formal version record（type='formal'，createdFromTaskId 保留作溯源）
 *   5. 更新 process version record：status='adopted'（不删不 rename，INV-6）
 *
 * @returns 新 formal versionId + label + workspaceDir
 */
export async function adoptToFormal(
  store: AcademyStore,
  root: string,
  classroomId: string,
  processVersionId: string,
): Promise<AdoptToFormalResult> {
  const processVersion = await store.getVersion(classroomId, processVersionId);
  if (!processVersion) {
    throw new Error(`adoptToFormal: processVersion ${processVersionId} 不存在`);
  }
  if (processVersion.type !== 'process') {
    throw new Error(
      `adoptToFormal: processVersion ${processVersionId} 必须是 process，实际 ${processVersion.type}`,
    );
  }
  if (!processVersion.parentFormalVersionId) {
    throw new Error(`adoptToFormal: processVersion ${processVersionId} 缺 parentFormalVersionId`);
  }

  const baseVersion = await store.getVersion(classroomId, processVersion.parentFormalVersionId);
  if (!baseVersion) {
    throw new Error(
      `adoptToFormal: parent formal ${processVersion.parentFormalVersionId} 不存在`,
    );
  }

  // 找下一个空正式版号：基于 base.major 段递增（1.0 → 2.0 → 3.0）
  const baseMajor = parseInt(baseVersion.versionLabel.split('.')[0] ?? '0', 10);
  const studentVersions = await store.listVersions(classroomId, processVersion.studentId);
  let nextMajor = baseMajor + 1;
  const existingLabels = new Set(
    studentVersions.filter((v) => v.type === 'formal').map((v) => v.versionLabel),
  );
  while (existingLabels.has(`${nextMajor}.0`)) {
    nextMajor++;
  }
  const newLabel = `${nextMajor}.0`;
  const newWorkspaceDir = formalVersionWorkspaceDir(
    root, classroomId, processVersion.studentId, newLabel,
  );

  // 复制 process → 新 formal 目录（INV-6：不 rename 原 process 目录）
  await copyVersionDir(processVersion.workspaceDir, newWorkspaceDir);

  // 修复 BUG#1（v0.0.221）：copyVersionDir 复制的是 process ws（version.json.versionLabel 还是
  // process 版的 `major.seq.round`），与 formal 版本号 newLabel 不一致；patch 对齐。
  await patchVersionJsonLabel(newWorkspaceDir, newLabel);

  const newFormalVersionId = ulid();
  await store.putVersion({
    id: newFormalVersionId,
    studentId: processVersion.studentId,
    classroomId,
    versionLabel: newLabel,
    type: 'formal',
    // formal 版本无 parent process 关联；createdFromTaskId 仅 process 用，作溯源保留
    createdFromTaskId: processVersion.createdFromTaskId,
    adoptedFromProcessVersionId: processVersionId,
    workspaceDir: newWorkspaceDir,
    status: 'active',
  });

  // 原 process 目录保留，仅更新 status='adopted'（INV-6）
  // 注：strip 信封字段（createdAt/updatedAt/version），CrudStore putAsync 会重新计算
  const { createdAt: _c, updatedAt: _u, version: _v, ...procRecord } = processVersion;
  await store.putVersion({
    ...procRecord,
    status: 'adopted',
  });

  // 修复 BUG-001（v0.0.221）：adopt 后同步 student.currentFormalVersionId（pre-existing：adopt 流程
  // 全程不动 student record，导致 get_student/list_students 在 adopt 后仍报旧 formal）。
  const student = await store.getStudent(classroomId, processVersion.studentId);
  if (student) {
    const { createdAt: _sc, updatedAt: _su, version: _sv, ...studentRec } = student;
    await store.putStudent({
      ...studentRec,
      currentFormalVersionId: newFormalVersionId,
    });
  }

  return { newFormalVersionId, newLabel, newWorkspaceDir };
}

/**
 * 建初始 0.0 空正式版本（建学生时调用）。
 * 写 0.0 workspace 目录骨架（空 AGENTS.md 不写——0.0 是 graceful empty）+ version.json + record。
 *
 * @param store        AcademyStore 实例
 * @param root         dataDir 绝对路径
 * @param classroomId  教室 id
 * @param studentId    学生 id
 * @param model        初始模型快照（学生默认模型）
 */
export async function createInitialFormalVersion(
  store: AcademyStore,
  root: string,
  classroomId: string,
  studentId: string,
  model: { providerId?: string; modelId: string },
): Promise<{ versionId: string; workspaceDir: string }> {
  const workspaceDir = formalVersionWorkspaceDir(root, classroomId, studentId, '0.0');
  // 0.0 空版本：仅建目录骨架 + version.json，不写 AGENTS.md（INV: 0.0 graceful）
  // 注：本函数走 writeVersionDirFiles 已正确写 versionLabel='0.0'（v0.0.221 versionLabel BUG 修复的基线）。
  // forkVersionWorkspace / adoptToFormal 须额外 patchVersionJsonLabel 修 workspace version.json versionLabel，
  // 本函数不需（writeVersionDirFiles 内部已写正确）。
  await writeVersionDirFiles(workspaceDir, {
    versionLabel: '0.0',
    model,
    // agentsMd 不传 = 不写 AGENTS.md（0.0 是空白起点，head 后续可编辑）
  });
  const versionId = ulid();
  await store.putVersion({
    id: versionId,
    studentId,
    classroomId,
    versionLabel: '0.0',
    type: 'formal',
    workspaceDir,
    status: 'active',
  });
  return { versionId, workspaceDir };
}
