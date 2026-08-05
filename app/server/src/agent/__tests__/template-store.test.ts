/**
 * template-store UT（v0.0.28 task-3 白盒）
 * 参考: specs/tech/multi_agent/[P1]subagent_templates.md §2/§3/§5（结构 + dev_config 存储 + explorer 预配）
 *       specs/api/overall/10-multi-agent.md §5（模板 CRUD）
 *
 * 覆盖：
 *   - loadTemplate(name): 从 dev_config sub_agent_templates 读模板 → SubAgentTemplate；找不到 → null
 *   - normalizeTemplate: record.data → SubAgentTemplate（字段缺失兜底）
 *   - upsertExplorerTemplate: bootstrap 预配 idempotent（不存在才写 builtin=true explorer；
 *     二次启动跳过，不回写用户改字段）
 *   - listTemplates: 整组列出
 *   - EXPLORER_TEMPLATE 字段对齐 spec（tools=[read/web_search/web_fetch/send_message] 无通配符，
 *     modelId=null inherit parent，builtin=true）
 *   - D8 resolution（concrete loader）：eff.modelId = template?.modelId ?? parent.modelId
 *     三用法用真实 dev_config loader 验证（替代 task-2 的 mock loader）
 *
 * 文件系统隔离：用 os.tmpdir() + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { AppConfigService } from '../../config/app-config-service';
import {
  SUB_AGENT_TEMPLATES_GROUP,
  EXPLORER_TEMPLATE,
  normalizeTemplate,
  loadTemplateFromDevConfig,
  listTemplates,
  upsertExplorerTemplate,
  makeLoadTemplate,
} from '../tools/template-store';
import { resolveEffective } from '../tools/template-loader';
import type { SubAgentTemplate, SpawnAgentInput } from '../tools/types';

let tmpRoot: string;
let devConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'template-store-'));
  devConfig = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('EXPLORER_TEMPLATE 字段对齐 spec（subagent_templates §5）', () => {
  it('explorer 工具清单对齐实际命名（无通配符 read_*）', () => {
    expect(EXPLORER_TEMPLATE.tools).toEqual([
      'read',
      'web_search',
      'web_fetch',
      'send_message',
    ]);
    // 明确无通配符
    expect(EXPLORER_TEMPLATE.tools.some((t) => t.includes('*'))).toBe(false);
  });

  it('explorer modelId=null（inherit parent）+ builtin=true', () => {
    expect(EXPLORER_TEMPLATE.modelId).toBeNull();
    expect(EXPLORER_TEMPLATE.builtin).toBe(true);
  });

  it('explorer name=explorer + systemPrompt 非空', () => {
    expect(EXPLORER_TEMPLATE.name).toBe('explorer');
    expect(EXPLORER_TEMPLATE.systemPrompt.length).toBeGreaterThan(0);
  });
});

describe('normalizeTemplate record.data → SubAgentTemplate', () => {
  it('完整 record.data 正确归一化', () => {
    const data = {
      name: 'my-tmpl',
      description: 'desc',
      systemPrompt: 'sp',
      tools: ['read'],
      skills: ['s1'],
      modelId: 'm1',
      builtin: false,
    };
    expect(normalizeTemplate(data)).toEqual(data);
  });

  it('字段缺失兜底（tools/skills/systemPrompt）', () => {
    const t = normalizeTemplate({ name: 'x' });
    expect(t.name).toBe('x');
    expect(t.tools).toEqual([]);
    expect(t.systemPrompt).toBe('');
    expect(t.skills).toBeUndefined();
    expect(t.modelId).toBeUndefined();
    expect(t.builtin).toBeUndefined();
  });

  it('非 object 输入抛错', () => {
    expect(() => normalizeTemplate(null)).toThrow();
    expect(() => normalizeTemplate('str')).toThrow();
  });
});

describe('loadTemplate / listTemplates（dev_config sub_agent_templates）', () => {
  it('loadTemplate 找不到模板返 null', async () => {
    const t = await loadTemplateFromDevConfig(devConfig, 'nope');
    expect(t).toBeNull();
  });

  it('loadTemplate 命中返归一化 SubAgentTemplate', async () => {
    const tmpl: SubAgentTemplate = {
      name: 'code-reviewer',
      description: 'd',
      systemPrompt: 'sp',
      tools: ['read', 'send_message'],
      skills: [],
      modelId: 'm1',
      builtin: false,
    };
    devConfig.set(SUB_AGENT_TEMPLATES_GROUP, 'code-reviewer', tmpl);
    const got = await loadTemplateFromDevConfig(devConfig, 'code-reviewer');
    expect(got).toEqual(tmpl);
  });

  it('listTemplates 返回整组模板', () => {
    devConfig.set(SUB_AGENT_TEMPLATES_GROUP, 'a', { name: 'a', systemPrompt: 'x', tools: [] });
    devConfig.set(SUB_AGENT_TEMPLATES_GROUP, 'b', { name: 'b', systemPrompt: 'y', tools: ['read'] });
    const list = listTemplates(devConfig);
    expect(list.length).toBe(2);
    expect(list.map((t) => t.name).sort()).toEqual(['a', 'b']);
  });

  it('listTemplates 空组返空数组', () => {
    expect(listTemplates(devConfig)).toEqual([]);
  });

  it('makeLoadTemplate 构造的函数与 loadTemplateFromDevConfig 行为一致', async () => {
    const loadFn = makeLoadTemplate(devConfig);
    devConfig.set(SUB_AGENT_TEMPLATES_GROUP, 't', {
      name: 't', systemPrompt: 's', tools: ['read'],
    });
    expect(await loadFn('t')).toEqual({
      name: 't', description: '', systemPrompt: 's', tools: ['read'],
    });
    expect(await loadFn('missing')).toBeNull();
  });
});

describe('upsertExplorerTemplate（bootstrap 预配 idempotent）', () => {
  it('不存在时写入 builtin=true explorer record', () => {
    const wrote = upsertExplorerTemplate(devConfig);
    expect(wrote).toBe(true);
    const got = devConfig.get(SUB_AGENT_TEMPLATES_GROUP, 'explorer');
    expect(got).toEqual(EXPLORER_TEMPLATE);
    expect((got as SubAgentTemplate).builtin).toBe(true);
  });

  it('二次启动 idempotent：已存在跳过，不回写用户改字段', () => {
    upsertExplorerTemplate(devConfig);
    // 用户改了 explorer 的 description（但 builtin 仍 true，用户可 copy 不可改 builtin；
    // 这里模拟 store 已有 explorer record，upsert 应跳过）
    const userModified = {
      ...EXPLORER_TEMPLATE,
      description: '用户改过的 desc',
    };
    devConfig.set(SUB_AGENT_TEMPLATES_GROUP, 'explorer', userModified);

    const wrote = upsertExplorerTemplate(devConfig);
    expect(wrote).toBe(false); // 跳过
    const got = devConfig.get(SUB_AGENT_TEMPLATES_GROUP, 'explorer') as SubAgentTemplate;
    expect(got.description).toBe('用户改过的 desc'); // 不回写
  });
});

describe('D8 resolution（concrete loadTemplate from dev_config）', () => {
  const PARENT_MODEL = 'parent-001';

  /** 纯模板 spawn 入参（仅 templateRef） */
  const pureTemplateInput = (ref: string): SpawnAgentInput => ({
    templateRef: ref,
    task: { content: [{ type: 'text', text: 'do' }] },
    mode: 'sync',
  });

  it('① 纯模板（templateRef only）→ eff.modelId = template.modelId', async () => {
    const tmpl: SubAgentTemplate = {
      name: 'with-model', description: 'd', systemPrompt: 'sp',
      tools: ['read'], skills: [], modelId: 'tmpl-model-9', builtin: false,
    };
    devConfig.set(SUB_AGENT_TEMPLATES_GROUP, 'with-model', tmpl);
    const load = makeLoadTemplate(devConfig);

    const eff = await resolveEffective(pureTemplateInput('with-model'), PARENT_MODEL, load);
    expect(eff.modelId).toBe('tmpl-model-9'); // 走模板
    expect(eff.systemPrompt).toBe('sp');
    expect(eff.tools).toEqual(['read']);
    expect(eff.subAgentTemplateType).toBe('with-model');
  });

  it('① 纯模板 modelId=null → inherit parent.modelId', async () => {
    const tmpl: SubAgentTemplate = {
      name: 'inherit', description: 'd', systemPrompt: 'sp',
      tools: ['read'], modelId: null, builtin: true,
    };
    devConfig.set(SUB_AGENT_TEMPLATES_GROUP, 'inherit', tmpl);
    const load = makeLoadTemplate(devConfig);

    const eff = await resolveEffective(pureTemplateInput('inherit'), PARENT_MODEL, load);
    expect(eff.modelId).toBe(PARENT_MODEL); // 模板 null → inherit parent
  });

  it('② 纯 inline（无 templateRef + systemPrompt+tools）→ eff.modelId = parent.modelId', async () => {
    const load = makeLoadTemplate(devConfig);
    const inlineInput: SpawnAgentInput = {
      systemPrompt: 'inline-sp',
      tools: ['read', 'web_search'],
      task: { content: [{ type: 'text', text: 'do' }] },
      mode: 'sync',
    };
    const eff = await resolveEffective(inlineInput, PARENT_MODEL, load);
    expect(eff.modelId).toBe(PARENT_MODEL); // inherit parent
    expect(eff.subAgentTemplateType).toBeNull();
  });

  it('③ 模板+覆盖（templateRef + 覆盖 systemPrompt/tools）→ eff.modelId 仍 = template.modelId', async () => {
    const tmpl: SubAgentTemplate = {
      name: 'overlay', description: 'd', systemPrompt: 'orig-sp',
      tools: ['read'], skills: ['s1'], modelId: 'tmpl-model-9', builtin: false,
    };
    devConfig.set(SUB_AGENT_TEMPLATES_GROUP, 'overlay', tmpl);
    const load = makeLoadTemplate(devConfig);
    const overlayInput: SpawnAgentInput = {
      templateRef: 'overlay',
      systemPrompt: 'override-sp', // 覆盖
      tools: ['read', 'web_fetch'], // 覆盖
      task: { content: [{ type: 'text', text: 'do' }] },
      mode: 'sync',
    };
    const eff = await resolveEffective(overlayInput, PARENT_MODEL, load);
    expect(eff.modelId).toBe('tmpl-model-9'); // 仍走模板（modelId 不在 spawn 入参）
    expect(eff.systemPrompt).toBe('override-sp'); // 覆盖生效
    expect(eff.tools).toEqual(['read', 'web_fetch']);
  });

  it('templateRef 找不到模板 → throw error（spawn 拒绝）', async () => {
    const load = makeLoadTemplate(devConfig);
    await expect(
      resolveEffective(pureTemplateInput('ghost'), PARENT_MODEL, load),
    ).rejects.toThrow(/template not found: ghost/);
  });
});
