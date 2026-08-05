/**
 * SquadStore / MemberStore — squad 层 entity 的 CrudStore 封装
 * 参考: states/v0.0.33.1/design.md §1（实体）+ §2（存储布局）
 *       specs/tech/squad/[P1]data_model.md §1（SchemaDef）+ §3（存储布局）
 *       specs/tech/persistence/[P0]crud_store_interface.md（CrudStore 契约）
 *
 * 设计（data_model.md §3 + design.md §2）：
 *   - 两 entity 各自 CompositeStore.mount → FsCrudStore（root=data_dir）
 *   - squad：不分片，落 {root}/squad/{squadId}.json
 *   - member：按 squadId 分片，落 {root}/squads/{squadId}/members/{memberId}.json
 *   - 异步签名（Promise）保留——与 SessionStore 一致，兼容 future 异步 engine
 *
 * 单文件 ≤300 行（纯封装，无业务逻辑——业务事务在 squad-service.ts）。
 */
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CrudStore, StoredRecord } from '../persistence/crud-types';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';
import {
  SquadSchema, MemberSchema,
} from '../agent/schema_defs/squad';
import type {
  SquadRecord, MemberRecord,
} from '../agent/schema_defs/squad';

/** squad record（含信封） */
export type SquadEntity = StoredRecord<typeof SquadSchema>;
/** member record（含信封） */
export type MemberEntity = StoredRecord<typeof MemberSchema>;

/**
 * SquadStore — squad entity 的 CRUD 封装（不分片）。
 * 落盘 {root}/squad/{squadId}.json。
 */
export class SquadStore {
  private readonly store: CompositeStore;
  /** root（建目录骨架用） */
  private readonly root: string;

  constructor(opts: { root: string }) {
    this.root = opts.root;
    const fs = new FsCrudStore({ root: opts.root });
    this.store = new CompositeStore().mount('squad', fs);
  }

  /** 暴露底层 crud（service 事务用，如 append memberIds 需 read-modify-write） */
  getCrud(): CrudStore {
    return this.store;
  }

  /** put squad record（upsert；memberIds 由 service 维护） */
  async putSquad(rec: SquadRecord): Promise<SquadEntity> {
    // putAsync 经 withFileLock 串行化（spec file_write_lock §6.1 [wait]）
    return this.store.putAsync(SquadSchema, rec);
  }

  /** 读单个 squad；不存在返 undefined */
  async getSquad(squadId: string): Promise<SquadEntity | undefined> {
    return this.store.get(SquadSchema, squadId);
  }

  /**
   * 列出全部 squad（按创建时间倒序，稳定）。
   *
   * 不依赖 CrudStore 的 createdAtDesc：createdAt 是信封时间戳（ISO 毫秒级），
   * 同毫秒内多次创建（UI 快速连续建 squad / UT 全量并发下两条 putSquad 落同毫秒）
   * 会得到相同 createdAt，createdAtDesc 无 tiebreak → 排序不稳定、顺序错乱。
   * 改为查回全量后按 id（ULID 业务生成、单调递增，字典序倒序 = 时间倒序，稳定）排序。
   * 与本文件 listMembers / session-store.getMessages 的 ULID 稳定排序口径一致。
   */
  async listSquads(): Promise<SquadEntity[]> {
    const all = this.store.query(SquadSchema, {});
    // ULID 字典序倒序 = 时间倒序（最新在前），同毫秒仍稳定（id 单调递增）
    all.sort((a, b) => (b.id as string).localeCompare(a.id as string));
    return all;
  }

  /** 删 squad（仅补偿回滚用；无 HTTP DELETE 端点，design.md §1.1） */
  async deleteSquad(squadId: string): Promise<boolean> {
    // deleteAsync 经 withFileLock 串行化（spec file_write_lock §6.1 [wait]）
    return this.store.deleteAsync(SquadSchema, squadId);
  }
}

/**
 * MemberStore — member entity 的 CRUD 封装（按 squadId 分片）。
 * 落盘 {root}/squads/{squadId}/members/{memberId}.json。
 */
export class MemberStore {
  private readonly store: CompositeStore;

