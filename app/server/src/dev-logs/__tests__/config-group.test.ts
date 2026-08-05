/**
 * config logs group 单测（spec dev-logs §7 config 部分）
 * 参考: specs/tech/config/[P0]app_config.md §3.8（logs group schema）
 *       specs/tech/app/dev-logs/[P0]overall.md §2.4（可选覆盖 `?? false`）
 *
 * 校验点：
 *   - logs group 读默认 false（record 缺失 `?? false`）
 *   - override 生效（set true 后 get 返 true）
 *   - 4 个 key 都能独立 set/get
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { AppConfigService } from '../../config/app-config-service';

describe('config logs group（spec dev-logs §7 config）', () => {
  let dataDir: string;
  let svc: AppConfigService;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-logscfg-'));
    svc = new AppConfigService({ root: dataDir });
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('record 缺失时 get 返 undefined（消费方 ?? false）', () => {
    expect(svc.get('logs', 'enableLlmRequestLog')).toBeUndefined();
    expect(svc.get('logs', 'enableToolResultLog')).toBeUndefined();
    expect(svc.get('logs', 'enableAppApiLog')).toBeUndefined();
    expect(svc.get('logs', 'enableEventLog')).toBeUndefined();
    // 消费方 LogWriter 用 `?? false`，false 即关闭
    expect(svc.get('logs', 'enableLlmRequestLog') ?? false).toBe(false);
  });

  it('set true 后 get 返 true（override 生效）', () => {
    svc.set('logs', 'enableLlmRequestLog', true);
    expect(svc.get('logs', 'enableLlmRequestLog')).toBe(true);
  });

  it('4 个 key 独立 set/get（互不影响）', () => {
    svc.set('logs', 'enableLlmRequestLog', true);
    svc.set('logs', 'enableAppApiLog', true);
    // 未 set 的仍 undefined
    expect(svc.get('logs', 'enableToolResultLog')).toBeUndefined();
    expect(svc.get('logs', 'enableEventLog')).toBeUndefined();
    expect(svc.get('logs', 'enableLlmRequestLog')).toBe(true);
    expect(svc.get('logs', 'enableAppApiLog')).toBe(true);
  });

  it('setGroup 整组提交（4 key 一起写）', () => {
    svc.setGroup('logs', [
      { key: 'enableLlmRequestLog', data: true },
      { key: 'enableToolResultLog', data: false },
      { key: 'enableAppApiLog', data: true },
      { key: 'enableEventLog', data: false },
    ]);
    expect(svc.get('logs', 'enableLlmRequestLog')).toBe(true);
    expect(svc.get('logs', 'enableToolResultLog')).toBe(false);
    expect(svc.get('logs', 'enableAppApiLog')).toBe(true);
    expect(svc.get('logs', 'enableEventLog')).toBe(false);
  });

  it('listGroup 列出已落盘 key', () => {
    svc.set('logs', 'enableLlmRequestLog', true);
    const items = svc.listGroup('logs');
    expect(items.length).toBe(1);
    expect(items[0]!.key).toBe('enableLlmRequestLog');
    expect(items[0]!.data).toBe(true);
  });
});
