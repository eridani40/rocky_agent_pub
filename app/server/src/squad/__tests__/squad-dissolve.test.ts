/**
 * dissolveSquad 单测（白盒）—— v0.0.111 块② + v0.0.192 删除链路修正
 * 参考: specs/tech/version_logs/v0.0.111/change_plan.md 块②（dissolveSquad 编排）
 *       states/v0.0.111.workitem_visibility/team-delete-research.md（硬删执行顺序权威）
 *       specs/tech/version_logs/v0.0.192.delete_cleanup/change_plan.md（保留产出 + listSessionsBySquad）
 *
 * 核心正确性约束（MUST，颠倒即留潜伏调度）：
 *   ① disposeSquad（teardown 停调度）→ ② deleteSession（各会话）→ ③ deleteSquad（删 record）
 *   → ④ deleteSquadAdministrativeSubpaths（删管理性子项，保留工作产出）
 *
 * v0.0.192 重点：**顺序断言**（dispose 先于删 session）+ **保留 vs 删管理性子项双断言**
 *   + **listSessionsBySquad 替代 memberStore 枚举**（catch 全部 squad session 含 spawn child）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dissolveSquad, type DissolveSquadDeps } from '../squad-dissolve';
import { squadRootDir } from '../../stores/squad-store';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'squad-dissolve-'));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * 建完整办公室骨架（与 ensureSquadDirSkeleton 对齐）—— UT 验证「保留 vs 删管理性子项」边界用：
 *   保留（用户工作产出）：outputs/ reports/ workspaces/ board/
 *   删（管理性 / 解散后无用）：members/ charter_history/ panorama/ .rocky/ + charter.md
 *   保留（历史 OKF 文档，不主动删）：index.md log.md
 */
function seedOfficeDir(squadId: string): string {
  const dir = squadRootDir(tmpRoot, squadId);
  // 用户工作产出（应保留）
  for (const d of ['board', 'outputs', 'reports/daily', 'reports/tasks', 'reports/goals', 'workspaces']) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  // 管理性子项（应删）
  for (const d of ['members', 'charter_history', 'panorama/entities', '.rocky/state']) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  // charter.md（charter 已删，死文件清理）+ 历史 OKF 文档 index.md/log.md（保留）
  writeFileSync(join(dir, 'charter.md'), 'x');
  writeFileSync(join(dir, 'index.md'), 'x');
  writeFileSync(join(dir, 'log.md'), 'x');
  // 用户工作产出标记文件（应保留）
  writeFileSync(join(dir, 'workspaces', 'note.md'), 'kept');
  return dir;
}

