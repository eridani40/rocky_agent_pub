/**
 * academy-store — AcademyStore（academy 域 7 entity 的 CrudStore 封装）
 * 参考: specs/tech/academy/[P0]data_model.md §6（Store 接口）+ §6.1（路径）+ §8（不变量）
 *       specs/tech/persistence/[P0]crud_store_interface.md（CrudStore 契约）
 *
 * 设计（data_model.md §6）：
 *   - 7 entity 各自 CompositeStore.mount → FsCrudStore（root=dataDir，shardKeyField=classroomId）
 *   - entity 名 = 目录名（classroom/students/student_versions/training_tasks/training_turns/datasets/graders）
 *   - workspace 目录（AGENTS.md + .rocky/）由 academy-paths + academy-version-dir 管，不走 CrudStore
 *   - 异步签名（Promise）保留——与 SessionStore/SquadStore 一致
 *   - fork/adopt/createInitial 原语已拆到 academy-store-ops.ts（保证单文件 ≤300 行）
 *
 * 单文件 ≤300 行（纯 CRUD 封装，无业务逻辑——业务事务在 service 层）。
 */
import type { CrudStore, StoredRecord } from '../persistence/crud-types';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';
import {
  ClassroomSchema, StudentSchema, StudentVersionSchema,
  TrainingTaskSchema, TrainingTurnSchema, DatasetSchema, GraderSchema,
} from './schema_defs';
import type {
  ClassroomRecord, StudentRecord, StudentVersionRecord,
  TrainingTaskRecord, TrainingTurnRecord, DatasetRecord, GraderRecord,
} from './schema_defs';

// entity 类型别名（含信封）
export type ClassroomEntity = StoredRecord<typeof ClassroomSchema>;
export type StudentEntity = StoredRecord<typeof StudentSchema>;
export type StudentVersionEntity = StoredRecord<typeof StudentVersionSchema>;
export type TrainingTaskEntity = StoredRecord<typeof TrainingTaskSchema>;
export type TrainingTurnEntity = StoredRecord<typeof TrainingTurnSchema>;
export type DatasetEntity = StoredRecord<typeof DatasetSchema>;
export type GraderEntity = StoredRecord<typeof GraderSchema>;

/**
 * AcademyStore — academy 域统一 facade。
 * 落盘根 {root}/academy/{cid}/<entity>/{id}.json（classroom 隔离）。
 *
 * 7 entity CRUD 方法 + getCrud 暴露（service 事务用）。
 * fork/adopt/createInitial 等业务原语走模块函数（academy-store-ops.ts），
 * 接受 AcademyStore 实例作首参，便于跨 store 复用。
 */
export class AcademyStore {
  private readonly store: CompositeStore;
  private readonly root: string;

  constructor(opts: { root: string }) {
    this.root = opts.root;
    const fs = new FsCrudStore({ root: opts.root });
    this.store = new CompositeStore()
      .mount('classroom', fs)
      .mount('students', fs)
      .mount('student_versions', fs)
      .mount('training_tasks', fs)
      .mount('training_turns', fs)
      .mount('datasets', fs)
      .mount('graders', fs);
  }

  /** root 路径（fork/adopt/createInitial 用，避免再次展开） */
  getRoot(): string {
    return this.root;
  }

  /** 暴露底层 crud（service 事务用，如 listStudentsByClassroom 后批量 putVersion） */
  getCrud(): CrudStore {
    return this.store;
  }

  // ── classroom ────────────────────────────────────────

  /** put classroom record（upsert） */
  async putClassroom(rec: ClassroomRecord): Promise<ClassroomEntity> {
    return this.store.putAsync(ClassroomSchema, rec);
  }
  /** 读 classroom；不存在返 undefined */
  async getClassroom(classroomId: string): Promise<ClassroomEntity | undefined> {
    return this.store.get(ClassroomSchema, classroomId, classroomId);
  }
  /** 列出全部 classroom（按 ULID 倒序稳定排序，避免同毫秒 createdAt 抖动） */
  async listClassrooms(): Promise<ClassroomEntity[]> {
    const all = this.store.query(ClassroomSchema, {});
    all.sort((a, b) => (b.id as string).localeCompare(a.id as string));
    return all;
  }

  // ── student + version ────────────────────────────────