  constructor(opts: { root: string }) {
    const fs = new FsCrudStore({ root: opts.root });
    this.store = new CompositeStore().mount('members', fs);
  }

  /** put member record（分片键 squadId 从 record 提取） */
  async putMember(rec: MemberRecord): Promise<MemberEntity> {
    // putAsync 串行化（同 squad 并发 join 热点，spec §6.1 [wait]）
    return this.store.putAsync(MemberSchema, rec);
  }

  /** 读单个 member（分片必须带 shardKey=squadId） */
  async getMember(squadId: string, memberId: string): Promise<MemberEntity | undefined> {
    return this.store.get(MemberSchema, memberId, squadId);
  }

  /** 列出某 squad 全部 member（分片限定） */
  async listMembers(squadId: string): Promise<MemberEntity[]> {
    return this.store.query(MemberSchema, { shardKey: squadId, order: 'createdAtAsc' });
  }

  /** 删 member（仅补偿回滚用；无 HTTP DELETE 端点，design.md §3.2） */
  async deleteMember(squadId: string, memberId: string): Promise<boolean> {
    // deleteAsync 串行化（spec §6.1 [wait]）
    return this.store.deleteAsync(MemberSchema, memberId, squadId);
  }
}

/**
 * 建 squad「办公室」目录骨架（design.md §2 + data_model §3）。
 * 建 squad 即建，含 outputs/reports/{daily,tasks,goals}/members/.rocky/{state,agents}。
 * member 目录由 store put 时 lazy 建，但显式预建保证骨架完整。
 * `.rocky/agents` 空目录占位——引导用户放 per-member 个人差异 AGENTS 文件（{名字}-{memberId}.md）。
 *
 * @param root     data_dir（与 store root 一致）
 * @param squadId  squad id
 */
export function ensureSquadDirSkeleton(
  root: string,
  squadId: string,
): void {
  const base = join(root, 'squads', squadId);
  const subdirs = [
    'outputs',
    'reports/daily', 'reports/tasks', 'reports/goals',
    'members',
    '.rocky/state', '.rocky/agents',
    // panorama 业务全景目录（board.yaml + entities/ + .archive/ + .state/）
    'panorama/entities', 'panorama/.archive', 'panorama/.state',
  ];
  for (const d of subdirs) {
    try {
      mkdirSync(join(base, d), { recursive: true });
    } catch {
      // 已存在或权限——忽略（幂等，运行时再报）
    }
  }
  // panorama events.jsonl 空文件占位（EventStore 首次 append 前 ensureDirSync；此处显式建保证骨架完整）
  try {
    const ev = join(base, 'panorama', 'events.jsonl');
    if (!existsSync(ev)) writeFileSync(ev, '', 'utf8');
  } catch {
    // 已存在或权限——忽略
  }
}

/** squad 办公室根目录（AT 验证骨架/工具路径用） */
export function squadRootDir(root: string, squadId: string): string {
  return join(root, 'squads', squadId);
}

/**
 * 解散时删办公室的「管理性子路径」。
 *
 * 与 ensureSquadDirSkeleton 对称（建骨架 vs 删管理性数据）。判据=用户看得懂的产出留 /
 * 程序才懂的内部数据删（req 决策原则）。
 *
 * 保留（用户工作产出铁律）：outputs/ reports/。
 * 删（管理性 / 解散后无用）：
 *   - 目录：members/ charter_history/ panorama/ .rocky/
 *   - 文件：charter.md（charter 已删，死文件清理）
 *
 * 全部 force:true 幂等（缺失不报错）；MUST NOT rmSync 整个 squadRootDir（保工作产出）。
 *
 * @param root     data_dir（caller 展开为绝对路径，禁字面 `~`——BUG-004 打包护栏）
 * @param squadId  squad id
 */
export function deleteSquadAdministrativeSubpaths(root: string, squadId: string): void {
  const base = squadRootDir(root, squadId);
  const dirs = ['members', 'charter_history', 'panorama', '.rocky'];
  for (const d of dirs) {
    rmSync(join(base, d), { recursive: true, force: true });
  }
  // charter.md = okf-helper 投影的 charter md 版本，charter 删后死文件清理
  rmSync(join(base, 'charter.md'), { force: true });
}
