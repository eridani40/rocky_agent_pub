/**
 * LlmRequestConfigService + GET/PUT /config/app/llm_request 单测
 * 参考: specs/tech/agent/llm_caller/[P0]llm_request_config.md §1.2/§1.3/§5.2
 *       specs/api/version_logs/v0.0.25/change_log.md §1.3
 *
 * 覆盖：
 *   - §1.3 DEFAULT_LLM_REQUEST_CONFIG 默认值正确
 *   - §5.2 缺省回退（record 不存在返 DEFAULT；record 存在按配置）
 *   - set 整体替换（含缺字段补默认）
 *   - GET/PUT handler 端到端（直接调 handler，绕 router）
 *   - snake_case fallback_chain ↔ camelCase fallbackChain 互转
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { AppConfigService } from '../app-config-service';
import {
  LlmRequestConfigService,
  DEFAULT_LLM_REQUEST_CONFIG,
  LLM_REQUEST_GROUP,
  LLM_REQUEST_KEY,
} from '../llm_request_config';
import {
  handleLlmRequestConfigGet,
  handleLlmRequestConfigPut,
} from '../../handlers/llm_request_config';

/**
 * 测试用响应体最小形状（JSON 反序列化后是 unknown，需 type guard / cast 后访问字段）。
 * 用 Record<string, any> 索引签名避免 TS18046；各处断言前已明确知道响应形态。
 */
type ResBody = Record<string, any>;
/** 读 Response.json() 并断言为 ResBody（fetch 返回 unknown,需 cast） */
const jsonBody = async (res: Response): Promise<ResBody> =>
  (await res.json()) as ResBody;

let tmpRoot: string;
let app: AppConfigService;
let svc: LlmRequestConfigService;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-req-cfg-'));
  app = new AppConfigService({ root: tmpRoot });
  svc = new LlmRequestConfigService(app);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('DEFAULT_LLM_REQUEST_CONFIG（§1.3 spec 权威默认值）', () => {
  it('timeout 默认值', () => {
    expect(DEFAULT_LLM_REQUEST_CONFIG.timeout).toEqual({
      ttfb_s: 45,
      stall_answer_s: 30,
      stall_think_s: 30,
      stall_tool_s: 120,
      wall_max_s: 600,
    });
  });

  it('retry 默认值', () => {
    expect(DEFAULT_LLM_REQUEST_CONFIG.retry).toEqual({
      max_attempts: 3,
      backoff_base_s: 2,
      backoff_cap_s: 30,
      jitter: true,
    });
  });

  it('degradation 默认值', () => {
    expect(DEFAULT_LLM_REQUEST_CONFIG.degradation).toEqual({
      cooldown_s: 300,
      consecutive_to_degrade: 3,
      respect_retry_after: true,
    });
  });

  it('length 默认值', () => {
    expect(DEFAULT_LLM_REQUEST_CONFIG.length).toEqual({
      auto_compress: true,
      precompress_threshold_ratio: 0.8,
      max_tokens_bump_strategy: 'continue',
    });
  });

  it('fallbackChain 默认空（向后兼容无 fallback）', () => {
    expect(DEFAULT_LLM_REQUEST_CONFIG.fallbackChain).toEqual([]);
  });
});

