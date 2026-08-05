/**
 * memory 三 mapper 协同（含 group）单测（v0.0.205 squad→group 改名 + dir store 三源）
 * 参考: specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4
 *
 * 与 memory-quota.test.ts 的分工：memory-quota.test.ts 覆盖两 mapper 协同（无 group 源）；
 * 本文件专测三 mapper 协同（含 group 源，squad 派生）。
 *
 * 覆盖：
 *   - group 依赖缺失 → memory_group 空贡献；memory_user/session 不受影响
 *   - squadId 有 → 三 mapper 都读三源；各自只输出本 scope 切片（不串扰）
 *   - 六类顺序 selection：session 占额 → group 被截；group 占额 → global 被截
 *   - fragment 契约：id='memory_group'/tier=stable/priority=400
 *   - 单一源（group-only）→ 只 memory_group 贡献
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryUserMapper, MemorySessionMapper, MemoryGroupMapper } from '../memory';
import { AppConfigService } from '../../../../../server/src/config/app-config-service';
import {
  globalMemoryDir,
  wsMemoryDir,
} from '../../../../../server/src/memory/memory-dir-store';
import { writeEntry, archiveEntry } from '../../../../../server/src/memory/memory-dir-write';
import type { PromptCtx } from '../../types';

const SQID = 'squad-alpha';

function makeCtx(opts: {
  appConfig: AppConfigService;
  dataDir: string;
  workdir?: string;
  squadId?: string;
}): PromptCtx {
  const config: Record<string, unknown> = {
    appConfig: opts.appConfig,
    dataDir: opts.dataDir,
  };
  if (opts.workdir !== undefined) config.workdir = opts.workdir;
  if (opts.squadId !== undefined) config.squadId = opts.squadId;
  return { config } as unknown as PromptCtx;
}

/** 设 memory 分层配额（写 app_config session group 三 key） */
function setMemoryQuotas(
  appConfig: AppConfigService,
  q: Partial<{ global: number; session: number; group: number }>,
): void {
  const patch: Record<string, number> = {};
  if (q.global !== undefined) patch.maxMemoryInject = q.global;
  if (q.session !== undefined) patch.maxMemoryInjectSession = q.session;
  if (q.group !== undefined) patch.maxMemoryInjectGroup = q.group;
  appConfig.set('session', 'default', patch);
}

function entryLines(content: string): string[] {
  return content.split('\n').filter((l) => l.startsWith('- '));
}

