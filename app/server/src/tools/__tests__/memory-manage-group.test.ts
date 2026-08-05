/**
 * memory_manage 工具 group scope 单测（v0.0.205 squad→group 改名）
 * 参考: specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4
 *       PRD 用户拍板 2026-07-17（延续）：无 group 会话 scope='group' → [invalid_input] not_in_group
 *
 * 覆盖：
 *   - write / archive / read / list 显式 'group' 无 squadId → [invalid_input] not_in_group
 *   - write / archive / read / list 显式 'group' 有 squadId → 落 <squadWs>/.rocky/memory/ per-entry
 *   - list 'all' 无 group 依赖 → 软取（group 段静默跳过）；有依赖 → merge 3 scope
 *   - scope enum 含 'group'（inputSchema）+ description 提及 not_in_group 锚点
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + process.env.DATA_DIR 覆盖 + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryManageTool } from '../memory-manage';
import { textOf } from './_helpers';
import {
  listMetas,
  wsMemoryDir,
} from '../../memory/memory-dir-store';
import { writeEntry } from '../../memory/memory-dir-write';

let tmpDataDir: string;
let origDataDir: string | undefined;
let sessionWs: string;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'mem-tool-group-'));
  origDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDataDir;
  sessionWs = join(tmpDataDir, 'sess-ws');
});

afterEach(() => {
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
  rmSync(tmpDataDir, { recursive: true, force: true });
});

/** 造 ToolCtx；workdir=session 介质定位；squadId 供 group 解析；biz 默认 studio（group 可用） */
function ctxOf(opts: { workdir?: string; squadId?: string; biz?: string } = {}): {
  config: Record<string, unknown>;
  workdir: string;
} {
  const config: Record<string, unknown> = { tools: [] };
  if (opts.workdir !== undefined) config.workdir = opts.workdir;
  if (opts.squadId !== undefined) config.squadId = opts.squadId;
  // v0.0.238：group 写侧需 biz=studio|academy；测试默认 studio（group 可用）
  config.kind = { biz: opts.biz ?? 'studio' };
  return { config, workdir: tmpDataDir };
}

const SQID = 'squad-alpha';
const squadMemDir = () => wsMemoryDir(join(tmpDataDir, 'squads', SQID));

describe('memory_manage — inputSchema.scope.enum 含 group', () => {
  it('scope enum = [global, session, group, all]', () => {
    const props = (memoryManageTool.definition.inputSchema as {
      properties: { scope: { enum: string[] } };
    }).properties;
    expect(props.scope.enum).toEqual(['global', 'session', 'group', 'all']);
  });

  it('description 提及 not_in_group 错误锚点（供 LLM 自修正）', () => {
    const desc = (memoryManageTool.definition.inputSchema as {
      properties: { scope: { description: string } };
    }).properties.scope.description;
    expect(desc).toMatch(/not_in_group/);
  });
});

describe('memory_manage — group 分支无依赖 → not_in_group（非 RUNTIME_ERROR）', () => {
  it('write group 无 squadId → [invalid_input] not_in_group', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'group', entry: { name: 'x', intro: 'i', type: 'user', body: 'b' } },
      ctxOf() as never,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('[invalid_input] not_in_group');
  });

  it('archive group 无依赖 → [invalid_input] not_in_group', async () => {
    const res = await memoryManageTool.run({ action: 'archive', scope: 'group', name: 'x' }, ctxOf() as never);
    expect(textOf(res)).toBe('[invalid_input] not_in_group');
  });

  it('read group 无依赖 → [invalid_input] not_in_group', async () => {
    const res = await memoryManageTool.run({ action: 'read', scope: 'group', name: 'x' }, ctxOf() as never);
    expect(textOf(res)).toBe('[invalid_input] not_in_group');
  });

  it('list 显式 group 无依赖 → [invalid_input] not_in_group', async () => {
    const res = await memoryManageTool.run({ action: 'list', scope: 'group' }, ctxOf() as never);
    expect(textOf(res)).toBe('[invalid_input] not_in_group');
  });
});

