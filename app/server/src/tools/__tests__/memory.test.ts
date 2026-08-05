/**
 * memory 纯读工具单测（v0.0.205 统一 scope + dir store）
 * 参考: specs/tech/agent/memory/[P0]memory_tool.md §2-§6
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4
 *
 * 覆盖：
 *   - memoryTool.run read/search 分派（scope 直通：global/session/group）
 *   - 介质定位：global→<dataDir>/memory/、session→<workdir>/.rocky/memory/、group→group ws
 *   - 依赖缺失错误（session 缺 workdir → RUNTIME_ERROR；group 缺依赖 → not_in_group）
 *   - 校验错误（invalid action / 缺 name/keyword / not_found）+ search 不返 body（不变量#5）
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + process.env.DATA_DIR 覆盖（resolveDataDir 读取）+ afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryTool } from '../memory';
import { textOf } from './_helpers';
import {
  globalMemoryDir,
  wsMemoryDir,
} from '../../memory/memory-dir-store';
import { writeEntry } from '../../memory/memory-dir-write';

let tmpDataDir: string;
let origDataDir: string | undefined;
let sessionWs: string;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'mem-tool-read-test-'));
  origDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDataDir;
  sessionWs = join(tmpDataDir, 'sess-ws');
});

afterEach(() => {
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
  rmSync(tmpDataDir, { recursive: true, force: true });
});

/** 构造 ToolCtx（workdir 入 ctx.config；squadId 供 group 解析） */
function ctxOf(opts: { workdir?: string; squadId?: string } = {}): {
  config: Record<string, unknown>;
  workdir: string;
} {
  const config: Record<string, unknown> = { tools: [] };
  if (opts.workdir !== undefined) config.workdir = opts.workdir;
  if (opts.squadId !== undefined) config.squadId = opts.squadId;
  return { config, workdir: tmpDataDir };
}