describe('memory 三 mapper 协同（v0.0.205 含 group）', () => {
  let dataDir: string;
  let appConfig: AppConfigService;
  let sessionWs: string;
  let squadMemDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memory-quota-group-'));
    appConfig = new AppConfigService({ root: dataDir });
    sessionWs = join(dataDir, 'sess-ws');
    squadMemDir = wsMemoryDir(join(dataDir, 'squads', SQID));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('group 依赖缺失（非 squad 会话）→ memory_group 空贡献；user/session 不受影响', async () => {
    await writeEntry(globalMemoryDir(dataDir), { name: 'ug', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });
    await writeEntry(wsMemoryDir(sessionWs), { name: 'us', intro: 'i', type: 'user', body: 'b' }, {});
    await writeEntry(squadMemDir, { name: 'uq', intro: 'i', type: 'user', body: 'b' }, { defaultEvolvable: true });

    // ctx 不注 squadId → memory_group 应空
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });
    expect(new MemoryGroupMapper('test').map(ctx)).toEqual([]);
    expect(new MemoryUserMapper('test').map(ctx)[0]!.content).toContain('- ug');
    expect(new MemorySessionMapper('test').map(ctx)[0]!.content).toContain('- us');
  });

  it('squadId 有 → 三 mapper 各贡献；各自只输出本 scope 切片（不串扰）', async () => {
    await writeEntry(globalMemoryDir(dataDir), { name: 'ug', intro: 'i-ug', type: 'user', body: 'b' }, { source: 'user' });
    await writeEntry(wsMemoryDir(sessionWs), { name: 'us', intro: 'i-us', type: 'user', body: 'b' }, {});
    await writeEntry(squadMemDir, { name: 'uq', intro: 'i-uq', type: 'user', body: 'b' }, { defaultEvolvable: true });

    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs, squadId: SQID });
    const userFrag = new MemoryUserMapper('test').map(ctx);
    const sessionFrag = new MemorySessionMapper('test').map(ctx);
    const groupFrag = new MemoryGroupMapper('test').map(ctx);

    expect(userFrag).toHaveLength(1);
    expect(sessionFrag).toHaveLength(1);
    expect(groupFrag).toHaveLength(1);

    expect(userFrag[0]!.content).toContain('- ug: i-ug');
    expect(userFrag[0]!.content).not.toContain('us');
    expect(userFrag[0]!.content).not.toContain('uq');
    expect(sessionFrag[0]!.content).toContain('- us: i-us');
    expect(sessionFrag[0]!.content).not.toContain('ug');
    expect(sessionFrag[0]!.content).not.toContain('uq');
    expect(groupFrag[0]!.content).toContain('- uq: i-uq');
    expect(groupFrag[0]!.content).not.toContain('ug');
    expect(groupFrag[0]!.content).not.toContain('us');
  });

  it('各 scope 独立截断（v0.0.238 分层）：session=1/group=2/global=1 互不抢占', async () => {
    await writeEntry(wsMemoryDir(sessionWs), { name: 'sm1', intro: 'i', type: 'user', body: 'b' }, {});
    await writeEntry(wsMemoryDir(sessionWs), { name: 'sm2', intro: 'i', type: 'user', body: 'b' }, {});
    await writeEntry(squadMemDir, { name: 'qm1', intro: 'i', type: 'user', body: 'b' }, { defaultEvolvable: true });
    await writeEntry(squadMemDir, { name: 'qm2', intro: 'i', type: 'user', body: 'b' }, { defaultEvolvable: true });
    await writeEntry(globalMemoryDir(dataDir), { name: 'um1', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });

    setMemoryQuotas(appConfig, { session: 1, group: 2, global: 1 });
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs, squadId: SQID });

    const sessionLines = entryLines(new MemorySessionMapper('test').map(ctx)[0]!.content);
    const groupLines = entryLines(new MemoryGroupMapper('test').map(ctx)[0]!.content);
    const userLines = entryLines(new MemoryUserMapper('test').map(ctx)[0]!.content);

    expect(sessionLines).toHaveLength(1); // session 层 quota=1（sm1/sm2 取最新）
    expect(groupLines).toHaveLength(2); // group 层 quota=2（qm1+qm2 全要）
    expect(userLines).toHaveLength(1); // global 层 quota=1
  });

  it('group 层 quota=1 截断：2 条 group entry 取最新 1', async () => {
    await writeEntry(squadMemDir, { name: 'qm1', intro: 'i', type: 'user', body: 'b' }, { defaultEvolvable: true });
    await writeEntry(squadMemDir, { name: 'qm2', intro: 'i', type: 'user', body: 'b' }, { defaultEvolvable: true });

    setMemoryQuotas(appConfig, { group: 1 });
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs, squadId: SQID });

    const groupLines = entryLines(new MemoryGroupMapper('test').map(ctx)[0]!.content);
    expect(groupLines).toHaveLength(1);
  });

  it('三层配额均 0 → 三 mapper 均不贡献', async () => {
    await writeEntry(globalMemoryDir(dataDir), { name: 'u1', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });
    await writeEntry(wsMemoryDir(sessionWs), { name: 's1', intro: 'i', type: 'user', body: 'b' }, {});
    await writeEntry(squadMemDir, { name: 'q1', intro: 'i', type: 'user', body: 'b' }, { defaultEvolvable: true });

    setMemoryQuotas(appConfig, { global: 0, session: 0, group: 0 });
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs, squadId: SQID });

    expect(new MemoryUserMapper('test').map(ctx)).toEqual([]);
    expect(new MemorySessionMapper('test').map(ctx)).toEqual([]);
    expect(new MemoryGroupMapper('test').map(ctx)).toEqual([]);
  });

  it('三源均空 → 三 mapper 均不贡献', () => {
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs, squadId: SQID });
    expect(new MemoryUserMapper('test').map(ctx)).toEqual([]);
    expect(new MemorySessionMapper('test').map(ctx)).toEqual([]);
    expect(new MemoryGroupMapper('test').map(ctx)).toEqual([]);
  });

  it('group-only 源（无 global/session）→ 只 memory_group 贡献', async () => {
    await writeEntry(squadMemDir, { name: 'q1', intro: 'i', type: 'user', body: 'b' }, { defaultEvolvable: true });
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs, squadId: SQID });
    expect(new MemoryUserMapper('test').map(ctx)).toEqual([]);
    expect(new MemorySessionMapper('test').map(ctx)).toEqual([]);
    expect(new MemoryGroupMapper('test').map(ctx)[0]!.content).toContain('- q1');
  });

  it('fragment 契约：memory_group = id/tier=stable/priority=400', async () => {
    await writeEntry(squadMemDir, { name: 'q1', intro: 'i', type: 'user', body: 'b' }, { defaultEvolvable: true });
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs, squadId: SQID });
    const frag = new MemoryGroupMapper('test').map(ctx)[0]!;
    expect(frag.id).toBe('memory_group');
    expect(frag.tier).toBe('stable');
    expect(frag.priority).toBe(400);
  });

  it('archived group entry 被过滤（不进 memory_group L0）', async () => {
    await writeEntry(squadMemDir, { name: 'q-active', intro: 'i', type: 'user', body: 'b' }, { defaultEvolvable: true });
    await writeEntry(squadMemDir, { name: 'q-arch', intro: 'i', type: 'user', body: 'b' }, { defaultEvolvable: true });
    await archiveEntry(squadMemDir, 'q-arch');

    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs, squadId: SQID });
    const content = new MemoryGroupMapper('test').map(ctx)[0]!.content;
    expect(content).toContain('- q-active');
    expect(content).not.toContain('q-arch');
  });
});