describe('dissolveSquad — 硬删编排（teardown 先于删数据 + 保留工作产出）', () => {
  it('调用序：disposeSquad → deleteSession(各) → deleteSquad（listSessionsBySquad 替代 memberStore 枚举）', async () => {
    const squadId = 'SQ-1';
    const officeDir = seedOfficeDir(squadId);
    expect(existsSync(officeDir)).toBe(true);

    const calls: string[] = [];
    // deleteSquad 被调时 workspaces 目录仍应存在（证明删管理性子项在其之后）
    let workspaceExistsAtDeleteSquad: boolean | null = null;

    const deps: DissolveSquadDeps = {
      squadId,
      squadRuntime: {
        disposeSquad: vi.fn(async (id: string) => { calls.push(`dispose:${id}`); }),
      },
      sessionStore: {
        listSessionsBySquad: vi.fn(async () => ['SID-CHAT', 'SID-M1', 'SID-M2']),
        deleteSession: vi.fn(async (sid: string) => { calls.push(`deleteSession:${sid}`); }),
      },
      squadStore: {
        deleteSquad: vi.fn(async (id: string) => {
          calls.push(`deleteSquad:${id}`);
          workspaceExistsAtDeleteSquad = existsSync(join(officeDir, 'workspaces'));
          return true;
        }),
      },
      dataDir: tmpRoot,
    };

    await dissolveSquad(deps);

    // 顺序断言：dispose 最先、deleteSquad 最后（④ 不再整目录删，改删管理性子项）
    expect(calls).toEqual([
      'dispose:SQ-1',
      'deleteSession:SID-CHAT',
      'deleteSession:SID-M1',
      'deleteSession:SID-M2',
      'deleteSquad:SQ-1',
    ]);
    // deleteSquad 时 workspaces 仍在 → 证明 ④ 删管理性子项在 ③ 之后
    expect(workspaceExistsAtDeleteSquad).toBe(true);
  });

  it('解散后保留 workspaces/outputs/reports/board + 历史 OKF 文档；删管理性子项（members/charter_history/panorama/.rocky + charter.md）', async () => {
    const squadId = 'SQ-2';
    const officeDir = seedOfficeDir(squadId);

    const deps: DissolveSquadDeps = {
      squadId,
      squadRuntime: { disposeSquad: vi.fn(async () => {}) },
      sessionStore: {
        listSessionsBySquad: vi.fn(async () => []),
        deleteSession: vi.fn(async () => {}),
      },
      squadStore: {
        deleteSquad: vi.fn(async () => true),
      },
      dataDir: tmpRoot,
    };
    await dissolveSquad(deps);

    // 用户工作产出存活
    for (const d of ['board', 'outputs', 'reports', 'workspaces']) {
      expect(existsSync(join(officeDir, d)), `${d} 应保留`).toBe(true);
    }
    expect(existsSync(join(officeDir, 'workspaces', 'note.md'))).toBe(true);
    // 历史 OKF 文档保留（charter 删了但 index.md/log.md 是用户文档，不主动删）
    for (const f of ['index.md', 'log.md']) {
      expect(existsSync(join(officeDir, f)), `${f} 应保留`).toBe(true);
    }
    // 管理性子项已删
    for (const d of ['members', 'charter_history', 'panorama', '.rocky']) {
      expect(existsSync(join(officeDir, d)), `${d} 应删除`).toBe(false);
    }
    // charter.md 删（charter 已删，死文件清理）
    expect(existsSync(join(officeDir, 'charter.md')), 'charter.md 应删除').toBe(false);
    // 办公室根目录仍在（不再 rmSync 整目录）
    expect(existsSync(officeDir)).toBe(true);
  });

  it('会话枚举 = listSessionsBySquad（catch 全部 squad session 含 spawn child，不再用 memberStore）', async () => {
    const squadId = 'SQ-3';
    seedOfficeDir(squadId);
    const deleted: string[] = [];
    const listFn = vi.fn(async (sid: string) => {
      expect(sid).toBe(squadId);
      return ['SID-CHAT', 'SID-SPAWN-CHILD'];
    });
    const deps: DissolveSquadDeps = {
      squadId,
      squadRuntime: { disposeSquad: vi.fn(async () => {}) },
      sessionStore: {
        listSessionsBySquad: listFn,
        deleteSession: vi.fn(async (sid: string) => { deleted.push(sid); }),
      },
      squadStore: {
        deleteSquad: vi.fn(async () => true),
      },
      dataDir: tmpRoot,
    };
    await dissolveSquad(deps);
    expect(listFn).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual(['SID-CHAT', 'SID-SPAWN-CHILD']);
  });

  it('teardown（disposeSquad）在删任何 session 之前完成（防潜伏调度）', async () => {
    const squadId = 'SQ-4';
    seedOfficeDir(squadId);
    let sessionDeletedBeforeDispose = false;
    let disposed = false;
    const deps: DissolveSquadDeps = {
      squadId,
      squadRuntime: { disposeSquad: vi.fn(async () => { disposed = true; }) },
      sessionStore: {
        listSessionsBySquad: vi.fn(async () => ['SID-CHAT']),
        deleteSession: vi.fn(async () => { if (!disposed) sessionDeletedBeforeDispose = true; }),
      },
      squadStore: {
        deleteSquad: vi.fn(async () => true),
      },
      dataDir: tmpRoot,
    };
    await dissolveSquad(deps);
    expect(sessionDeletedBeforeDispose).toBe(false);
  });
});
