/**
 * memory 注入 L0 单测（v0.0.205 存储统一后：dir store 三源，只注入 name+intro，正文按需读）
 * 参考: specs/tech/agent/memory/[P0]memory_injection.md §3（L0 注入 + 读正文引导）
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4
 *
 * 覆盖：
 *   - formatL0 输出只含 name+intro，无 body/why/howToApply（不变量#5）
 *   - MemoryUserMapper 走 listMetas(globalMemoryDir(dataDir)) → L0 fragment（tier=stable，priority 450）
 *   - MemorySessionMapper 走 listMetas(wsMemoryDir(workdir)) 过滤 !archived → L0 fragment（不读 body；archived 跳过）
 *   - 末尾含读正文引导「Use the `memory` tool ...」
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryUserMapper, MemorySessionMapper, MemoryGroupMapper } from '../prompt/memory';
import {
  globalMemoryDir,
  wsMemoryDir,
} from '../../../../server/src/memory/memory-dir-store';
import { writeEntry, archiveEntry } from '../../../../server/src/memory/memory-dir-write';

const READ_HINT = "Use the `memory` tool to read a memory's full body by name.";

let tmpDataDir: string;
let sessionWs: string;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'mem-inj-l0-'));
  sessionWs = join(tmpDataDir, 'sess-ws');
});
afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

/** 构造 PromptCtx（按需注 dataDir / workdir） */
function mkCtx(overrides: Record<string, unknown> = {}): { config: Record<string, unknown> } {
  return { config: { modelId: 'm', client: { contextWindow: 100000 }, ...overrides } };
}

describe('memory 注入 L0（MemoryUserMapper）', () => {
  it('无 dataDir → 空贡献', () => {
    expect(new MemoryUserMapper('memory_user', {}).map(mkCtx())).toEqual([]);
  });

  it('global memory → L0 fragment（只含 name+intro，无正文）', async () => {
    await writeEntry(globalMemoryDir(tmpDataDir), {
      name: 'prefers-terse',
      intro: 'User prefers terse replies',
      type: 'user',
      body: 'SECRET_BODY_LONG_TEXT should NOT be injected',
      why: 'SECRET_WHY',
      howToApply: 'SECRET_HOWTO',
    }, {});
    const out = new MemoryUserMapper('memory_user', {}).map(mkCtx({ dataDir: tmpDataDir }));
    expect(out).toHaveLength(1);
    const frag = out[0]!;
    expect(frag.id).toBe('memory_user');
    expect(frag.tier).toBe('stable');
    expect(frag.priority).toBe(450);
    // L0：header + 列表项 name: intro
    expect(frag.content).toContain('# Long-term User Memory');
    expect(frag.content).toContain('- prefers-terse: User prefers terse replies');
    // 正文/why/howToApply 绝不注入（不变量#5）
    expect(frag.content).not.toContain('SECRET_BODY_LONG_TEXT');
    expect(frag.content).not.toContain('SECRET_WHY');
    expect(frag.content).not.toContain('SECRET_HOWTO');
    // 读正文引导
    expect(frag.content).toContain(READ_HINT);
  });
});

describe('memory 注入 L0（MemorySessionMapper）', () => {
  it('无 dataDir/workdir → 空贡献', () => {
    expect(new MemorySessionMapper('memory_session', {}).map(mkCtx())).toEqual([]);
    expect(new MemorySessionMapper('memory_session', {}).map(mkCtx({ dataDir: tmpDataDir }))).toEqual([]);
  });

  it('session memory → L0 fragment（listMetas 不读 body；archived 跳过）', async () => {
    await writeEntry(wsMemoryDir(sessionWs), {
      name: 'active-note',
      intro: 'An active session note',
      type: 'project',
      body: 'SESSION_SECRET_BODY not injected',
    }, {});
    await writeEntry(wsMemoryDir(sessionWs), {
      name: 'stale-note',
      intro: 'A stale note',
      type: 'project',
      body: 'stale body',
    }, {});
    await archiveEntry(wsMemoryDir(sessionWs), 'stale-note'); // 归档 → 应被过滤

    const out = new MemorySessionMapper('memory_session', {}).map(
      mkCtx({ dataDir: tmpDataDir, workdir: sessionWs }),
    );
    expect(out).toHaveLength(1);
    const frag = out[0]!;
    expect(frag.id).toBe('memory_session');
    expect(frag.tier).toBe('context');
    expect(frag.priority).toBe(350);
    expect(frag.content).toContain('# Session Memory');
    expect(frag.content).toContain('- active-note: An active session note');
    // archived 条目不注入
    expect(frag.content).not.toContain('stale-note');
    // 正文不注入（listMetas 元数据级）
    expect(frag.content).not.toContain('SESSION_SECRET_BODY');
    expect(frag.content).toContain(READ_HINT);
  });

  it('全 archived → 空贡献（不注入空 fragment）', async () => {
    await writeEntry(wsMemoryDir(sessionWs), {
      name: 'only-one', intro: 'd', type: 'project', body: 'b',
    }, {});
    await archiveEntry(wsMemoryDir(sessionWs), 'only-one');
    const out = new MemorySessionMapper('memory_session', {}).map(
      mkCtx({ dataDir: tmpDataDir, workdir: sessionWs }),
    );
    expect(out).toEqual([]);
  });
});

// v0.0.232 同址去重：squad session 删个人 ws 后 workdir == groupWs（都指向 squads/{sid}/），
// session 源与 group 源物理同目录 → readMemorySources 跳过 session 源，避免双注入。
describe('memory 同址去重（workdir === groupWs）', () => {
  it('workdir == groupWs → session 源跳过（memory_session 空），group 单份注入', async () => {
    const groupWs = join(tmpDataDir, 'squads', 'SQ1');
    await writeEntry(wsMemoryDir(groupWs), {
      name: 'team-note',
      intro: 'shared squad note',
      type: 'project',
      body: 'TEAM_BODY',
    }, {});

    const ctxSame = mkCtx({
      dataDir: tmpDataDir,
      workdir: groupWs, // === groupWs（squad session 删个人 ws 后的常态）
      squadId: 'SQ1',
    });
    // session 源被跳过 → selectMemoriesByQuota 的 session 切片为空 → memory_session 空贡献
    expect(new MemorySessionMapper('memory_session', {}).map(ctxSame)).toEqual([]);
    // group 单份注入（不双份）
    const groupOut = new MemoryGroupMapper('memory_group', {}).map(ctxSame);
    expect(groupOut).toHaveLength(1);
    expect(groupOut[0]!.content).toContain('- team-note: shared squad note');
  });

  it('workdir != groupWs（存量旧 session）→ session/group 各读各的（行为不变）', async () => {
    const groupWs = join(tmpDataDir, 'squads', 'SQ1');
    // 旧 session workdir 与 groupWs 不同址
    await writeEntry(wsMemoryDir(sessionWs), {
      name: 'old-session-note', intro: 'session only', type: 'project', body: 'b',
    }, {});
    await writeEntry(wsMemoryDir(groupWs), {
      name: 'team-note', intro: 'group only', type: 'project', body: 'b',
    }, {});

    const ctxLegacy = mkCtx({
      dataDir: tmpDataDir,
      workdir: sessionWs, // !== groupWs
      squadId: 'SQ1',
    });
    const sessionOut = new MemorySessionMapper('memory_session', {}).map(ctxLegacy);
    expect(sessionOut[0]!.content).toContain('old-session-note');
    const groupOut = new MemoryGroupMapper('memory_group', {}).map(ctxLegacy);
    expect(groupOut[0]!.content).toContain('team-note');
  });
});
