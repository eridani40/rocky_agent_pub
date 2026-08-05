/**
 * memory-source-updated handler 单测 — 存量 memory entry 补 source/updatedAt 字段
 * 参考: specs/tech/version_logs/v0.0.149.memory_opt/change_plan.md §0 决策 D + §1 migration 行
 *       specs/tech/agent/memory/[P0]memory_definition.md §3（entry schema：source/updatedAt）
 *
 * 覆盖：
 *   - user_memory record：entries[].source(缺→'agent')/updatedAt(缺→now ISO) 补字段
 *   - session_memory.md：parse → 补 → serialize → atomicWrite
 *   - 幂等：二次运行已有两字段 → no-op（不 set、不写盘）
 *   - 非破坏：其他字段（intro/type/body/why/howToApply/archived/evolvable）原样保留
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config-service';
import { legacySessionMemoryFilePath } from '../legacy-memory-format';
import { memorySourceUpdatedMigration } from '../memory-source-updated';
import type { MigrationHandlerContext } from '../../ledger';

let tmpDataDir: string;
let appConfig: AppConfigService;
let ctx: MigrationHandlerContext;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'mem-src-handler-test-'));
  appConfig = new AppConfigService({ root: tmpDataDir });
  ctx = { dataDir: tmpDataDir, appConfig };
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 在 <dataDir>/sessions/<sid>/session_memory.md 写入 raw 内容 */
function seedSessionMemory(sid: string, raw: string): string {
  const dir = join(tmpDataDir, 'sessions', sid);
  mkdirSync(dir, { recursive: true });
  const filePath = legacySessionMemoryFilePath(tmpDataDir, sid);
  writeFileSync(filePath, raw, 'utf8');
  return filePath;
}

/** 存量 frontmatter（v0.0.149 前，无 source/updatedAt） */
const LEGACY_FM =
  '---\nname: legacy-a\nintro: 存量摘要\nmetadata:\n  type: user\nevolvable: true\n---\n存量正文A\n';
/** 已迁移 frontmatter（含 source/updatedAt） */
const MIGRATED_FM =
  '---\nname: fresh-b\nintro: 已迁移\nmetadata:\n  type: user\nevolvable: true\nsource: user\nupdatedAt: "2026-01-01T00:00:00.000Z"\n---\n正文B\n';

