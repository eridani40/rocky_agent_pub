/**
 * v0.0.144 需求2 — buildSessionConfigFromDeps 装配 llm_request config UT
 * 参考: specs/tech/version_logs/v0.0.144/change_plan.md「需求 2」
 *       specs/tech/agent/llm_caller/[P0]llm_request_config.md §1.2（LlmRequestConfigService.get 缺省回退）
 *
 * 验证装配接线点（buildSessionConfigFromDeps 是唯一持 deps.appConfig 句柄的 SessionConfig 构造点）：
 *   - SessionConfig.llmRequestConfig = new LlmRequestConfigService(appConfig).get()（含自定义 retry 生效）
 *   - SessionConfig.allProviders = listEnabledProviders(appConfig)（非空）
 *
 * 真实 SessionStore + 真实 AppConfigService（bootstrap fixture，mock provider）+ tmpdir。
 * 文件系统隔离：用 os.tmpdir + mkdtempSync + afterEach 清理，不触真实路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { AppConfigService } from '../../config/app-config-service';
import { LlmRequestConfigService, DEFAULT_LLM_REQUEST_CONFIG } from '../../config/llm_request_config';
import { ulid } from '../../config/ulid';
import { bootstrapBuiltinPlugins } from '../../bootstrap';
import { buildSessionConfigFromDeps } from '../session-config';
import { buildRealSessionTypePolicy } from '../../agent/__helpers__/session-type-policy-test-helper';
import type { SessionHandlerDeps } from '../session';
import { SessionKind } from '@app/shared';

const PG_ROCKY_MAIN = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' });

let tmpRoot: string;
let store: SessionStore;
let appConfig: AppConfigService;
let deps: SessionHandlerDeps;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-config-llmreq-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  appConfig = new AppConfigService({ root: tmpRoot });
  const bs = await bootstrapBuiltinPlugins(tmpRoot);
  // 启用一个 mock provider（供 resolveModel 命中 + listEnabledProviders 返回非空）
  appConfig.set('providers', 'mock-prov', {
    id: 'mock-prov',
    name: 'mock',
    enabled: true,
    kind: 'mock',
    credential: {},
    models: [{ modelId: 'mock-model' }],
  });
  appConfig.set('default_models', 'default', { chat: 'mock-model', summary: 'mock-model' });
  deps = {
    store,
    agentManager: bs.agentManager,
    appConfig,
    pluginManager: bs.pluginManager,
    contextEngine: bs.contextEngine,
    dataDir: tmpRoot,
    sessionTypePolicy: buildRealSessionTypePolicy(tmpRoot),
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('buildSessionConfigFromDeps — [v0.0.144] llm_request config 装配', () => {
  it('未配置 llm_request → llmRequestConfig 回退 DEFAULT（max_attempts=3）', () => {
    const config = buildSessionConfigFromDeps(deps, ulid(), {}, PG_ROCKY_MAIN);
    expect(config.llmRequestConfig).toBeDefined();
    expect(config.llmRequestConfig!.retry.max_attempts).toBe(DEFAULT_LLM_REQUEST_CONFIG.retry.max_attempts);
  });

  it('已配置 llm_request → llmRequestConfig = service.get()（自定义 retry 生效）', () => {
    // 先写自定义 config（max_attempts=7），断言装配点读到的是持久化值而非默认
    new LlmRequestConfigService(appConfig).set({
      ...DEFAULT_LLM_REQUEST_CONFIG,
      retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, max_attempts: 7 },
    });
    const config = buildSessionConfigFromDeps(deps, ulid(), {}, PG_ROCKY_MAIN);
    expect(config.llmRequestConfig!.retry.max_attempts).toBe(7);
    // 与直接 service.get() 一致（装配点无篡改）
    const direct = new LlmRequestConfigService(appConfig).get();
    expect(config.llmRequestConfig!.retry.max_attempts).toBe(direct.retry.max_attempts);
  });

  it('allProviders = listEnabledProviders(appConfig)（含 mock-prov，非空）', () => {
    const config = buildSessionConfigFromDeps(deps, ulid(), {}, PG_ROCKY_MAIN);
    expect(Array.isArray(config.allProviders)).toBe(true);
    expect(config.allProviders!.length).toBeGreaterThan(0);
    expect(config.allProviders!.some((p) => p.id === 'mock-prov')).toBe(true);
  });
});
