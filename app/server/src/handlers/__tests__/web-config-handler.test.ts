/**
 * app_config web group handler 集成测试（白盒：真实 AppConfigService + handler）。
 * 参考: specs/tech/config/[P0]app_config.md §3.5（web group：3 key + jinaApiKey secret）
 *       specs/api/version_logs/v0.0.23/change_log.md §2（GET/PUT 端点行为 + redact 语义）
 *
 * 覆盖（task 指令 UT 清单）：
 *   1. 3 key CRUD：jinaApiKey / jinaEnabled / jinaTimeoutMs GET（单值/整组）+ PUT（单/整组）
 *   2. jinaApiKey secret：GET 明文返回（与 observability 一致）；PUT 占位 '***' 保留原值；PUT 明文写盘
 *   3. jinaEnabled / jinaTimeoutMs 缺省回退默认（true/20000）—— service 层不回退，
 *      消费方侧 `?? CODE_DEFAULT`，故 GET 缺失返 null（断言 service 行为符合 app_config.md §4）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { AppConfigService } from '../../config/app-config-service';
import { handleKvConfig, handleKvConfigPut } from '../config';

let tmpRoot: string;
let dev: AppConfigService;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-config-handler-'));
  dev = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造 GET Request（带 query） */
function makeGet(group: string, key?: string): Request {
  const url = new URL('http://test/config/app');
  url.searchParams.set('group', group);
  if (key !== undefined) url.searchParams.set('key', key);
  return new Request(url.toString(), { method: 'GET' });
}

