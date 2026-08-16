/**
 * provider handler UT — credentials.key 明文返回验证（BUG-002 修复）
 * 参考: specs/api/overall/02-llm-chat.md §5（provider CRUD + credentials）
 *       states/v0.0.119.bugs/bugs/BUG-002-key字段mask展示缺失-[open].md
 *
 * 验证：
 *   1. GET /provider 列表响应 credentials.key 返回明文（不再脱敏为 '***'）
 *   2. GET /provider/:id 单项响应 credentials.key 返回明文
 *   3. POST /provider 创建响应 credentials.key 返回明文
 *   4. PUT /provider/:id 更新响应 credentials.key 返回明文
 *   5. PUT 时 key==='***' 仍视为不修改（向后兼容哨兵语义）
 *
 * 文件系统隔离：os.tmpdir() + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AppConfigService } from '../../config/app-config-service';
import {
  handleProviderCollection,
  handleProviderItem,
} from '../provider';

let tmpRoot: string;
let svc: AppConfigService;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oobt-provider-handler-'));
  svc = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造 POST 创建 provider Request */
function postReq(body: unknown): Request {
  return new Request('http://x/provider', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 构造 PUT 更新 Request */
function putReq(id: string, body: unknown): Request {
  return new Request(`http://x/provider/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 构造 GET Request */
function getReq(url: string): Request {
  return new Request(url, { method: 'GET' });
}

/** 预置一个 provider 到 app_config（绕过 handler 直接写落盘） */
function seedProvider(id: string, key: string) {
  svc.set('providers', id, {
    id,
    name: 'anthropic_compatible',
    protocolId: 'anthropic_compatible',
    label: 'Test Provider',
    baseUrl: 'https://api.example.com',
    credentials: { key },
    enabled: true,
    models: [],
  });
}

describe('provider handler — credentials.key 明文返回（BUG-002）', () => {
  it('POST 创建后响应 credentials.key 返回明文', async () => {
    const res = await handleProviderCollection(
      postReq({
        name: 'anthropic_compatible',
        protocolId: 'anthropic_compatible',
        label: 'My Provider',
        baseUrl: 'https://api.example.com',
        credentials: { key: 'sk-abc123456789' },
      }),
      'POST',
      svc,
      undefined,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { provider: { credentials: { key: string } } };
    // BUG-002 修复：key 必须返回明文，不能是 '***'
    expect(body.provider.credentials.key).toBe('sk-abc123456789');
    expect(body.provider.credentials.key).not.toBe('***');
  });

  it('GET 列表响应 credentials.key 返回明文', async () => {
    seedProvider('prov-001', 'sk-real-key-value');
    const res = await handleProviderCollection(
      getReq('http://x/provider'),
      'GET',
      svc,
      undefined,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ credentials: { key: string } }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.credentials.key).toBe('sk-real-key-value');
    expect(body.items[0]!.credentials.key).not.toBe('***');
  });

  it('GET 单项响应 credentials.key 返回明文', async () => {
    seedProvider('prov-002', 'sk-single-item-key');
    const res = await handleProviderItem(
      getReq('http://x/provider/prov-002'),
      'GET',
      'prov-002',
      svc,
      undefined,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { provider: { credentials: { key: string } } };
    expect(body.provider.credentials.key).toBe('sk-single-item-key');
    expect(body.provider.credentials.key).not.toBe('***');
  });

  it('PUT 更新后响应 credentials.key 返回明文新值', async () => {
    seedProvider('prov-003', 'sk-old-key');
    const res = await handleProviderItem(
      putReq('prov-003', {
        credentials: { key: 'sk-new-key-12345' },
      }),
      'PUT',
      'prov-003',
      svc,
      undefined,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { provider: { credentials: { key: string } } };
    expect(body.provider.credentials.key).toBe('sk-new-key-12345');
    expect(body.provider.credentials.key).not.toBe('***');
  });

  it('PUT 时 key=\'***\' 视为不修改（向后兼容哨兵语义），响应返回原 key 明文', async () => {
    seedProvider('prov-004', 'sk-original-key');
    const res = await handleProviderItem(
      putReq('prov-004', {
        label: 'Updated Label',
        credentials: { key: '***' },
      }),
      'PUT',
      'prov-004',
      svc,
      undefined,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { provider: { credentials: { key: string }; label: string } };
    // label 已更新
    expect(body.provider.label).toBe('Updated Label');
    // key 未被 '***' 覆盖，仍是原值
    expect(body.provider.credentials.key).toBe('sk-original-key');
    expect(body.provider.credentials.key).not.toBe('***');
  });
});

// ---- [v0.0.350 决策⑤] name 白名单通道（POST 5 值 + PUT 可选切换类型）----

describe('provider handler — name 白名单（v0.0.350 决策⑤）', () => {
  const VALID_BODY = {
    label: 'L', baseUrl: 'https://x.example.com',
    credentials: { key: 'sk-x' }, protocolId: 'anthropic_messages',
  };

  it('POST name 4 个 native 值全 201（白名单 5 值中的 4 个新成员）', async () => {
    for (const name of ['kimi_coding_plan', 'glm_coding_plan', 'minimax_coding_plan', 'deepseek_api']) {
      const res = await handleProviderCollection(postReq({ ...VALID_BODY, name }), 'POST', svc, undefined);
      expect(res.status, `name=${name}`).toBe(201);
      const body = await res.json() as { provider: { name: string } };
      expect(body.provider.name).toBe(name);
    }
  });

  it('POST 缺省 name → anthropic_compatible（旧 client 向后兼容，不 400）', async () => {
    const res = await handleProviderCollection(postReq({ ...VALID_BODY }), 'POST', svc, undefined);
    expect(res.status).toBe(201);
    const body = await res.json() as { provider: { name: string } };
    expect(body.provider.name).toBe('anthropic_compatible');
  });

  it('POST name 白名单外 → 400', async () => {
    const res = await handleProviderCollection(postReq({ ...VALID_BODY, name: 'openai_compatible' }), 'POST', svc, undefined);
    expect(res.status).toBe(400);
  });

  it('PUT 传白名单内 name → 写入（已存 provider 切换类型通道）', async () => {
    seedProvider('prov-n1', 'sk-k');
    const res = await handleProviderItem(
      putReq('prov-n1', { name: 'glm_coding_plan' }), 'PUT', 'prov-n1', svc, undefined,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { provider: { name: string } };
    expect(body.provider.name).toBe('glm_coding_plan');
  });

  it('PUT 不传 name → 不变；白名单外 → 400', async () => {
    seedProvider('prov-n2', 'sk-k');
    const keep = await handleProviderItem(putReq('prov-n2', { label: 'X' }), 'PUT', 'prov-n2', svc, undefined);
    expect(keep.status).toBe(200);
    expect(((await keep.json()) as { provider: { name: string } }).provider.name).toBe('anthropic_compatible');
    const bad = await handleProviderItem(putReq('prov-n2', { name: 'glm' }), 'PUT', 'prov-n2', svc, undefined);
    expect(bad.status).toBe(400);
  });
});
