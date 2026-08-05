/**
 * skill 读工具单测 — 寻址 + not found + 全文返回
 * 参考: specs/tech/agent/skills/[P0]skill_tool.md §3 §4
 *       specs/tech/agent/skills/[P0]skill_architecture.md §9
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { skillTool } from '../../tools/skill';
import { appSkillRoot } from '../../skills/resolver';
import type { ToolCtx } from '../../tools/types';

function makeCtx(skillsEntries: unknown[]): ToolCtx {
  return {
    config: { tools: [skillTool], skills: { entries: skillsEntries } } as unknown as ToolCtx['config'],
    workdir: '/tmp',
  };
}

describe('skill tool', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-skill-tool-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('name 必填，空 → invalid_input', async () => {
    const r = await skillTool.run({}, makeCtx([]));
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ type: 'text' });
    expect((r.content[0] as { text: string }).text).toContain('invalid_input');
  });

  it('catalog 不含 name → NOT_FOUND', async () => {
    const r = await skillTool.run({ name: 'missing' }, makeCtx([]));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('not found');
  });

  it('命中 → 返回 name + skillDir + scope(回显 external) + body', async () => {
    const skillDir = join(appSkillRoot(dataDir), 'demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'),
      '---\nname: demo\ndescription: d\n---\n\n# demo\n\nfull body', 'utf8');
    // catalog entry 用内部 scope（app）；工具输出回显 external（global，不变量#1）
    const entries = [{ name: 'demo', skillDir, scope: 'app' }];
    const r = await skillTool.run({ name: 'demo' }, makeCtx(entries));
    expect(r.isError).toBe(false);
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.name).toBe('demo');
    expect(payload.scope).toBe('global'); // 内部 app → 对外 global
    expect(payload.skillDir).toBe(skillDir);
    expect(payload.body).toContain('# demo');
    expect(payload.body).toContain('full body');
  });

  it('workspace catalog entry → scope 回显 session', async () => {
    const skillDir = join(appSkillRoot(dataDir), 'ws-demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'),
      '---\nname: ws-demo\ndescription: d\n---\n\n# ws\n\nbody', 'utf8');
    const entries = [{ name: 'ws-demo', skillDir, scope: 'workspace' }];
    const r = await skillTool.run({ name: 'ws-demo' }, makeCtx(entries));
    expect(r.isError).toBe(false);
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.scope).toBe('session'); // 内部 workspace → 对外 session
  });

  it('SKILL.md 磁盘丢失 → NOT_FOUND', async () => {
    // catalog 有但磁盘无 SKILL.md（人为删除场景）
    const entries = [{ name: 'ghost', skillDir: '/nonexistent/path', scope: 'app' }];
    const r = await skillTool.run({ name: 'ghost' }, makeCtx(entries));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('missing on disk');
  });
});
