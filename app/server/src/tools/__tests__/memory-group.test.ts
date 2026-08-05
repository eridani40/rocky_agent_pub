/**
 * memory 纯读工具 group scope 单测（v0.0.205 squad→group 改名）
 * 参考: specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4
 *
 * 覆盖：
 *   - inputSchema.scope.enum 含 'group'
 *   - read/search group 无 squadId → [invalid_input] not_in_group
 *   - read/search group 有 squadId → 命中 group 介质（scope 回显 group）
 *   - undefined scope（跨 scope 兜底）**不含 group**（隔离 invariant——search 只 merge session+global）
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + process.env.DATA_DIR 覆盖 + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryTool } from '../memory';
import { textOf } from './_helpers';
import {
  wsMemoryDir,
} from '../../memory/memory-dir-store';
import { writeEntry } from '../../memory/memory-dir-write';

let tmpDataDir: string;
let origDataDir: string | undefined;
let sessionWs: string;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'mem-tool-group-read-'));
  origDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDataDir;
  sessionWs = join(tmpDataDir, 'sess-ws');
});

afterEach(() => {
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
  rmSync(tmpDataDir, { recursive: true, force: true });
});

function ctxOf(opts: { workdir?: string; squadId?: string } = {}): {
  config: Record<string, unknown>;
  workdir: string;
} {
  const config: Record<string, unknown> = { tools: [] };
  if (opts.workdir !== undefined) config.workdir = opts.workdir;
  if (opts.squadId !== undefined) config.squadId = opts.squadId;
  return { config, workdir: tmpDataDir };
}

const SQID = 'squad-alpha';
const squadMemDir = () => wsMemoryDir(join(tmpDataDir, 'squads', SQID));

describe('memory 工具 — group scope', () => {
  it('inputSchema.scope.enum = [global, session, group]', () => {
    const props = (memoryTool.definition.inputSchema as {
      properties: { scope: { enum: string[] } };
    }).properties;
    expect(props.scope.enum).toEqual(['global', 'session', 'group']);
  });

  it('read group 无 squadId → [invalid_input] not_in_group', async () => {
    const res = await memoryTool.run({ action: 'read', scope: 'group', name: 'x' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('[invalid_input] not_in_group');
  });

  it('read group 有 squadId → 单条全文（scope 回显 group）', async () => {
    await writeEntry(squadMemDir(), { name: 'r', intro: 'i', type: 'user', body: 'gb' }, {});
    const res = await memoryTool.run(
      { action: 'read', scope: 'group', name: 'r' },
      ctxOf({ squadId: SQID }) as never,
    );
    expect(res.isError).toBe(false);
    const payload = JSON.parse(textOf(res));
    expect(payload.scope).toBe('group');
    expect(payload.entry.body).toBe('gb');
    expect(payload.entry.scope).toBe('group');
  });

  it('search group 无 squadId → [invalid_input] not_in_group', async () => {
    const res = await memoryTool.run({ action: 'search', scope: 'group', keyword: 'k' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('[invalid_input] not_in_group');
  });

  it('search group 有 squadId → 命中 group 内条目（scope=group）', async () => {
    await writeEntry(squadMemDir(), { name: 'k-hit', intro: 'i', type: 'user', body: 'needle-marker' }, {});
    const res = await memoryTool.run(
      { action: 'search', scope: 'group', keyword: 'needle-marker' },
      ctxOf({ squadId: SQID }) as never,
    );
    const payload = JSON.parse(textOf(res));
    expect(payload.count).toBe(1);
    expect(payload.entries[0]).toMatchObject({ name: 'k-hit', scope: 'group' });
  });

  it('跨 scope 兜底不含 group（隔离 invariant——search 只 merge session+global）', async () => {
    await writeEntry(squadMemDir(), { name: 'q-only', intro: 'i', type: 'user', body: 'cross-kw' }, {});
    await writeEntry(wsMemoryDir(sessionWs), { name: 's-hit', intro: 'i', type: 'user', body: 'cross-kw' }, {});
    const res = await memoryTool.run(
      { action: 'search', keyword: 'cross-kw' },
      ctxOf({ workdir: sessionWs, squadId: SQID }) as never,
    );
    const payload = JSON.parse(textOf(res));
    const names = payload.entries.map((e: { name: string }) => e.name);
    expect(names).toEqual(['s-hit']); // group 的 q-only 不进跨 scope
  });
});