describe('memory_manage — group 分支有 squadId → 落 <squadWs>/.rocky/memory/ per-entry', () => {
  it('write group → 落 per-entry 文件（scope 回显 group）', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'group', entry: { name: 'rule-1', intro: 'i', type: 'user', body: 'b' } },
      ctxOf({ squadId: SQID }) as never,
    );
    expect(res.isError).toBe(false);
    const payload = JSON.parse(textOf(res));
    expect(payload).toMatchObject({ ok: true, action: 'write', scope: 'group' });
    // 落盘可读（per-entry 文件）
    expect(listMetas(squadMemDir()).map((m) => m.name)).toEqual(['rule-1']);
  });

  it('archive group → 标 archived=true', async () => {
    await memoryManageTool.run(
      { action: 'write', scope: 'group', entry: { name: 'r', intro: 'i', type: 'user', body: 'b' } },
      ctxOf({ squadId: SQID }) as never,
    );
    const res = await memoryManageTool.run(
      { action: 'archive', scope: 'group', name: 'r' },
      ctxOf({ squadId: SQID }) as never,
    );
    const payload = JSON.parse(textOf(res));
    expect(payload).toMatchObject({ ok: true, action: 'archive', scope: 'group' });
    expect(payload.entry.archived).toBe(true);
  });

  it('read group → 单条全文（scope 回显 group）', async () => {
    await writeEntry(squadMemDir(), { name: 'r', intro: 'i', type: 'user', body: 'bb' }, { defaultEvolvable: true });
    const res = await memoryManageTool.run(
      { action: 'read', scope: 'group', name: 'r' },
      ctxOf({ squadId: SQID }) as never,
    );
    const payload = JSON.parse(textOf(res));
    expect(payload).toMatchObject({ action: 'read', scope: 'group' });
    expect(payload.entry.body).toBe('bb');
    expect(payload.entry.scope).toBe('group');
  });

  it('list 显式 group → 只返 group entries（scope=group）', async () => {
    await writeEntry(squadMemDir(), { name: 'sq-1', intro: 'i', type: 'user', body: 'b' }, {});
    const res = await memoryManageTool.run({ action: 'list', scope: 'group' }, ctxOf({ squadId: SQID }) as never);
    const payload = JSON.parse(textOf(res));
    expect(payload.scope).toBe('group');
    expect(payload.entries.length).toBe(1);
    expect(payload.entries[0].scope).toBe('group');
  });
});

describe('memory_manage — list all merge 3 scope', () => {
  it('list all 无 group 依赖 → 软取（group 段静默跳过，global/session 仍生效）', async () => {
    await writeEntry(join(tmpDataDir, 'memory'), { name: 'ug', intro: 'i', type: 'user', body: 'b' }, {});
    await writeEntry(wsMemoryDir(sessionWs), { name: 'us', intro: 'i', type: 'user', body: 'b' }, {});
    const res = await memoryManageTool.run(
      { action: 'list', scope: 'all' },
      ctxOf({ workdir: sessionWs }) as never,
    );
    const payload = JSON.parse(textOf(res));
    expect(payload.scope).toBe('all');
    const names = payload.entries.map((e: { name: string }) => e.name).sort();
    expect(names).toEqual(['ug', 'us']);
    expect(payload.entries.every((e: { scope: string }) => e.scope !== 'group')).toBe(true);
  });

  it('list all 有 squadId → merge global + session + group', async () => {
    await writeEntry(join(tmpDataDir, 'memory'), { name: 'ug', intro: 'i', type: 'user', body: 'b' }, {});
    await writeEntry(wsMemoryDir(sessionWs), { name: 'us', intro: 'i', type: 'user', body: 'b' }, {});
    await writeEntry(squadMemDir(), { name: 'uq', intro: 'i', type: 'user', body: 'b' }, {});
    const res = await memoryManageTool.run(
      { action: 'list', scope: 'all' },
      ctxOf({ workdir: sessionWs, squadId: SQID }) as never,
    );
    const payload = JSON.parse(textOf(res));
    const bucketByScope: Record<string, string[]> = {};
    for (const e of payload.entries as Array<{ name: string; scope: string }>) {
      (bucketByScope[e.scope] ??= []).push(e.name);
    }
    expect(bucketByScope.global?.sort()).toEqual(['ug']);
    expect(bucketByScope.session?.sort()).toEqual(['us']);
    expect(bucketByScope.group?.sort()).toEqual(['uq']);
  });
});