describe('LlmRequestConfigService 缺省回退（§5.2）', () => {
  it('record 不存在 → 返回 DEFAULT（缺省回退）', () => {
    const cfg = svc.get();
    expect(cfg.timeout.ttfb_s).toBe(45);
    expect(cfg.retry.max_attempts).toBe(3);
    expect(cfg.fallbackChain).toEqual([]);
  });

  it('record 存在 → 按配置（不回退默认）', () => {
    svc.set({
      ...DEFAULT_LLM_REQUEST_CONFIG,
      retry: {
        max_attempts: 5,
        backoff_base_s: 2,
        backoff_cap_s: 30,
        jitter: true,
      },
      fallbackChain: [
        { providerId: 'p1', keyRef: 'default', modelId: 'claude-sonnet-4-6' },
      ],
    });
    const cfg = svc.get();
    expect(cfg.retry.max_attempts).toBe(5);
    expect(cfg.fallbackChain).toHaveLength(1);
    expect(cfg.fallbackChain[0]!.providerId).toBe('p1');
  });

  it('set 部分字段 → 落盘补默认（GET 时字段完整）', () => {
    // 模拟 PUT 只传 retry，其他字段缺失
    svc.set({
      timeout: undefined as unknown as typeof DEFAULT_LLM_REQUEST_CONFIG.timeout,
      retry: {
        max_attempts: 7,
        backoff_base_s: 1,
        backoff_cap_s: 10,
        jitter: false,
      },
      degradation: undefined as unknown as typeof DEFAULT_LLM_REQUEST_CONFIG.degradation,
      length: undefined as unknown as typeof DEFAULT_LLM_REQUEST_CONFIG.length,
      fallbackChain: [],
    });
    const cfg = svc.get();
    // retry 按传入
    expect(cfg.retry.max_attempts).toBe(7);
    expect(cfg.retry.jitter).toBe(false);
    // 其他字段补默认
    expect(cfg.timeout.ttfb_s).toBe(45);
    expect(cfg.degradation.cooldown_s).toBe(300);
    expect(cfg.length.auto_compress).toBe(true);
  });

  it('持久化形态为 snake_case fallback_chain（app_config group shard）', () => {
    svc.set({
      ...DEFAULT_LLM_REQUEST_CONFIG,
      fallbackChain: [
        { providerId: 'p2', keyRef: 'backup', modelId: 'gpt-4o' },
      ],
    });
    // 直接读 app_config raw 验证持久化形态
    const raw = app.get(LLM_REQUEST_GROUP, LLM_REQUEST_KEY) as {
      fallback_chain: unknown[];
    };
    expect(raw.fallback_chain).toEqual([
      { providerId: 'p2', keyRef: 'backup', modelId: 'gpt-4o' },
    ]);
  });
});

describe('GET /config/app/llm_request handler', () => {
  it('record 不存在 → 200 返回 DEFAULT（snake_case fallback_chain）', async () => {
    const res = handleLlmRequestConfigGet(svc);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.timeout.ttfb_s).toBe(45);
    expect(body.fallback_chain).toEqual([]);
    // 响应是 snake_case
    expect(body.fallback_chain).not.toBeUndefined();
    expect(body.fallbackChain).toBeUndefined();
  });

  it('record 存在 → 200 返回配置值', async () => {
    svc.set({
      ...DEFAULT_LLM_REQUEST_CONFIG,
      retry: {
        max_attempts: 5,
        backoff_base_s: 2,
        backoff_cap_s: 30,
        jitter: true,
      },
    });
    const res = handleLlmRequestConfigGet(svc);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.retry.max_attempts).toBe(5);
  });
});

describe('PUT /config/app/llm_request handler', () => {
  it('整体替换 → 200 { ok:true } + 后续 GET 反映', async () => {
    const putBody = {
      timeout: DEFAULT_LLM_REQUEST_CONFIG.timeout,
      retry: {
        max_attempts: 5,
        backoff_base_s: 2,
        backoff_cap_s: 30,
        jitter: true,
      },
      degradation: DEFAULT_LLM_REQUEST_CONFIG.degradation,
      length: DEFAULT_LLM_REQUEST_CONFIG.length,
      fallback_chain: [
        { providerId: 'p3', keyRef: 'default', modelId: 'm1' },
      ],
    };
    const req = new Request('http://x/config/app/llm_request', {
      method: 'PUT',
      body: JSON.stringify(putBody),
      headers: { 'content-type': 'application/json' },
    });
    const res = await handleLlmRequestConfigPut(req, svc);
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).ok).toBe(true);

    // 后续 GET 反映
    const cfg = svc.get();
    expect(cfg.retry.max_attempts).toBe(5);
    expect(cfg.fallbackChain).toEqual([
      { providerId: 'p3', keyRef: 'default', modelId: 'm1' },
    ]);
  });

  it('body 非 JSON → 400', async () => {
    const req = new Request('http://x/config/app/llm_request', {
      method: 'PUT',
      body: 'not json',
    });
    const res = await handleLlmRequestConfigPut(req, svc);
    expect(res.status).toBe(400);
  });

  it('fallback_chain 非数组 → 400', async () => {
    const req = new Request('http://x/config/app/llm_request', {
      method: 'PUT',
      body: JSON.stringify({ fallback_chain: 'not array' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await handleLlmRequestConfigPut(req, svc);
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error).toContain('fallback_chain');
  });

  it('timeout 非对象 → 400', async () => {
    const req = new Request('http://x/config/app/llm_request', {
      method: 'PUT',
      body: JSON.stringify({ timeout: 'not object' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await handleLlmRequestConfigPut(req, svc);
    expect(res.status).toBe(400);
  });
});
