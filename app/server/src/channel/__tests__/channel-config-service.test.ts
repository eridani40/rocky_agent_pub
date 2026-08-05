/**
 * ChannelConfigService 单测：CRUD + appSecret redact（service 层）
 * 参考: specs/tech/channel/[P0]channel_manager.md §3.7
 *       app/server/src/config/connector-config-service.ts（同款套路）
 *
 * 覆盖：
 *   1. create：ulid + enabled 默认 true
 *   2. get：返明文 appSecret（secret mask 收敛到前端展示层）
 *   3. getRaw：返未 redact 的原值（ChannelManager.connect 读凭证用）
 *   4. list：全部 instance，appSecret 明文
 *   5. update：merge patch
 *   6. setEnabled：toggle intent（专用方法）
 *   7. delete
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelConfigService } from '../channel-config-service';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'channel-config-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ChannelConfigService', () => {
  it('create：ulid + enabled 默认 true', () => {
    const svc = new ChannelConfigService({ root: tmpRoot });
    const inst = svc.create({
      implId: 'feishu',
      name: '公司 IM',
      config: { appId: 'app123', appSecret: 'secret-real-value' },
    });
    expect(inst.id).toBeTruthy();
    expect(inst.id.length).toBeGreaterThan(10);
    expect(inst.implId).toBe('feishu');
    expect(inst.enabled).toBe(true);
    expect(inst.config.appId).toBe('app123');
  });

  it('get：返明文 appSecret（secret mask 收敛前端展示层）', () => {
    const svc = new ChannelConfigService({ root: tmpRoot });
    const created = svc.create({
      implId: 'feishu',
      name: 'X',
      config: { appId: 'app123', appSecret: 'secret-real-value' },
    });
    const got = svc.get(created.id);
    expect(got?.config.appSecret).toBe('secret-real-value'); // 明文
    expect(got?.config.appId).toBe('app123');
  });

  it('getRaw：返未 redact 的原值（impl connect 读凭证用）', () => {
    const svc = new ChannelConfigService({ root: tmpRoot });
    const created = svc.create({
      implId: 'feishu',
      name: 'X',
      config: { appId: 'app123', appSecret: 'secret-real-value' },
    });
    const raw = svc.getRaw(created.id);
    expect(raw?.config.appSecret).toBe('secret-real-value');
  });

  it('list：全部 instance，appSecret 明文', () => {
    const svc = new ChannelConfigService({ root: tmpRoot });
    svc.create({
      implId: 'feishu', name: 'A',
      config: { appId: 'app_a', appSecret: 'secret_a' },
    });
    svc.create({
      implId: 'feishu', name: 'B',
      config: { appId: 'app_b', appSecret: 'secret_b' },
    });
    const list = svc.list();
    expect(list.length).toBe(2);
    const secrets = list.map((i) => i.config.appSecret).sort();
    expect(secrets).toEqual(['secret_a', 'secret_b']); // 明文，非 ***
  });

  it('update：merge patch', () => {
    const svc = new ChannelConfigService({ root: tmpRoot });
    const created = svc.create({
      implId: 'feishu', name: 'X',
      config: { appId: 'a1', appSecret: 's1' },
    });
    const updated = svc.update(created.id, { name: 'New Name', enabled: false });
    expect(updated?.name).toBe('New Name');
    expect(updated?.enabled).toBe(false);
    expect(updated?.implId).toBe('feishu'); // 未传的字段保留
  });

  it('setEnabled：toggle intent（专用方法）', () => {
    const svc = new ChannelConfigService({ root: tmpRoot });
    const created = svc.create({
      implId: 'feishu', name: 'X',
      config: { appId: 'a1', appSecret: 's1' },
    });
    svc.setEnabled(created.id, false);
    expect(svc.get(created.id)?.enabled).toBe(false);
    svc.setEnabled(created.id, true);
    expect(svc.get(created.id)?.enabled).toBe(true);
  });

  it('delete：返回是否实际删除', () => {
    const svc = new ChannelConfigService({ root: tmpRoot });
    const created = svc.create({
      implId: 'feishu', name: 'X',
      config: { appId: 'a1', appSecret: 's1' },
    });
    expect(svc.delete(created.id)).toBe(true);
    expect(svc.get(created.id)).toBeUndefined();
    // 二次删返 false（已不存在）
    expect(svc.delete(created.id)).toBe(false);
  });

  it('跨实例隔离：new 同 root 恢复全部 instance', () => {
    let svc = new ChannelConfigService({ root: tmpRoot });
    svc.create({
      implId: 'feishu', name: 'A',
      config: { appId: 'a1', appSecret: 's1' },
    });
    // 模拟重启
    svc = new ChannelConfigService({ root: tmpRoot });
    const list = svc.list();
    expect(list.length).toBe(1);
    expect(list[0]?.name).toBe('A');
  });
});