/** 构造 PUT Request */
function makePut(body: unknown): Request {
  return new Request('http://test/config/app', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 解析 JSON 响应体 */
async function body(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe('app_config web group: handler 集成 (GET/PUT)', () => {
  it('PUT 整组提交 3 key + GET 整组返回（jinaApiKey 明文）', async () => {
    const putRes = await handleKvConfigPut(
      makePut({
        group: 'web',
        items: [
          { key: 'jinaApiKey', data: 'jina-real-secret-xyz' },
          { key: 'jinaEnabled', data: false },
          { key: 'jinaTimeoutMs', data: 30000 },
        ],
      }),
      dev,
    );
    expect(putRes.status).toBe(200);
    expect(await body(putRes)).toEqual({ ok: true });

    // 整组 GET：jinaApiKey 明文返回（secret mask 收敛到前端展示层），其余明文
    const res = handleKvConfig(makeGet('web'), 'GET', new URL('http://test/?group=web'), dev);
    expect(res.status).toBe(200);
    const b = await body(res);
    const byKey = Object.fromEntries(b.items.map((i: any) => [i.key, i.data]));
    expect(byKey.jinaApiKey).toBe('jina-real-secret-xyz'); // 明文
    expect(byKey.jinaEnabled).toBe(false); // 明文
    expect(byKey.jinaTimeoutMs).toBe(30000); // 明文

    // 落盘原值未被 redact 污染（service 读到的是真值）
    expect(dev.get('web', 'jinaApiKey')).toBe('jina-real-secret-xyz');
  });

  it('PUT 单 key jinaApiKey + GET 单值明文', async () => {
    const putRes = await handleKvConfigPut(
      makePut({ group: 'web', key: 'jinaApiKey', data: 'plain-key-123' }),
      dev,
    );
    expect(putRes.status).toBe(200);

    const res = handleKvConfig(makeGet('web', 'jinaApiKey'), 'GET', new URL('http://test/?group=web&key=jinaApiKey'), dev);
    const b = await body(res);
    expect(b.value).toBe('plain-key-123'); // 明文出参（mask 收敛前端）
    expect(dev.get('web', 'jinaApiKey')).toBe('plain-key-123'); // 落盘原值
  });

  it('PUT 单 key jinaEnabled / jinaTimeoutMs + GET 明文（非 secret）', async () => {
    await handleKvConfigPut(makePut({ group: 'web', key: 'jinaEnabled', data: true }), dev);
    await handleKvConfigPut(makePut({ group: 'web', key: 'jinaTimeoutMs', data: 20000 }), dev);

    const r1 = handleKvConfig(makeGet('web', 'jinaEnabled'), 'GET', new URL('http://x/?group=web&key=jinaEnabled'), dev);
    expect((await body(r1)).value).toBe(true);
    const r2 = handleKvConfig(makeGet('web', 'jinaTimeoutMs'), 'GET', new URL('http://x/?group=web&key=jinaTimeoutMs'), dev);
    expect((await body(r2)).value).toBe(20000);
  });

  it('jinaApiKey PUT 占位 *** → 保留落盘原值（不被空/占位覆盖）', async () => {
    // 先存真值
    await handleKvConfigPut(
      makePut({ group: 'web', key: 'jinaApiKey', data: 'original-key-999' }),
      dev,
    );
    // 整组提交，jinaApiKey 送占位（前端未改），同时改 jinaEnabled
    await handleKvConfigPut(
      makePut({
        group: 'web',
        items: [
          { key: 'jinaApiKey', data: '***' }, // 占位 → 保留原值
          { key: 'jinaEnabled', data: true }, // 真值改动
        ],
      }),
      dev,
    );
    // 落盘原值保留
    expect(dev.get('web', 'jinaApiKey')).toBe('original-key-999');
    expect(dev.get('web', 'jinaEnabled')).toBe(true);
  });

  it('jinaApiKey PUT 单 key 占位 *** → 保留落盘原值', async () => {
    await handleKvConfigPut(
      makePut({ group: 'web', key: 'jinaApiKey', data: 'first-key' }),
      dev,
    );
    await handleKvConfigPut(
      makePut({ group: 'web', key: 'jinaApiKey', data: '***' }),
      dev,
    );
    expect(dev.get('web', 'jinaApiKey')).toBe('first-key'); // 未被覆盖
  });

  it('jinaApiKey PUT 占位 *** 但落盘缺失 → 写空串（防御性）', async () => {
    await handleKvConfigPut(
      makePut({ group: 'web', key: 'jinaApiKey', data: '***' }),
      dev,
    );
    expect(dev.get('web', 'jinaApiKey')).toBe('');
  });

  it('jinaApiKey PUT 新明文 → 覆盖落盘原值', async () => {
    await handleKvConfigPut(
      makePut({ group: 'web', key: 'jinaApiKey', data: 'old-key' }),
      dev,
    );
    await handleKvConfigPut(
      makePut({ group: 'web', key: 'jinaApiKey', data: 'new-key-456' }),
      dev,
    );
    expect(dev.get('web', 'jinaApiKey')).toBe('new-key-456');
  });

  it('缺省回退：web group 记录全部不存在 → GET 单值返 null（service 不域特化，消费方自走 ?? CODE_DEFAULT）', () => {
    const r1 = handleKvConfig(makeGet('web', 'jinaEnabled'), 'GET', new URL('http://x/?group=web&key=jinaEnabled'), dev);
    // 同步返回，body 是 Promise；用 then 断言
    return expect(r1.json()).resolves.toEqual({ value: null });
  });

  it('缺省回退：service.get 返 undefined（消费方 `?? true` / `?? 20000`）', () => {
    expect(dev.get('web', 'jinaEnabled')).toBeUndefined();
    expect(dev.get('web', 'jinaTimeoutMs')).toBeUndefined();
    expect(dev.get('web', 'jinaApiKey')).toBeUndefined();
    // 消费方用法示意（app_config.md §4）：const enabled = svc.get('web','jinaEnabled') ?? true;
    expect(dev.get('web', 'jinaEnabled') ?? true).toBe(true);
    expect(dev.get('web', 'jinaTimeoutMs') ?? 20000).toBe(20000);
  });

  it('GET 整组空 group → 空列表（web shard 无记录）', async () => {
    const res = handleKvConfig(makeGet('web'), 'GET', new URL('http://x/?group=web'), dev);
    const b = await body(res);
    expect(b.items).toEqual([]);
  });

  it('CRUD 更新：jinaTimeoutMs 多次 set 覆盖', async () => {
    await handleKvConfigPut(makePut({ group: 'web', key: 'jinaTimeoutMs', data: 10000 }), dev);
    await handleKvConfigPut(makePut({ group: 'web', key: 'jinaTimeoutMs', data: 45000 }), dev);
    expect(dev.get('web', 'jinaTimeoutMs')).toBe(45000);
  });
});
