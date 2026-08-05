/**
 * memory-intro handler 单测 — description→intro 字段重命名迁移
 * 参考: specs/tech/agent/memory/[P0]memory_definition.md §3（entry schema）
 *       specs/tech/version_logs/v0.0.150/change_plan.md 步骤2（handler 收编）
 *
 * 覆盖：
 *   - session_memory.md：description→intro（frontmatter 字段重命名）
 *   - user_memory record：entries[].description→intro
 *   - 幂等：二次运行无 description → no-op（不写盘、不 set、不重复备份）
 *   - 非破坏：其他字段（type/body/why/howToApply/archived/evolvable）原样保留；改前 .pre-intro.bak
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config-service';
import { legacySessionMemoryFilePath } from '../legacy-memory-format';
import { memoryIntroMigration } from '../memory-intro';
import type { MigrationHandlerContext } from '../../ledger';

let tmpDataDir: string;
let appConfig: AppConfigService;
let ctx: MigrationHandlerContext;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'mem-intro-handler-test-'));
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

/** 存量 frontmatter（v0.0.114 前，用 description 而非 intro） */
const LEGACY_FM =
  '---\nname: legacy-a\ndescription: 存量摘要\nmetadata:\n  type: user\nevolvable: true\n---\n存量正文A\n';
/** 已迁移 frontmatter（已是 intro） */
const MIGRATED_FM =
  '---\nname: fresh-b\nintro: 已迁移\nmetadata:\n  type: user\nevolvable: true\n---\n正文B\n';

describe('memoryIntroMigration — session_memory.md 介质', () => {
  it('description → intro 迁移 + 其他字段保留 + 备份 .pre-intro.bak', async () => {
    const filePath = seedSessionMemory('sid-1', LEGACY_FM);
    const before = readFileSync(filePath, 'utf8');
    expect(before).toContain('description:');
    expect(before).not.toContain('intro:');

    await memoryIntroMigration(ctx);

    const after = readFileSync(filePath, 'utf8');
    expect(after).toContain('intro: 存量摘要');
    expect(after).not.toMatch(/^description:/m);
    // 其他字段保留
    expect(after).toContain('name: legacy-a');
    expect(after).toContain('type: user');
    expect(after).toContain('evolvable: true');
    expect(after).toContain('存量正文A');
    // 备份文件存在
    expect(existsSync(`${filePath}.pre-intro.bak`)).toBe(true);
    expect(readFileSync(`${filePath}.pre-intro.bak`, 'utf8')).toBe(before);
  });

  it('幂等：二次运行已是 intro → no-op（不改内容、不重复备份）', async () => {
    const filePath = seedSessionMemory('sid-2', MIGRATED_FM);
    const before = readFileSync(filePath, 'utf8');

    await memoryIntroMigration(ctx);

    const after = readFileSync(filePath, 'utf8');
    expect(after).toBe(before); // 内容不变
    expect(existsSync(`${filePath}.pre-intro.bak`)).toBe(false); // 不备份
  });

  it('混合：存量 + 已迁移共存于同一文件 → 只迁存量，已迁移不动', async () => {
    const filePath = seedSessionMemory('sid-3', `${LEGACY_FM}\n${MIGRATED_FM}`);
    await memoryIntroMigration(ctx);
    const after = readFileSync(filePath, 'utf8');

    // 存量条目 description 改成 intro
    expect(after).toContain('intro: 存量摘要');
    expect(after).not.toMatch(/^description:/m);
    // 已迁移条目 intro 保留
    expect(after).toContain('intro: 已迁移');
    // 备份（因至少有一条 description，整文件被改写 → 备份）
    expect(existsSync(`${filePath}.pre-intro.bak`)).toBe(true);
  });

  it('session_memory.md 不存在 → no-op', async () => {
    mkdirSync(join(tmpDataDir, 'sessions', 'empty-sid'), { recursive: true });
    await expect(memoryIntroMigration(ctx)).resolves.toBeUndefined();
  });

  it('sessions/ 目录不存在 → no-op', async () => {
    await expect(memoryIntroMigration(ctx)).resolves.toBeUndefined();
  });
});

