/**
 * GET /session/:id/debug/system-prompt 单测 — test gate + 组装 system prompt 含 skill L0
 * 参考: orchestrator 决策2
 *       specs/tech/agent/skills/[P0]skill_architecture.md §8（skills mapper L0 注入）
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { handleRequest } from '../../router';
import { appSkillRoot } from '../../skills/resolver';
import { bootstrapBuiltinPlugins } from '../../bootstrap';

function req(method: string, path: string): Request {
  return new Request(`http://127.0.0.1:3700${path}`, { method });
}
async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

/** 注册一个最小 enabled provider（debug endpoint 走 buildSessionConfigFromDeps 需 LlmClient） */
async function seedProvider(dataDir: string): Promise<void> {
  const bs = await bootstrapBuiltinPlugins(dataDir);
  bs.appConfig.set('providers', 'test-prov', {
    id: 'test-prov',
    name: 'anthropic_compatible',
    label: 'test',
    baseUrl: 'http://127.0.0.1:0',
    credentials: { key: 'sk-test' },
    enabled: true,
    models: [{ modelId: 'm1', protocolId: 'anthropic_messages', contextWindow: 8000, maxOutputTokens: 1000, label: 'm1', enabled: true }],
  });
  // [v0.0.89 工作块 ③] resolveModel 不静默兜底（PRD §5.1）。
  //   debug endpoint 走 buildSessionConfigFromDeps（chat 链）需 default_models.chat 命中 m1。
  bs.appConfig.set('default_models', 'default', { chat: 'm1', summary: 'm1' });
}

async function createSession(dataDir: string): Promise<string> {
  await seedProvider(dataDir);
  const r = await handleRequest(req('POST', '/session'), dataDir);
  const b = await jsonBody(r);
  return b.id;
}

describe('GET /session/:id/debug/system-prompt (test gate)', () => {
  let dataDir: string;
  let oldNodeEnv: string | undefined;
  let oldAppEnv: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-dbg-'));
    oldNodeEnv = process.env.NODE_ENV;
    oldAppEnv = process.env.APP_ENV;
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    process.env.NODE_ENV = oldNodeEnv;
    process.env.APP_ENV = oldAppEnv;
  });

  it('非 test 环境 → 404', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_ENV = 'production';
    const sid = await createSession(dataDir);
    const r = await handleRequest(req('GET', `/session/${sid}/debug/system-prompt`), dataDir);
    expect(r.status).toBe(404);
  });

  // M2: test gate 负测试 — 穷举几个非 test 的 APP_ENV 都必须 404（防生产/dev 泄露 prompt）
  it.each([
    ['development'],
    ['dev'],
    ['staging'],
    ['prod'],
    ['production'],
  ])('APP_ENV=%s → 404（仅 test 放行）', async (env) => {
    process.env.NODE_ENV = env;
    process.env.APP_ENV = env;
    const sid = await createSession(dataDir);
    const r = await handleRequest(req('GET', `/session/${sid}/debug/system-prompt`), dataDir);
    expect(r.status).toBe(404);
  });

  it('NODE_ENV 缺省 / APP_ENV 非定义值 → 404', async () => {
    delete process.env.NODE_ENV;
    process.env.APP_ENV = 'ci';
    const sid = await createSession(dataDir);
    const r = await handleRequest(req('GET', `/session/${sid}/debug/system-prompt`), dataDir);
    expect(r.status).toBe(404);
  });

  it('test 环境 → 200 + systemPrompt 非空', async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    const sid = await createSession(dataDir);
    const r = await handleRequest(req('GET', `/session/${sid}/debug/system-prompt`), dataDir);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(typeof b.systemPrompt).toBe('string');
    expect(b.systemPrompt.length).toBeGreaterThan(0);
  });

  it('test 环境 + installed skill → systemPrompt 含 skill L0（name+description）', async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    // 安装一个 skill 到 app 层
    const skillDir = join(appSkillRoot(dataDir), 'debug-demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'),
      '---\nname: debug-demo\ndescription: 调试注入验证用技能\n---\n\n# debug-demo', 'utf8');

    const sid = await createSession(dataDir);
    const r = await handleRequest(req('GET', `/session/${sid}/debug/system-prompt`), dataDir);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.systemPrompt).toContain('# Skills');
    expect(b.systemPrompt).toContain('debug-demo');
    expect(b.systemPrompt).toContain('调试注入验证用技能');
  });

  it('session 不存在 → 404', async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    const r = await handleRequest(req('GET', '/session/nonexistent/debug/system-prompt'), dataDir);
    expect(r.status).toBe(404);
  });
});
