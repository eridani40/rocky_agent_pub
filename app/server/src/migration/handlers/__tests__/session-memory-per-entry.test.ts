/**
 * session-memory-per-entry migration handler 单测
 * 参考: specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A3
 *
 * 覆盖：旧 `<dataDir>/sessions/<sid>/session_memory.md` 拆 per-entry → `<ws>/.rocky/memory/<name>.md`
 *   - ws 解析：session record workspaceDir 优先；record 缺失/字段空 → `<dataDir>/workspace`
 *   - 原戳保留（source/updatedAt/evolvable/archived 原样，不刷新）+ 不过 长度硬限
 *   - 旧文件迁移后删除；幂等（无旧文件 skip / 二次运行 no-op）
 *   - 非法 name（路径分隔符）跳过不阻塞
 *   - 不触碰 app_config user_memory（global 不迁移）
 *
 * 文件系统隔离：os.tmpdir + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config-service';
import { parseEntryFile } from '../../../memory/memory-dir-store';
import { sessionMemoryPerEntryMigration } from '../session-memory-per-entry';
import type { MigrationHandlerContext } from '../../ledger';

let tmpRoot: string;
let ctx: MigrationHandlerContext;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-mig-sessmem-'));
  ctx = { dataDir: tmpRoot, appConfig: new AppConfigService({ root: tmpRoot }) };
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 造旧格式 session_memory.md（两 entry 堆叠） */
function seedLegacyFile(sid: string, raw: string): string {
  const dir = join(tmpRoot, 'sessions', sid);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'session_memory.md');
  writeFileSync(p, raw, 'utf8');
  return p;
}

/** 造 session record（{root}/session/<id>.json） */
function seedSessionRecord(sid: string, workspaceDir?: string): void {
  const dir = join(tmpRoot, 'session');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.json`), JSON.stringify(workspaceDir ? { id: sid, workspaceDir } : { id: sid }), 'utf8');
}

const LEGACY =
  '---\nname: alpha\nintro: first\nmetadata:\n  type: feedback\nevolvable: false\nsource: user\nupdatedAt: 2026-01-01T00:00:00.000Z\nwhy: w\n---\nalpha body\n' +
  '\n---\nname: beta\nintro: second\nmetadata:\n  type: project\nsource: agent\nupdatedAt: 2026-02-01T00:00:00.000Z\narchived: true\n---\nbeta body\n';

describe('session-memory-per-entry migration', () => {
  it('拆 per-entry 到 session.workspaceDir/.rocky/memory/ + 原戳保留 + 删旧文件', async () => {
    const ws = join(tmpRoot, 'my-ws');
    seedSessionRecord('s1', ws);
    const oldPath = seedLegacyFile('s1', LEGACY);

    await sessionMemoryPerEntryMigration(ctx);

    const memDir = join(ws, '.rocky', 'memory');
    const alpha = parseEntryFile(readFileSync(join(memDir, 'alpha.md'), 'utf8'))!;
    expect(alpha.intro).toBe('first');
    expect(alpha.type).toBe('feedback');
    expect(alpha.evolvable).toBe(false); // 原样保留
    expect(alpha.source).toBe('user'); // 不刷新
    expect(alpha.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(alpha.why).toBe('w');
    expect(alpha.body).toBe('alpha body');
    const beta = parseEntryFile(readFileSync(join(memDir, 'beta.md'), 'utf8'))!;
    expect(beta.archived).toBe(true);
    expect(beta.source).toBe('agent');
    expect(existsSync(oldPath)).toBe(false); // 旧文件已删
  });

  it('session record 缺失 → 回退 <dataDir>/workspace', async () => {
    seedLegacyFile('s-ghost', LEGACY);
    await sessionMemoryPerEntryMigration(ctx);
    const memDir = join(tmpRoot, 'workspace', '.rocky', 'memory');
    expect(existsSync(join(memDir, 'alpha.md'))).toBe(true);
  });

  it('幂等：无旧文件 skip；二次运行 no-op（不报错不重复写）', async () => {
    await sessionMemoryPerEntryMigration(ctx); // 空 dataDir → no-op
    const ws = join(tmpRoot, 'ws2');
    seedSessionRecord('s2', ws);
    seedLegacyFile('s2', LEGACY);
    await sessionMemoryPerEntryMigration(ctx);
    const first = readFileSync(join(ws, '.rocky', 'memory', 'alpha.md'), 'utf8');
    await sessionMemoryPerEntryMigration(ctx); // 二次运行
    expect(readFileSync(join(ws, '.rocky', 'memory', 'alpha.md'), 'utf8')).toBe(first);
  });

  it('非法 name（含 /）跳过不阻塞，其余 entry 照常迁移', async () => {
    const raw = LEGACY + '\n---\nname: bad/name\nintro: x\nmetadata:\n  type: user\n---\nbad body\n';
    seedLegacyFile('s3', raw);
    await sessionMemoryPerEntryMigration(ctx);
    const memDir = join(tmpRoot, 'workspace', '.rocky', 'memory');
    expect(existsSync(join(memDir, 'alpha.md'))).toBe(true);
    expect(existsSync(join(memDir, 'bad'))).toBe(false);
  });

  it('空旧文件直接删除；无法解析的旧文件保留不丢数据', async () => {
    const empty = seedLegacyFile('s4', '   \n');
    await sessionMemoryPerEntryMigration(ctx);
    expect(existsSync(empty)).toBe(false);

    const garbage = seedLegacyFile('s5', 'no frontmatter here at all');
    await sessionMemoryPerEntryMigration(ctx);
    expect(existsSync(garbage)).toBe(true); // 保留
  });

  it('不触碰 app_config user_memory（global 不迁移）', async () => {
    ctx.appConfig.set('user_memory', 'default', { entries: [{ name: 'x', type: 'user', body: 'b' }] });
    seedLegacyFile('s6', LEGACY);
    await sessionMemoryPerEntryMigration(ctx);
    // app_config record 原样保留（物理保留不回读 = 全删效果由读侧达成）
    const rec = ctx.appConfig.get('user_memory', 'default') as { entries: unknown[] };
    expect(rec.entries).toHaveLength(1);
    // global memory 目录不建
    expect(existsSync(join(tmpRoot, 'memory'))).toBe(false);
  });
});