  /** put student record（upsert；按 classroomId 分片） */
  async putStudent(rec: StudentRecord): Promise<StudentEntity> {
    return this.store.putAsync(StudentSchema, rec);
  }
  /** 读 student（按 classroomId 分片）；不存在返 undefined */
  async getStudent(classroomId: string, studentId: string): Promise<StudentEntity | undefined> {
    return this.store.get(StudentSchema, studentId, classroomId);
  }
  /** 列出某 classroom 全部 student（分片限定） */
  async listStudentsByClassroom(classroomId: string): Promise<StudentEntity[]> {
    return this.store.query(StudentSchema, { shardKey: classroomId, order: 'createdAtAsc' });
  }
  /** put version record（upsert；按 classroomId 分片） */
  async putVersion(rec: StudentVersionRecord): Promise<StudentVersionEntity> {
    return this.store.putAsync(StudentVersionSchema, rec);
  }
  /** 读 version（按 classroomId 分片） */
  async getVersion(classroomId: string, versionId: string): Promise<StudentVersionEntity | undefined> {
    return this.store.get(StudentVersionSchema, versionId, classroomId);
  }
  /** 列出某 student 全部 version（含 process） */
  async listVersions(classroomId: string, studentId: string): Promise<StudentVersionEntity[]> {
    const all = this.store.query(StudentVersionSchema, { shardKey: classroomId, order: 'createdAtAsc' });
    return all.filter((v) => v.studentId === studentId);
  }

  // ── training task + turn ─────────────────────────────

  /** put task record（upsert） */
  async putTask(rec: TrainingTaskRecord): Promise<TrainingTaskEntity> {
    return this.store.putAsync(TrainingTaskSchema, rec);
  }
  /** 读 task（按 classroomId 分片） */
  async getTask(classroomId: string, taskId: string): Promise<TrainingTaskEntity | undefined> {
    return this.store.get(TrainingTaskSchema, taskId, classroomId);
  }
  /** 列出某 classroom 全部 task（分片限定） */
  async listTasksByClassroom(classroomId: string): Promise<TrainingTaskEntity[]> {
    return this.store.query(TrainingTaskSchema, { shardKey: classroomId, order: 'createdAtAsc' });
  }
  /** 列出某 coach session 的全部 task（scatter + 线性过滤） */
  async listTasksByCoach(coachSessionId: string): Promise<TrainingTaskEntity[]> {
    const all = this.store.query(TrainingTaskSchema, {});
    return all.filter((t) => t.coachSessionId === coachSessionId);
  }
  /** append turn record（upsert；不提供 update——append-after-round 语义） */
  async appendTurn(rec: TrainingTurnRecord): Promise<TrainingTurnEntity> {
    return this.store.putAsync(TrainingTurnSchema, rec);
  }
  /** 读某轮 turn（按 taskId + round 线性过滤） */
  async getTurn(classroomId: string, taskId: string, round: number): Promise<TrainingTurnEntity | undefined> {
    const all = this.store.query(TrainingTurnSchema, { shardKey: classroomId });
    return all.find((t) => t.taskId === taskId && t.round === round);
  }
  /** 列出某 task 全部 turn（按 round asc 稳定） */
  async listTurns(classroomId: string, taskId: string): Promise<TrainingTurnEntity[]> {
    const all = this.store.query(TrainingTurnSchema, { shardKey: classroomId, order: 'createdAtAsc' });
    const filtered = all.filter((t) => t.taskId === taskId);
    filtered.sort((a, b) => a.round - b.round);
    return filtered;
  }

  // ── dataset + grader ─────────────────────────────────

  /** put dataset record（upsert） */
  async putDataset(rec: DatasetRecord): Promise<DatasetEntity> {
    return this.store.putAsync(DatasetSchema, rec);
  }
  /** 读 dataset（按 classroomId 分片） */
  async getDataset(classroomId: string, datasetId: string): Promise<DatasetEntity | undefined> {
    return this.store.get(DatasetSchema, datasetId, classroomId);
  }
  /** 列出某 classroom 全部 dataset */
  async listDatasetsByClassroom(classroomId: string): Promise<DatasetEntity[]> {
    return this.store.query(DatasetSchema, { shardKey: classroomId, order: 'createdAtAsc' });
  }
  /** put grader record（upsert） */
  async putGrader(rec: GraderRecord): Promise<GraderEntity> {
    return this.store.putAsync(GraderSchema, rec);
  }
  /** 读 grader（按 classroomId 分片） */
  async getGrader(classroomId: string, graderId: string): Promise<GraderEntity | undefined> {
    return this.store.get(GraderSchema, graderId, classroomId);
  }
  /** 列出某 classroom 全部 grader */
  async listGradersByClassroom(classroomId: string): Promise<GraderEntity[]> {
    return this.store.query(GraderSchema, { shardKey: classroomId, order: 'createdAtAsc' });
  }
}
