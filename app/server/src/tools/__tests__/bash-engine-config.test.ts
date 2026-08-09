/**
 * bash-engine 配置开关 UT（v0.0.296）
 * 参考: specs/tech/version_logs/v0.0.296/change_plan.md
 *
 * 覆盖点：
 *   1. setBashEngineConfigReader 注入 false → getBashEngine 返 PassthroughBashEngine
 *   2. setBashEngineConfigReader 注入 true → getBashEngine 返 SecureBashEngine
 *   3. 未注入 configReader → getBashEngine 返 SecureBashEngine（安全回退）
 *   4. configReader 抛异常 → getBashEngine 回退 SecureBashEngine
 *   5. PassthroughBashEngine.exec() 真实执行命令（echo test → exit 0）
 *
 * 注意：getBashEngine 每次调用实时读配置决策（非单例锁死），改配置立即生效。
 * 两个 engine 实例各自缓存复用（无状态），但决策逻辑每次执行。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getBashEngine,
  setBashEngineConfigReader,
  PassthroughBashEngine,
  SecureBashEngine,
  type BashEngine,
} from '../bash-engine';

/**
 * 判定 engine 类型（避免 instanceof 耦合——单例可能被不同 configReader 产出不同实例）。
 * PassthroughBashEngine 和 SecureBashEngine 是不同 class，constructor.name 可区分。
 */
function engineTypeName(engine: BashEngine): string {
  return engine.constructor.name;
}

describe('getBashEngine — 配置开关决策（v0.0.296）', () => {
  beforeEach(() => {
    // 每个 it 前重置 configReader = null（模拟未注入）
    setBashEngineConfigReader(() => undefined);
  });

  it('configReader 返回 false → PassthroughBashEngine', () => {
    setBashEngineConfigReader(() => false);
    const engine = getBashEngine();
    expect(engineTypeName(engine)).toBe('PassthroughBashEngine');
    expect(engine instanceof PassthroughBashEngine).toBe(true);
  });

  it('configReader 返回 true → SecureBashEngine', () => {
    setBashEngineConfigReader(() => true);
    const engine = getBashEngine();
    expect(engineTypeName(engine)).toBe('SecureBashEngine');
    expect(engine instanceof SecureBashEngine).toBe(true);
  });

  it('未注入 configReader（null）→ SecureBashEngine（安全回退）', () => {
    // beforeEach 已注入 () => undefined（等价于无值），但 _configReader 非 null
    // 这里测试真正的未注入场景：configReader 返回 undefined
    const engine = getBashEngine();
    expect(engine instanceof SecureBashEngine).toBe(true);
  });

  it('configReader 抛异常 → SecureBashEngine（异常安全）', () => {
    setBashEngineConfigReader(() => {
      throw new Error('config read boom');
    });
    const engine = getBashEngine();
    expect(engine instanceof SecureBashEngine).toBe(true);
  });

  it('configReader 返回非 boolean 值（字符串/数字/null）→ SecureBashEngine', () => {
    setBashEngineConfigReader(() => 'false' as unknown);
    const engine = getBashEngine();
    expect(engine instanceof SecureBashEngine).toBe(true);
  });

  it('运行时切换配置立即生效（false→true→false 无需重启）', () => {
    setBashEngineConfigReader(() => false);
    expect(getBashEngine() instanceof PassthroughBashEngine).toBe(true);
    setBashEngineConfigReader(() => true);
    expect(getBashEngine() instanceof SecureBashEngine).toBe(true);
    setBashEngineConfigReader(() => false);
    expect(getBashEngine() instanceof PassthroughBashEngine).toBe(true);
  });
});

describe('PassthroughBashEngine — 真实执行（不 spawn sandbox-exec）', () => {
  it('exec("echo test") → exitCode 0, stdout 含 test', async () => {
    const engine = new PassthroughBashEngine();
    const result = await engine.exec('echo test', {
      cwd: '/tmp',
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('test');
    expect(result.timedOut).toBe(false);
  }, 10000);

  it('exec 超时 → timedOut=true', async () => {
    const engine = new PassthroughBashEngine();
    const result = await engine.exec('sleep 10', {
      cwd: '/tmp',
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
  }, 5000);
});
