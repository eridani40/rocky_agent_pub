/**
 * bootstrap — ComputerNativePort 注入集成测试（BUG-001 回归防线）
 * 参考: app/server/src/bootstrap.ts（computerNativePort 解析 + setResolveConfig 闭包透传）
 *       app/server/src/handlers/session-config.ts §252（SessionConfig.computerNativePort 注入）
 *       app/server/src/tools/computer-use/screenshot.ts §46（tool 读 ctx.config.computerNativePort）
 *
 * 为何是集成而非单测（BUG-001 教训）：
 *   screenshot tool 运行时读的 SessionConfig 由 deliverTo/POST run → activate →
 *   agentManager.resolveConfigBySid → bootstrap 的 setResolveConfig **闭包**构造（不走
 *   router.sessionDeps）。该闭包手动组装 SessionHandlerDeps，v0.0.105 首版漏传
 *   computerNativePort → 运行时 ctx.config.computerNativePort===undefined，screenshot
 *   fail-closed 到「仅桌面 App 可用」分支（两个 AT case 全 fail）。
 *   platform/computer 的 mock-native-port 单测只验端口本身，覆盖不到「bootstrap→config」这条
 *   透传链——故补此集成测试，锁死 resolveConfig 通路必须携带 computerNativePort。
 *
 * 文件系统隔离：mkdtempSync + afterEach rmSync；ROCKY_TEST_COMPUTER_NATIVE_PORT 环境变量
 *   在 afterEach 恢复，避免泄漏污染其他测试。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { bootstrapBuiltinPlugins } from '../bootstrap';
import { ulid } from '../config/ulid';

/** mock provider（buildSessionConfigFromDeps 解析 session 持久 provider/model 用；同 compact 测试范式） */
function seedProvider(bs: Awaited<ReturnType<typeof bootstrapBuiltinPlugins>>): {
  providerId: string;
  modelId: string;
} {
  const providerId = 'prov-mock';
  const modelId = 'claude-mock-1';
  bs.appConfig.set('providers', providerId, {
    id: providerId,
    name: 'anthropic_compatible',
    label: 'Mock',
    baseUrl: 'https://api.anthropic.com',
    credentials: { key: 'sk-test' },
    enabled: true,
    models: [
      {
        modelId,
        protocolId: 'anthropic_messages',
        contextWindow: 200000,
        maxOutputTokens: 4096,
        label: 'Mock 1',
        enabled: true,
      },
    ],
  });
  return { providerId, modelId };
}

describe('bootstrap — [v0.0.105] ComputerNativePort 注入（BUG-001 回归）', () => {
  let dataDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-bootstrap-cnp-'));
    prevEnv = process.env.ROCKY_TEST_COMPUTER_NATIVE_PORT;
    // 走 mock precedence（bootstrap resolveMockComputerNativePort 建 MockComputerNativePort）
    process.env.ROCKY_TEST_COMPUTER_NATIVE_PORT = 'mock';
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.ROCKY_TEST_COMPUTER_NATIVE_PORT;
    else process.env.ROCKY_TEST_COMPUTER_NATIVE_PORT = prevEnv;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('BootstrapResult.computerNativePort 字段存在（mock 开关命中 → 单例解析）', async () => {
    const bs = await bootstrapBuiltinPlugins(dataDir);
    expect(bs.computerNativePort).toBeDefined();
    // 鸭子类型：ComputerNativePort 契约方法齐全
    expect(typeof bs.computerNativePort?.checkPermissions).toBe('function');
    expect(typeof bs.computerNativePort?.screenshot).toBe('function');
  });

  it('resolveConfigBySid 携带 computerNativePort（deliverTo/POST run 运行时路径 = tool 读的 config）', async () => {
    // 这是 BUG-001 的核心回归断言：screenshot tool 运行时读的 SessionConfig 由此路径产出。
    const bs = await bootstrapBuiltinPlugins(dataDir);
    const { providerId, modelId } = seedProvider(bs);
    const sid = ulid();
    await bs.store.createSession({ id: sid, providerId, modelId });

    const config = await bs.agentManager.resolveConfigBySid(sid);

    // 运行时 config 必须携带 computerNativePort，且与 bootstrap 单例同实例（闭包透传未丢字段）
    expect(config.computerNativePort).toBeDefined();
    expect(config.computerNativePort).toBe(bs.computerNativePort);
    // 且是可用的端口对象（screenshot tool 直接调这两个方法）
    const port = config.computerNativePort as {
      checkPermissions?: unknown;
      screenshot?: unknown;
    };
    expect(typeof port.checkPermissions).toBe('function');
    expect(typeof port.screenshot).toBe('function');
  });

  it('未开 mock 开关（无 electron / dev loopback）→ computerNativePort undefined（fail-closed 降级）', async () => {
    // 反向：非桌面 / dev 未开 loopback 时降级 undefined，screenshot tool 侧走「仅桌面 App 可用」分支。
    delete process.env.ROCKY_TEST_COMPUTER_NATIVE_PORT;
    const bs = await bootstrapBuiltinPlugins(dataDir);
    expect(bs.computerNativePort).toBeUndefined();
    const { providerId, modelId } = seedProvider(bs);
    const sid = ulid();
    await bs.store.createSession({ id: sid, providerId, modelId });
    const config = await bs.agentManager.resolveConfigBySid(sid);
    expect(config.computerNativePort).toBeUndefined();
  });
});
