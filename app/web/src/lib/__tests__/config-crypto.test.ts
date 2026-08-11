/**
 * config-crypto 单测（v0.0.318）。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D2
 *
 * 校验点：
 *   - encryptConfig/decryptConfig 往返一致
 *   - wrapExport 产 {v:1, payload}
 *   - unwrapExport 校验 v 版本
 *   - 错误 payload throw 可读 message
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  encryptConfig,
  decryptConfig,
  wrapExport,
  unwrapExport,
  type ConfigExportData,
} from '../config-crypto';

// jsdom 环境需要 crypto.subtle polyfill
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    const webcrypto = require('node:crypto').webcrypto;
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: true });
  }
});

function makeSampleData(): ConfigExportData {
  return {
    v: 1,
    exportedAt: '2026-08-10T12:00:00.000Z',
    providers: [
      {
        label: 'Test Provider',
        name: 'anthropic_compatible',
        protocolId: 'anthropic_messages',
        baseUrl: 'https://api.example.com',
        credentials: { key: 'sk-test-key' },
        enabled: true,
        models: [
          { modelId: 'claude-3', contextWindow: 200000, maxOutputTokens: 8192, label: 'Claude 3', enabled: true },
        ],
      },
    ],
    tools: { web_search: { type: 'zhipu_api' } },
  };
}

describe('config-crypto — AES-256-CBC 加解密（v0.0.318）', () => {
  it('encryptConfig → decryptConfig 往返一致', async () => {
    const data = makeSampleData();
    const encrypted = await encryptConfig(data);
    const decrypted = await decryptConfig(encrypted);
    expect(decrypted).toEqual(data);
  });

  it('每次加密 IV 不同 → 密文不同', async () => {
    const data = makeSampleData();
    const enc1 = await encryptConfig(data);
    const enc2 = await encryptConfig(data);
    expect(enc1).not.toEqual(enc2);
  });

  it('wrapExport 产 {v:1, payload:string}', async () => {
    const data = makeSampleData();
    const file = await wrapExport(data);
    expect(file.v).toBe(1);
    expect(typeof file.payload).toBe('string');
    expect(file.payload.length).toBeGreaterThan(0);
  });

  it('wrapExport → unwrapExport 往返一致', async () => {
    const data = makeSampleData();
    const file = await wrapExport(data);
    const unwrapped = await unwrapExport(file);
    expect(unwrapped).toEqual(data);
  });

  it('unwrapExport 非 config 文件 → throw 可读 message', async () => {
    await expect(unwrapExport({ foo: 'bar' })).rejects.toThrow('文件格式不正确');
  });

  it('unwrapExport 版本不兼容 → throw 可读 message', async () => {
    await expect(unwrapExport({ v: 2, payload: 'abc' })).rejects.toThrow('文件版本不兼容');
  });

  it('unwrapExport 损坏 payload → throw 可读 message', async () => {
    await expect(unwrapExport({ v: 1, payload: '!!!corrupted!!!' })).rejects.toThrow('文件已损坏或被修改');
  });

  it('unwrapExport null 输入 → throw 可读 message', async () => {
    await expect(unwrapExport(null)).rejects.toThrow('文件格式不正确');
  });
});