describe('memoryTool.run — read 分派 + scope 直通', () => {
  it('read scope=global → 读 <dataDir>/memory/ 返完整正文，scope 回显 global', async () => {
    await writeEntry(globalMemoryDir(tmpDataDir), {
      name: 'g1', intro: 'gd', type: 'feedback', body: 'full body marker', why: 'w', howToApply: 'h',
    }, {});
    const res = await memoryTool.run({ action: 'read', scope: 'global', name: 'g1' }, ctxOf() as never);
    expect(res.isError).toBe(false);
    const p = JSON.parse(textOf(res));
    expect(p.action).toBe('read');
    expect(p.scope).toBe('global');
    expect(p.entry.scope).toBe('global');
    expect(p.entry.body).toBe('full body marker');
    expect(p.entry.why).toBe('w');
  });

  it('read scope=session → 读 <workdir>/.rocky/memory/，scope 回显 session', async () => {
    await writeEntry(wsMemoryDir(sessionWs), { name: 's1', intro: 'sd', type: 'project', body: 'session marker' }, {});
    const res = await memoryTool.run({ action: 'read', scope: 'session', name: 's1' }, ctxOf({ workdir: sessionWs }) as never);
    expect(res.isError).toBe(false);
    const p = JSON.parse(textOf(res));
    expect(p.scope).toBe('session');
    expect(p.entry.body).toBe('session marker');
  });

  it('read scope=group → 读 <squadWs>/.rocky/memory/（squadId 派生），scope 回显 group', async () => {
    const squadWs = join(tmpDataDir, 'squads', 'sq-1');
    await writeEntry(wsMemoryDir(squadWs), { name: 'q1', intro: 'qd', type: 'project', body: 'group marker' }, {});
    const res = await memoryTool.run({ action: 'read', scope: 'group', name: 'q1' }, ctxOf({ squadId: 'sq-1' }) as never);
    expect(res.isError).toBe(false);
    const p = JSON.parse(textOf(res));
    expect(p.scope).toBe('group');
    expect(p.entry.body).toBe('group marker');
  });

  it('read 省略 scope → 跨 scope（先 session 后 global），回显命中 scope', async () => {
    await writeEntry(globalMemoryDir(tmpDataDir), { name: 'only-global', intro: 'd', type: 'user', body: 'ub' }, {});
    const res = await memoryTool.run({ action: 'read', name: 'only-global' }, ctxOf({ workdir: sessionWs }) as never);
    expect(res.isError).toBe(false);
    expect(JSON.parse(textOf(res)).scope).toBe('global');
  });

  it('read 未命中 → isError NOT_FOUND', async () => {
    const res = await memoryTool.run({ action: 'read', scope: 'global', name: 'ghost' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not_found|not found/i);
  });

  it('read 缺 name → isError INVALID_INPUT', async () => {
    const res = await memoryTool.run({ action: 'read', scope: 'global' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/invalid_input/i);
    expect(textOf(res)).toMatch(/name/i);
  });

  it('read scope=session 缺 workdir → isError RUNTIME_ERROR', async () => {
    const res = await memoryTool.run({ action: 'read', scope: 'session', name: 'x' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/runtime_error/i);
    expect(textOf(res)).toMatch(/workdir/i);
  });

  it('read scope=group 无 squad → isError not_in_group', async () => {
    const res = await memoryTool.run({ action: 'read', scope: 'group', name: 'x' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/invalid_input/i);
    expect(textOf(res)).toMatch(/not_in_group/i);
  });
});

describe('memoryTool.run — search 分派 + 不返 body', () => {
  it('search 命中 body 关键词 → 返 name+intro 不含 body', async () => {
    await writeEntry(globalMemoryDir(tmpDataDir), {
      name: 'sk', intro: 'visible desc', type: 'user', body: 'locateme plus HIDDENBODY secret',
    }, {});
    const res = await memoryTool.run({ action: 'search', scope: 'global', keyword: 'locateme' }, ctxOf() as never);
    expect(res.isError).toBe(false);
    const p = JSON.parse(textOf(res));
    expect(p.action).toBe('search');
    expect(p.count).toBe(1);
    const m = p.entries[0];
    expect(m.name).toBe('sk');
    expect(m.intro).toBe('visible desc');
    expect(m.scope).toBe('global');
    expect(m.body).toBeUndefined(); // search 不倒正文（不变量#5）
    expect(textOf(res)).not.toMatch(/HIDDENBODY/i);
  });

  it('search 跨 scope 合并 session+global（不含 group，隔离 invariant）', async () => {
    await writeEntry(globalMemoryDir(tmpDataDir), { name: 'g-hit', intro: 'd', type: 'user', body: 'shared-kw' }, {});
    await writeEntry(wsMemoryDir(sessionWs), { name: 's-hit', intro: 'd', type: 'user', body: 'shared-kw' }, {});
    await writeEntry(wsMemoryDir(join(tmpDataDir, 'squads', 'sq-1')), { name: 'q-hit', intro: 'd', type: 'user', body: 'shared-kw' }, {});
    const res = await memoryTool.run(
      { action: 'search', keyword: 'shared-kw' },
      ctxOf({ workdir: sessionWs, squadId: 'sq-1' }) as never,
    );
    const names = JSON.parse(textOf(res)).entries.map((e: { name: string }) => e.name).sort();
    expect(names).toEqual(['g-hit', 's-hit']); // group 不进跨 scope
  });

  it('search 缺 keyword → isError INVALID_INPUT', async () => {
    const res = await memoryTool.run({ action: 'search', scope: 'global' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/keyword/i);
  });
});

describe('memoryTool.run — 通用校验', () => {
  it('非法 action（write 属写侧，纯读工具拒绝）→ isError INVALID_INPUT', async () => {
    const res = await memoryTool.run({ action: 'write' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/action must be one of read\|search/i);
  });

  it('非法 scope 值（squad 旧命名）→ isError INVALID_INPUT', async () => {
    const res = await memoryTool.run({ action: 'read', scope: 'squad', name: 'x' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/scope must be one of global\|session\|group/i);
  });

  it('definition：name=memory + action enum read/search + scope enum global/session/group', () => {
    expect(memoryTool.definition.name).toBe('memory');
    const props = memoryTool.definition.inputSchema.properties!;
    expect((props.action as { enum: string[] }).enum).toEqual(['read', 'search']);
    expect((props.scope as { enum: string[] }).enum).toEqual(['global', 'session', 'group']);
    expect(memoryTool.definition.inputSchema.required).toEqual(['action']);
  });
});
