/**
 * app_config sub_agent_templates handler UT（v0.0.28 task-3 白盒）
 * 参考: specs/api/overall/10-multi-agent.md §5.2（PUT builtin 保护）/ §5.3（DELETE /config/dev）
 *       specs/tech/multi_agent/[P1]subagent_templates.md §3（CRUD + builtin 只读可复制）
 *       states/v0.0.28/task.json tasks[2] acceptance「DELETE 4 情形 + builtin 保护 + explorer 预配」
 *
 * 覆盖：
 *   - DELETE /config/app/sub_agent_templates 4 情形：①group!==sub_agent_templates→403 group_not_deletable；
 *     ②builtin:true→403 builtin_readonly；③record 不存在→404；④正常删除→200 {ok:true}
 *   - PUT builtin 保护：新建禁止 builtin:true（403）；改 builtin 模板（已存在 builtin:true）→ 403
 *   - PUT 正常 copy（GET explorer → 改 name/builtin=false → PUT 新 key → 200）
 *   - DELETE 系统调参 group（agent/llm 等）→ 403 group_not_deletable
 *   - body 缺字段 → 400
 *
 * 白盒：直接测 handleKvConfigAppTemplateDelete / handleKvConfigAppTemplatePut + checkBuiltinProtection。
 * 文件系统隔离：os.tmpdir() + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { AppConfigService } from '../../config/app-config-service';
import {
  handleKvConfigAppTemplateDelete,
  handleKvConfigAppTemplatePut,
  checkBuiltinProtection,
} from '../app-config-template-handlers';
import {
  SUB_AGENT_TEMPLATES_GROUP,
  EXPLORER_TEMPLATE,
  upsertExplorerTemplate,
} from '../../agent/tools/template-store';
import type { SubAgentTemplate } from '../../agent/tools/types';

let tmpRoot: string;
let devConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'app-config-template-'));
  devConfig = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造 DELETE Request */
function delReq(group: string, key: string): Request {
  return new Request('http://x/config/app/sub_agent_templates', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ group, key }),
  });
}

/** 构造 PUT Request（单 key） */
function putReq(group: string, key: string, data: unknown): Request {
  return new Request('http://x/config/app/sub_agent_templates', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ group, key, data }),
  });
}

describe('DELETE /config/app/sub_agent_templates 4 情形（api spec §5.3）', () => {
  beforeEach(() => {
    // 预配 builtin explorer + 一个私有模板
    upsertExplorerTemplate(devConfig);
    const privateTmpl: SubAgentTemplate = {
      name: 'my-copy', description: 'd', systemPrompt: 'sp',
      tools: ['read'], skills: [], modelId: null, builtin: false,
    };
    devConfig.set(SUB_AGENT_TEMPLATES_GROUP, 'my-copy', privateTmpl);
  });

  it('① group !== sub_agent_templates → 403 group_not_deletable', async () => {
    const res = await handleKvConfigAppTemplateDelete(delReq('agent', 'maxIterations'), devConfig);
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error).toBe('group_not_deletable');
  });

  it('① 系统调参 group（llm/context/runtime/web）均拒绝', async () => {
    for (const g of ['llm', 'context', 'runtime', 'web']) {
      const res = await handleKvConfigAppTemplateDelete(delReq(g, 'x'), devConfig);
      expect(res.status).toBe(403);
      expect((await res.json() as any).error).toBe('group_not_deletable');
    }
  });

  it('② builtin:true → 403 builtin_readonly', async () => {
    const res = await handleKvConfigAppTemplateDelete(
      delReq(SUB_AGENT_TEMPLATES_GROUP, 'explorer'),
      devConfig,
    );
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error).toBe('builtin_readonly');
    // explorer 未被删
    expect(devConfig.get(SUB_AGENT_TEMPLATES_GROUP, 'explorer')).toBeDefined();
  });

  it('③ record 不存在 → 404 Not Found', async () => {
    const res = await handleKvConfigAppTemplateDelete(
      delReq(SUB_AGENT_TEMPLATES_GROUP, 'ghost'),
      devConfig,
    );
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error).toBe('Not Found');
  });

  it('④ 正常删除私有模板 → 200 {ok:true} + 物理移除', async () => {
    const res = await handleKvConfigAppTemplateDelete(
      delReq(SUB_AGENT_TEMPLATES_GROUP, 'my-copy'),
      devConfig,
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual({ ok: true });
    // 已物理删除
    expect(devConfig.get(SUB_AGENT_TEMPLATES_GROUP, 'my-copy')).toBeUndefined();
  });

  it('body 缺字段 → 400', async () => {
    const res = await handleKvConfigAppTemplateDelete(
      new Request('http://x/config/app/sub_agent_templates', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group: SUB_AGENT_TEMPLATES_GROUP }),
      }),
      devConfig,
    );
    expect(res.status).toBe(400);
  });

  it('invalid json body → 400', async () => {
    const res = await handleKvConfigAppTemplateDelete(
      new Request('http://x/config/app/sub_agent_templates', {
        method: 'DELETE',
        body: 'not-json',
      }),
      devConfig,
    );
    expect(res.status).toBe(400);
  });
});