describe('memorySourceUpdatedMigration — user_memory record 介质', () => {
  it('record entries 缺 source/updatedAt → 同时补两字段 + set 回写', async () => {
    appConfig.set('user_memory', 'default', {
      entries: [
        { name: 'a', intro: 'ia', type: 'user', body: 'ba', evolvable: true },
        { name: 'b', intro: 'ib', type: 'feedback', body: 'bb', evolvable: false, archived: true },
      ],
    });
    const setSpy = vi.spyOn(appConfig, 'set');

    await memorySourceUpdatedMigration(ctx);

    expect(setSpy).toHaveBeenCalled();
    const after = appConfig.get('user_memory', 'default') as {
      entries: Array<{ source?: string; updatedAt?: string }>;
    };
    expect(after.entries[0]!.source).toBe('agent');
    expect(after.entries[0]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(after.entries[1]!.source).toBe('agent');
    expect(after.entries[1]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('非破坏：其他字段（intro/type/body/why/howToApply/archived/evolvable）原样保留', async () => {
    appConfig.set('user_memory', 'default', {
      entries: [
        {
          name: 'keep',
          intro: '保留intro',
          type: 'project',
          body: '保留body',
          why: '保留why',
          howToApply: '保留how',
          archived: true,
          evolvable: false,
        },
      ],
    });

    await memorySourceUpdatedMigration(ctx);

    const after = appConfig.get('user_memory', 'default') as {
      entries: Array<Record<string, unknown>>;
    };
    const e = after.entries[0]!;
    expect(e.name).toBe('keep');
    expect(e.intro).toBe('保留intro');
    expect(e.type).toBe('project');
    expect(e.body).toBe('保留body');
    expect(e.why).toBe('保留why');
    expect(e.howToApply).toBe('保留how');
    expect(e.archived).toBe(true);
    expect(e.evolvable).toBe(false);
    expect(e.source).toBe('agent');
    expect(typeof e.updatedAt).toBe('string');
  });

  it('仅 source 缺 → 只补 source，不动 updatedAt', async () => {
    const fixedUpdatedAt = '2025-12-31T00:00:00.000Z';
    appConfig.set('user_memory', 'default', {
      entries: [{ name: 'x', intro: 'i', type: 'user', body: 'b', updatedAt: fixedUpdatedAt }],
    });

    await memorySourceUpdatedMigration(ctx);

    const after = appConfig.get('user_memory', 'default') as {
      entries: Array<{ source?: string; updatedAt?: string }>;
    };
    expect(after.entries[0]!.source).toBe('agent');
    expect(after.entries[0]!.updatedAt).toBe(fixedUpdatedAt);
  });

  it('仅 updatedAt 缺 → 只补 updatedAt，不动 source（origin 保留）', async () => {
    appConfig.set('user_memory', 'default', {
      entries: [{ name: 'x', intro: 'i', type: 'user', body: 'b', source: 'user' }],
    });

    await memorySourceUpdatedMigration(ctx);

    const after = appConfig.get('user_memory', 'default') as {
      entries: Array<{ source?: string; updatedAt?: string }>;
    };
    expect(after.entries[0]!.source).toBe('user');
    expect(after.entries[0]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('幂等：二次运行所有 entry 已有两字段 → no-op（不 set）', async () => {
    appConfig.set('user_memory', 'default', {
      entries: [
        {
          name: 'done',
          intro: 'i',
          type: 'user',
          body: 'b',
          source: 'user',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const setSpy = vi.spyOn(appConfig, 'set');

    await memorySourceUpdatedMigration(ctx);

    expect(setSpy).not.toHaveBeenCalled();
  });

  it('record 不存在 → no-op', async () => {
    const setSpy = vi.spyOn(appConfig, 'set');
    await memorySourceUpdatedMigration(ctx);
    expect(setSpy).not.toHaveBeenCalled();
    expect(appConfig.get('user_memory', 'default')).toBeUndefined();
  });

  it('record.entries 为空数组 → no-op', async () => {
    appConfig.set('user_memory', 'default', { entries: [] });
    const setSpy = vi.spyOn(appConfig, 'set');
    await memorySourceUpdatedMigration(ctx);
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('memorySourceUpdatedMigration — session_memory.md 文件介质', () => {
  it('存量 entry 缺 source/updatedAt → 同时补两字段 + 写盘', async () => {
    const filePath = seedSessionMemory('sid-1', LEGACY_FM);
    const before = readFileSync(filePath, 'utf8');
    expect(before).not.toContain('source:');
    expect(before).not.toContain('updatedAt:');

    await memorySourceUpdatedMigration(ctx);

    const after = readFileSync(filePath, 'utf8');
    expect(after).toContain('source: agent');
    expect(after).toMatch(/updatedAt:\s*['"]?\d{4}-\d{2}-\d{2}T/);
    expect(after).toContain('name: legacy-a');
    expect(after).toContain('intro: 存量摘要');
    expect(after).toContain('type: user');
    expect(after).toContain('evolvable: true');
    expect(after).toContain('存量正文A');
  });

  it('幂等：二次运行 entry 已有两字段 → no-op（不写盘）', async () => {
    const filePath = seedSessionMemory('sid-2', MIGRATED_FM);
    const before = readFileSync(filePath, 'utf8');

    await memorySourceUpdatedMigration(ctx);
    const after = readFileSync(filePath, 'utf8');
    expect(after).toBe(before);
  });

  it('混合：存量 + 已迁移共存于同一文件 → 只补存量条目，已迁移不动', async () => {
    const filePath = seedSessionMemory('sid-3', `${LEGACY_FM}\n${MIGRATED_FM}`);
    await memorySourceUpdatedMigration(ctx);
    const after = readFileSync(filePath, 'utf8');

    // 存量条目被补
    const legacyBlock = after.split('---\n').find((b) => b.includes('legacy-a'));
    expect(legacyBlock).toBeDefined();
    expect(legacyBlock!).toMatch(/source:\s*agent/);
    expect(legacyBlock!).toMatch(/updatedAt:/);
    // 已迁移条目保留 source: user
    const migratedBlock = after.split('---\n').find((b) => b.includes('fresh-b'));
    expect(migratedBlock).toBeDefined();
    expect(migratedBlock!).toMatch(/source:\s*user/);
    expect(migratedBlock!).toMatch(/updatedAt:\s*['"]?2026-01-01T/);
  });

  it('session_memory.md 不存在 → no-op', async () => {
    mkdirSync(join(tmpDataDir, 'sessions', 'empty-sid'), { recursive: true });
    await expect(memorySourceUpdatedMigration(ctx)).resolves.toBeUndefined();
  });

  it('sessions/ 目录不存在 → no-op', async () => {
    await expect(memorySourceUpdatedMigration(ctx)).resolves.toBeUndefined();
  });

  it('非破坏：why/howToApply/archived 字段保留', async () => {
    const rawWithExtra =
      '---\nname: full\nintro: 摘要\nmetadata:\n  type: feedback\nevolvable: false\narchived: true\nwhy: 因为\nhowToApply: 这样用\n---\n正文\n';
    const filePath = seedSessionMemory('sid-full', rawWithExtra);

    await memorySourceUpdatedMigration(ctx);

    const after = readFileSync(filePath, 'utf8');
    expect(after).toContain('why: 因为');
    expect(after).toContain('howToApply: 这样用');
    expect(after).toContain('archived: true');
    expect(after).toContain('evolvable: false');
  });
});

describe('memorySourceUpdatedMigration — 两介质协同', () => {
  it('两介质都缺字段 → 都被补', async () => {
    appConfig.set('user_memory', 'default', {
      entries: [{ name: 'u', intro: 'i', type: 'user', body: 'b' }],
    });
    const sessionFile = seedSessionMemory('sid-both', LEGACY_FM);

    await memorySourceUpdatedMigration(ctx);

    const rec = appConfig.get('user_memory', 'default') as {
      entries: Array<{ source?: string; updatedAt?: string }>;
    };
    expect(rec.entries[0]!.source).toBe('agent');
    expect(rec.entries[0]!.updatedAt).toMatch(/^\d{4}-/);
    const after = readFileSync(sessionFile, 'utf8');
    expect(after).toContain('source: agent');
  });
});