describe('memoryIntroMigration — user_memory record 介质', () => {
  it('entries[].description → intro + set 回写', async () => {
    appConfig.set('user_memory', 'default', {
      entries: [
        { name: 'a', description: 'da', type: 'user', body: 'ba', evolvable: true },
        { name: 'b', description: 'db', type: 'feedback', body: 'bb', evolvable: false },
      ],
    });
    const setSpy = vi.spyOn(appConfig, 'set');

    await memoryIntroMigration(ctx);

    expect(setSpy).toHaveBeenCalled();
    const after = appConfig.get('user_memory', 'default') as {
      entries: Array<Record<string, unknown>>;
    };
    expect(after.entries[0]!.intro).toBe('da');
    expect('description' in after.entries[0]!).toBe(false);
    expect(after.entries[1]!.intro).toBe('db');
    expect('description' in after.entries[1]!).toBe(false);
  });

  it('非破坏：其他字段（type/body/why/howToApply/archived/evolvable）保留', async () => {
    appConfig.set('user_memory', 'default', {
      entries: [
        {
          name: 'keep',
          description: '原摘要',
          type: 'project',
          body: '保留body',
          why: '保留why',
          howToApply: '保留how',
          archived: true,
          evolvable: false,
        },
      ],
    });

    await memoryIntroMigration(ctx);

    const after = appConfig.get('user_memory', 'default') as {
      entries: Array<Record<string, unknown>>;
    };
    const e = after.entries[0]!;
    expect(e.intro).toBe('原摘要');
    expect(e.name).toBe('keep');
    expect(e.type).toBe('project');
    expect(e.body).toBe('保留body');
    expect(e.why).toBe('保留why');
    expect(e.howToApply).toBe('保留how');
    expect(e.archived).toBe(true);
    expect(e.evolvable).toBe(false);
  });

  it('intro 已有值 → 不被 description 覆盖（存量 intro 优先）', async () => {
    appConfig.set('user_memory', 'default', {
      entries: [
        { name: 'x', intro: '已有intro', description: '应被忽略', type: 'user', body: 'b' },
      ],
    });

    await memoryIntroMigration(ctx);

    const after = appConfig.get('user_memory', 'default') as {
      entries: Array<Record<string, unknown>>;
    };
    expect(after.entries[0]!.intro).toBe('已有intro');
    expect('description' in after.entries[0]!).toBe(false);
  });

  it('幂等：record 已是 intro（无 description）→ no-op（不 set）', async () => {
    appConfig.set('user_memory', 'default', {
      entries: [{ name: 'done', intro: 'i', type: 'user', body: 'b' }],
    });
    const setSpy = vi.spyOn(appConfig, 'set');

    await memoryIntroMigration(ctx);

    expect(setSpy).not.toHaveBeenCalled();
  });

  it('record 不存在 → no-op', async () => {
    const setSpy = vi.spyOn(appConfig, 'set');
    await memoryIntroMigration(ctx);
    expect(setSpy).not.toHaveBeenCalled();
    expect(appConfig.get('user_memory', 'default')).toBeUndefined();
  });

  it('record.entries 为空数组 → no-op', async () => {
    appConfig.set('user_memory', 'default', { entries: [] });
    const setSpy = vi.spyOn(appConfig, 'set');
    await memoryIntroMigration(ctx);
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('memoryIntroMigration — 两介质协同', () => {
  it('两介质都含 description → 都被迁', async () => {
    appConfig.set('user_memory', 'default', {
      entries: [{ name: 'u', description: 'du', type: 'user', body: 'bu' }],
    });
    const sessionFile = seedSessionMemory('sid-both', LEGACY_FM);

    await memoryIntroMigration(ctx);

    // user_memory record 被迁
    const rec = appConfig.get('user_memory', 'default') as {
      entries: Array<Record<string, unknown>>;
    };
    expect(rec.entries[0]!.intro).toBe('du');
    // session md 被迁
    const after = readFileSync(sessionFile, 'utf8');
    expect(after).toContain('intro: 存量摘要');
  });
});