describe('PUT /config/dev builtin 保护（api spec §5.2）', () => {
  beforeEach(() => {
    upsertExplorerTemplate(devConfig); // 预配 builtin explorer
  });

  it('新建禁止 builtin:true → 403 builtin_readonly', async () => {
    const fake: SubAgentTemplate = {
      name: 'fake-builtin', description: 'd', systemPrompt: 'sp',
      tools: ['read'], modelId: null, builtin: true, // 伪装 builtin
    };
    const res = await handleKvConfigAppTemplatePut(
      putReq(SUB_AGENT_TEMPLATES_GROUP, 'fake-builtin', fake),
      devConfig,
    );
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe('builtin_readonly');
    // 未落盘
    expect(devConfig.get(SUB_AGENT_TEMPLATES_GROUP, 'fake-builtin')).toBeUndefined();
  });

  it('改 builtin 模板（explorer，已存在 builtin:true）→ 403 builtin_readonly', async () => {
    const modified = {
      ...EXPLORER_TEMPLATE,
      description: '试图改 explorer',
    };
    const res = await handleKvConfigAppTemplatePut(
      putReq(SUB_AGENT_TEMPLATES_GROUP, 'explorer', modified),
      devConfig,
    );
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe('builtin_readonly');
  });

  it('copy explorer → 改 name/builtin=false → PUT 新 key → 200 落盘', async () => {
    const copy: SubAgentTemplate = {
      name: 'my-explorer',
      description: '私有 explorer copy',
      systemPrompt: EXPLORER_TEMPLATE.systemPrompt,
      tools: EXPLORER_TEMPLATE.tools,
      skills: [],
      modelId: 'some-model',
      builtin: false, // 复制衍生为私有
    };
    const res = await handleKvConfigAppTemplatePut(
      putReq(SUB_AGENT_TEMPLATES_GROUP, 'my-explorer', copy),
      devConfig,
    );
    expect(res.status).toBe(200);
    expect((await res.json() as any)).toEqual({ ok: true });
    // 落盘校验
    const got = devConfig.get(SUB_AGENT_TEMPLATES_GROUP, 'my-explorer') as SubAgentTemplate;
    expect(got.name).toBe('my-explorer');
    expect(got.builtin).toBe(false);
    expect(got.modelId).toBe('some-model');
  });

  it('PUT 已有私有模板 update（非 builtin）→ 200', async () => {
    const v1: SubAgentTemplate = {
      name: 'mine', description: 'd1', systemPrompt: 'sp1',
      tools: ['read'], builtin: false,
    };
    devConfig.set(SUB_AGENT_TEMPLATES_GROUP, 'mine', v1);
    const v2 = { ...v1, description: 'd2' };
    const res = await handleKvConfigAppTemplatePut(
      putReq(SUB_AGENT_TEMPLATES_GROUP, 'mine', v2),
      devConfig,
    );
    expect(res.status).toBe(200);
    const got = devConfig.get(SUB_AGENT_TEMPLATES_GROUP, 'mine') as SubAgentTemplate;
    expect(got.description).toBe('d2');
  });

  it('PUT 整组（items[]）含 builtin 覆盖 → 403 builtin_readonly', async () => {
    const req = new Request('http://x/config/app/sub_agent_templates', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        group: SUB_AGENT_TEMPLATES_GROUP,
        items: [
          { key: 'explorer', data: { ...EXPLORER_TEMPLATE, description: '改 builtin' } },
        ],
      }),
    });
    const res = await handleKvConfigAppTemplatePut(req, devConfig);
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe('builtin_readonly');
  });

  it('PUT 非 sub_agent_templates group 放行（不走保护）', async () => {
    const res = await handleKvConfigAppTemplatePut(
      putReq('agent', 'maxIterations', 50),
      devConfig,
    );
    expect(res.status).toBe(200);
    expect(devConfig.get('agent', 'maxIterations')).toBe(50);
  });
});

describe('checkBuiltinProtection（白盒纯函数）', () => {
  beforeEach(() => {
    upsertExplorerTemplate(devConfig);
  });

  it('非 sub_agent_templates group → null（放行）', () => {
    expect(checkBuiltinProtection(devConfig, 'agent', 'k', { builtin: true })).toBeNull();
  });

  it('新建 + builtin:true → Response 403', () => {
    const r = checkBuiltinProtection(
      devConfig, SUB_AGENT_TEMPLATES_GROUP, 'new-key', { builtin: true },
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(403);
  });

  it('新建 + builtin:false → null（放行）', () => {
    const r = checkBuiltinProtection(
      devConfig, SUB_AGENT_TEMPLATES_GROUP, 'new-key', { builtin: false },
    );
    expect(r).toBeNull();
  });

  it('改 builtin explorer → Response 403', () => {
    const r = checkBuiltinProtection(
      devConfig, SUB_AGENT_TEMPLATES_GROUP, 'explorer',
      { ...EXPLORER_TEMPLATE, description: '改' },
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(403);
  });
});

describe('KvConfigService.delete（v0.0.28 新增，sub_agent_templates 落盘）', () => {
  it('delete 命中 → true + 物理移除', () => {
    devConfig.set(SUB_AGENT_TEMPLATES_GROUP, 'tmp', { name: 'tmp', tools: [] });
    expect(devConfig.delete(SUB_AGENT_TEMPLATES_GROUP, 'tmp')).toBe(true);
    expect(devConfig.get(SUB_AGENT_TEMPLATES_GROUP, 'tmp')).toBeUndefined();
  });

  it('delete 不存在 → false（idempotent）', () => {
    expect(devConfig.delete(SUB_AGENT_TEMPLATES_GROUP, 'ghost')).toBe(false);
  });
});
