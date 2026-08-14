/**
 * AttachModeImpl 单元测试（白盒，全 mock env/attachDriver，不真连 Chrome）
 * 参考: specs/tech/version_logs/v0.0.266/change_plan.md Delta（registry 重构：attach 用例迁移）
 *       specs/tech/agent/tools/[P1]browser_tool.md §4（ChromeMcpDriver connect/close 语义）
 *
 * 覆盖（从 instance-manager.test.ts attach 段迁移，保持覆盖度）：
 *   ① launch：switch 门禁 enabled=false → not_enabled；驱动缺省 → attach_failed（fail-closed）
 *   ② launch connect 成功 → handle（session 承载）；connect 失败 → attach_failed
 *   ③ execute：dispatch 到 session 方法（navigate/listPages/click/type/evaluate/snapshot/selectPage）
 *   ④ execute 失活（connection closed）→ 置 dead + attach_lost 引导文案
 *   ⑤ execute 非失活错误 → 原样透传（不置 dead）
 *   ⑥ execute screenshot → ctx.snapshot.save + 路径文本
 *   ⑦ close：disconnect 调 + 幂等（不杀 chrome/不删目录/不释放端口/不持久化）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserSession, BrowserConnectOptions, SnapshotResult, PersistedInstanceRecord } from '../types';
import type { ChromeMcpDriver } from '../chrome-mcp-driver';
import type { ModeImplEnv } from '../mode-impl';
import type { DetectDeps } from '../attach-debug-state';
import { AttachModeImpl, type AttachHandle, type AttachKillDeps } from '../attach-mode-impl';
import { BrowserInstanceLedger } from '../instance-ledger';
import { BunSqlDriver } from '../../../persistence/search-sql-driver';

/** mock ChromeMcpDriver（attachDriver）：connect/disconnect + session 方法记录调用 */
function makeDriver(connectResult: 'success' | 'fail' = 'success', mcpPid?: number, spawnPid?: number) {
  const fakeSession: BrowserSession = {
    listPages: vi.fn(async () => [{ id: 'p1', url: 'https://x', selected: true }]),
    selectPage: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
    snapshot: vi.fn(async (): Promise<SnapshotResult> => ({ snapshot: '- button "Go"', refs: { b1: { role: 'button', name: 'Go', nth: 0 } } })),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    evaluate: vi.fn(async () => 42),
    close: vi.fn(async () => {}),
  };
  return {
    connect: vi.fn(async (opts?: BrowserConnectOptions): Promise<BrowserSession> => {
      if (connectResult === 'fail') throw new Error('ECONNREFUSED 9222');
      return fakeSession;
    }),
    disconnect: vi.fn(async (_opts?: BrowserConnectOptions): Promise<void> => {}),
    // B7/B8：driver 透传最近一次 connect 的 MCP 子进程 pid（attach 台账锚点；UT 可注入）
    getLastMcpPid: vi.fn((): number | undefined => mcpPid),
    // v0.0.337 H5：driver 透传最近一次 spawn 的 pid（含失败；H9 失败入台账兜底锚点）
    getLastSpawnPid: vi.fn((): number | undefined => spawnPid),
    fakeSession,
  };
}

/** 测试临时 dataDir + 真实 sqlite ledger（v0.0.334 B9：attach 入台账断言） */
let dataDir: string;
let ledger: BrowserInstanceLedger;
let sqlDriver: BunSqlDriver;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'attach-impl-ut-'));
  sqlDriver = await BunSqlDriver.create(join(dataDir, 'browser.sqlite'));
  ledger = new BrowserInstanceLedger(sqlDriver);
});
afterEach(() => {
  vi.restoreAllMocks();
  sqlDriver.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** mock env（attachDriver/isAttachEnabled 注入；now 可控；ledger 真实 sqlite） */
function makeEnv(over: Partial<ModeImplEnv> = {}): ModeImplEnv {
  return { dataDir, now: () => 1_000, ledger, ...over } as ModeImplEnv;
}

/** 构造 impl + 默认 env（attachDriver + enabled）；detectDeps 可注入（U7 残留检测 mock） */
function makeImpl(opts: {
  connectResult?: 'success' | 'fail';
  enabled?: boolean;
  detectDeps?: DetectDeps;
  mcpPid?: number;
  spawnPid?: number; // v0.0.337 H5：失败透传 spawn pid（H9 失败入台账锚点）
} = {}) {
  const driver = makeDriver(opts.connectResult ?? 'success', opts.mcpPid, opts.spawnPid);
  const impl = new AttachModeImpl(opts.detectDeps ?? {});
  const env = makeEnv({
    attachDriver: driver as unknown as ChromeMcpDriver,
    isAttachEnabled: () => opts.enabled ?? true,
  });
  return { impl, env, driver };
}

describe('AttachModeImpl launch', () => {
  it('connect 成功 → handle（session 承载 + ready）；不持久化', async () => {
    const { impl, env, driver } = makeImpl();
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('launched');
    expect(driver.connect).toHaveBeenCalledTimes(1);
    const ah = r.handle as AttachHandle;
    expect(ah.key).toBe('sA:attach');
    expect(ah.mode).toBe('attach');
    expect(ah.state).toBe('ready');
    expect(ah.session).toBe(driver.fakeSession);
  });

  it('[v0.0.334 B9] connect 成功且拿到 mcpPid → 入台账（mode=attach, worker_pid=mcpPid）；handle.mcpPid 存储', async () => {
    const { impl, env, driver } = makeImpl({ mcpPid: 4242 });
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ah = r.handle as AttachHandle;
    expect(ah.mcpPid).toBe(4242);
    const records = ledger.listAll();
    expect(records).toHaveLength(1);
    expect(records[0]!.key).toBe('sA:attach');
    expect(records[0]!.mode).toBe('attach');
    expect(records[0]!.workerPid).toBe(4242);
    expect(records[0]!.userDataDir).toBeUndefined(); // attach 无目录
    expect(records[0]!.cdpPort).toBeUndefined(); // attach 无端口
  });

  it('[v0.0.334 B9] connect 成功但无 mcpPid → 不入台账（缺 pid 不阻塞 launch）', async () => {
    const { impl, env } = makeImpl(); // mcpPid undefined（mock driver 无 getLastMcpPid 值）
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(true);
    expect(ledger.listAll()).toHaveLength(0);
  });

  it('switch=off → not_enabled；driver.connect 未调', async () => {
    const { impl, env, driver } = makeImpl({ enabled: false });
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('not_enabled');
      expect(r.error?.message).toContain('未启用');
    }
    expect(driver.connect).not.toHaveBeenCalled();
  });

  it('attachDriver 缺省 → attach_failed（fail-closed）', async () => {
    const impl = new AttachModeImpl();
    const env = makeEnv({ isAttachEnabled: () => true });
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_failed');
    }
  });

  it('connect 失败 → attach_failed + message 透传', async () => {
    const { impl, env } = makeImpl({ connectResult: 'fail' });
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_failed');
      expect(r.error?.message).toContain('ECONNREFUSED');
    }
  });

  // ---- v0.0.337 H9：launch 失败入台账（spawnPid 存在 → insert 不 delete，留给启动自检回收） ----
  it('[v0.0.337 H9] launch 失败 + spawnPid 存在 → ledger.insert 被调（key/workerPid=spawnPid）；不 delete', async () => {
    const { impl, env } = makeImpl({ connectResult: 'fail', spawnPid: 4242 });
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_failed');
    }
    // 失败入台账（进程可能残留 → 启动自检 cleanupOrphan 兜底回收）
    const records = ledger.listAll();
    expect(records).toHaveLength(1);
    expect(records[0]!.key).toBe('sA:attach');
    expect(records[0]!.mode).toBe('attach');
    expect(records[0]!.workerPid).toBe(4242);
    // 不 delete（delete 只发生在启动自检 cleanupOrphan / close 成功路径）
    expect(ledger.listAll()).toHaveLength(1);
  });

  it('[v0.0.337 H9] launch 失败但无 spawnPid → 不入台账（缺 pid 不阻塞 return error）', async () => {
    const { impl, env } = makeImpl({ connectResult: 'fail' }); // 无 spawnPid
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_failed');
    }
    expect(ledger.listAll()).toHaveLength(0);
  });

  it('[v0.0.337 H9] launch 失败入台账 insert 抛错 → warn 不阻断 return error（best-effort）', async () => {
    const { impl, env, driver } = makeImpl({ connectResult: 'fail', spawnPid: 4242 });
    // ledger.insert 抛错 → best-effort warn（不阻断 attach_failed 返回）
    const insertSpy = vi.spyOn(ledger, 'insert').mockImplementation(() => {
      throw new Error('insert boom');
    });
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_failed');
    }
    expect(insertSpy).toHaveBeenCalledTimes(1);
    insertSpy.mockRestore();
  });

  // ---- v0.0.337 H6：launch signal 透传（attach 超时 abort 感知） ----
  it('[v0.0.337 H6] launch signal 透传 → connectAttachSession → driver.connect({userDataDir}, signal)', async () => {
    const { impl, env, driver } = makeImpl();
    const ac = new AbortController();
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env, ac.signal);
    expect(r.ok).toBe(true);
    expect(driver.connect).toHaveBeenCalledTimes(1);
    // signal 透传到 driver.connect 第二参
    expect(driver.connect).toHaveBeenCalledWith(expect.anything(), ac.signal);
  });
});

describe('AttachModeImpl execute', () => {
  it('navigate → dispatch 到 session.navigate + ok', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const r = await impl.execute(lr.handle, 'navigate', { url: 'https://x' }, {});
    expect(r.ok).toBe(true);
    expect(r.text).toContain('navigated');
    expect(driver.fakeSession.navigate).toHaveBeenCalledWith('https://x');
  });

  it('listPages / snapshot / click / type / evaluate / selectPage 全 dispatch', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const r1 = await impl.execute(lr.handle, 'listPages', {}, {});
    expect(r1.ok).toBe(true);
    expect(driver.fakeSession.listPages).toHaveBeenCalledTimes(1);
    const r2 = await impl.execute(lr.handle, 'snapshot', {}, {});
    expect(r2.ok).toBe(true);
    expect(JSON.parse(r2.text!).snapshot).toContain('Go');
    const r3 = await impl.execute(lr.handle, 'click', { ref: 'b1' }, {});
    expect(r3.ok).toBe(true);
    expect(driver.fakeSession.click).toHaveBeenCalledWith('b1');
    const r4 = await impl.execute(lr.handle, 'type', { ref: 'inp', text: 'hi' }, {});
    expect(r4.ok).toBe(true);
    expect(driver.fakeSession.type).toHaveBeenCalledWith('inp', 'hi');
    const r5 = await impl.execute(lr.handle, 'evaluate', { text: '1+1' }, {});
    expect(r5.ok).toBe(true);
    expect(driver.fakeSession.evaluate).toHaveBeenCalledWith('1+1');
    const r6 = await impl.execute(lr.handle, 'selectPage', { ref: 'p1' }, {});
    expect(r6.ok).toBe(true);
    expect(driver.fakeSession.selectPage).toHaveBeenCalledWith('p1');
  });

  it('失活（connection closed）→ 置 dead + attach_lost 引导文案', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    driver.fakeSession.listPages = vi.fn(async () => {
      throw new Error('connection closed');
    });
    const r = await impl.execute(lr.handle, 'listPages', {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_lost');
      expect(r.error?.message).toContain('连接已断开');
      expect(r.error?.message).toContain('重新 launch');
    }
    expect(lr.handle.state).toBe('dead'); // 失活置 dead（manager 收尾 close）
  });

  it('[v0.0.334 fix Bug2] 失活即时清账：ledger.delete(handle.key) + env.discardInstance(handle.key) 被调 + return attach_lost', async () => {
    const discardSpy = vi.fn((_key: string) => {});
    // launch 用含 discardInstance + 真实 ledger 的 env（execute 无 env，清账靠 launch 缓存）
    const driver = makeDriver('success', 4242); // mcpPid → launch 入台账
    const impl = new AttachModeImpl();
    const env = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
      discardInstance: discardSpy,
    });
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    expect(ledger.listAll()).toHaveLength(1); // launch 已入台账
    // 触发失活
    driver.fakeSession.listPages = vi.fn(async () => {
      throw new Error('connection closed');
    });
    const r = await impl.execute(lr.handle, 'listPages', {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_lost');
    }
    expect(lr.handle.state).toBe('dead');
    // 即时清账：台账硬删（失活前 1 条 → 失活后 0 条）
    expect(ledger.listAll()).toHaveLength(0);
    // 即时摘表：discardInstance 被调（handle.key）
    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(discardSpy).toHaveBeenCalledWith('sA:attach');
  });

  it('[v0.0.334 fix Bug2] 失活清账幂等：ledger.delete / discardInstance 重复调不抛（兼容 close 兜底再删 no-op）', async () => {
    const discardSpy = vi.fn((_key: string) => {});
    const driver = makeDriver('success', 4242);
    const impl = new AttachModeImpl();
    const env = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
      discardInstance: discardSpy,
    });
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    driver.fakeSession.listPages = vi.fn(async () => {
      throw new Error('connection closed');
    });
    // 第一次失活：清账
    const r1 = await impl.execute(lr.handle, 'listPages', {}, {});
    expect(r1.ok).toBe(false);
    expect(ledger.listAll()).toHaveLength(0);
    expect(discardSpy).toHaveBeenCalledTimes(1);
    // 第二次失活（同 handle 再 execute）：ledger.delete 空表 no-op 不抛 + discardInstance 再调幂等
    await expect(impl.execute(lr.handle, 'listPages', {}, {})).resolves.toMatchObject({ ok: false });
    expect(ledger.listAll()).toHaveLength(0);
    expect(discardSpy).toHaveBeenCalledTimes(2); // 每次失活都调（map.delete 不存在 key no-op 幂等）
  });

  it('[v0.0.334 fix Bug2] 失活清账 best-effort：ledger.delete 抛错仍 return attach_lost 不阻断', async () => {
    // 构造会抛错的 ledger（best-effort 验证）
    const badLedger = {
      insert: () => {},
      delete: () => { throw new Error('sqlite locked'); },
      listAll: () => [],
      clearAll: () => {},
    } as unknown as BrowserInstanceLedger;
    const driver = makeDriver();
    const impl = new AttachModeImpl();
    const env = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
      ledger: badLedger,
      discardInstance: vi.fn(),
    });
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    driver.fakeSession.listPages = vi.fn(async () => {
      throw new Error('connection closed');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await impl.execute(lr.handle, 'listPages', {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_lost'); // delete 失败不阻断 attach_lost
    }
    expect(lr.handle.state).toBe('dead');
    expect(warnSpy).toHaveBeenCalled(); // best-effort warn 记录
    warnSpy.mockRestore();
  });

  it('非失活错误 → 原样透传（不置 dead）', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    driver.fakeSession.click = vi.fn(async () => {
      throw new Error('ref not found: b9');
    });
    const r = await impl.execute(lr.handle, 'click', { ref: 'b9' }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('unknown');
      expect(r.error?.message).toContain('ref not found');
    }
    expect(lr.handle.state).toBe('ready'); // 非失活不置 dead
  });

  it('未知 action → unknown_action error', async () => {
    const { impl, env } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const r = await impl.execute(lr.handle, 'fly', {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('unknown_action');
    }
  });

  it('screenshot → ctx.snapshot.save + 路径文本（无 base64 inline）', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    driver.fakeSession.screenshot = vi.fn(async () => ({ mime: 'image/png', data: pngBytes }));
    const save = vi.fn(async (_data: Buffer | string, _mediaType: string) => ({ relPath: 'snapshots/call_attach_1.png' }));
    const r = await impl.execute(lr.handle, 'screenshot', {}, { snapshot: { save } });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('snapshots/call_attach_1.png');
    expect(r.text).toContain('see_image');
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0]![0] as Buffer).equals(pngBytes)).toBe(true);
    expect(save.mock.calls[0]![1]).toBe('image/png');
  });

  it('session 无 screenshot 方法 → unsupported error', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    delete (driver.fakeSession as { screenshot?: unknown }).screenshot;
    const r = await impl.execute(lr.handle, 'screenshot', {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('unsupported');
      expect(r.error?.message).toContain('不支持');
    }
  });
});

describe('AttachModeImpl close', () => {
  it('close → disconnect 调 + 置 dead；不删目录/不释放端口/不持久化', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const env2 = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
    });
    await impl.close(lr.handle, env2);
    expect(driver.disconnect).toHaveBeenCalledTimes(1);
    expect(lr.handle.state).toBe('dead');
  });

  it('[v0.0.334 B9] close → 台账硬删（disconnect 后 ledger.delete）', async () => {
    const { impl, env, driver } = makeImpl({ mcpPid: 4242 });
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    expect(ledger.listAll()).toHaveLength(1); // launch 已入台账
    const env2 = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
    });
    await impl.close(lr.handle, env2);
    expect(driver.disconnect).toHaveBeenCalledTimes(1);
    expect(ledger.listAll()).toHaveLength(0); // close 硬删（DELETE 非 soft）
  });

  it('close 幂等：二次 close no-op（disconnect 内部幂等 + state dead）', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const env2 = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
    });
    await impl.close(lr.handle, env2);
    await impl.close(lr.handle, env2); // 二次 close：disconnect 再调（driver 层幂等）
    expect(lr.handle.state).toBe('dead');
  });

  it('attachDriver 缺省 → close no-op（disconnect 不调不抛；注入无残留检测 → {ok:true} 无 text）', async () => {
    const { impl, env } = makeImpl({
      detectDeps: {
        probePort: async () => false, // 无残留（端口不可连）→ close 返回 {ok:true} 无 text
        readActivePort: async () => '9222',
        home: '/Users/ut',
        platform: 'darwin',
      },
    });
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const env2 = makeEnv({}); // 无 attachDriver
    const result = await impl.close(lr.handle, env2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBeUndefined(); // 无残留 → 无提示文本
  });

  it('[U7] close 残留检测：residual=true → {ok:true, text:引导提示文本}（含「调试态残留」+ 引导词）', async () => {
    const { impl, env, driver } = makeImpl({
      detectDeps: {
        probePort: async () => true, // TCP 探测 9222 可连 → 残留
        readActivePort: async () => '9222',
        home: '/Users/ut',
        platform: 'darwin',
      },
    });
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const env2 = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
    });
    const result = await impl.close(lr.handle, env2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.text).toBe('string');
    expect(result.text!).toContain('调试态残留');
    expect(result.text!).toContain('chrome://inspect/#remote-debugging');
    expect(result.text!).toContain('Allow remote debugging');
    expect(driver.disconnect).toHaveBeenCalledTimes(1); // 断 MCP 照常
    expect(lr.handle.state).toBe('dead');
  });

  it('[U7] close 残留检测：residual=false → {ok:true} 无 text（manager 输出 closed）', async () => {
    const { impl, env, driver } = makeImpl({
      detectDeps: {
        probePort: async () => false, // 端口不可连 → 无残留
        readActivePort: async () => '9222',
        home: '/Users/ut',
        platform: 'darwin',
      },
    });
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const env2 = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
    });
    const result = await impl.close(lr.handle, env2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBeUndefined();
    expect(driver.disconnect).toHaveBeenCalledTimes(1);
  });

  it('[v0.0.334 A13] close 恒检测残留（autoConnect-only，无显式端点跳过分支）', async () => {
    // detectDeps 返回 residual=true —— autoConnect-only 后即使 launch 无任何端点也恒检测
    const { impl, env, driver } = makeImpl({
      detectDeps: {
        probePort: async () => true,
        readActivePort: async () => '9222',
        home: '/Users/ut',
        platform: 'darwin',
      },
    });
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const env2 = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
    });
    const result = await impl.close(lr.handle, env2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.text).toBe('string');
    expect(result.text!).toContain('调试态残留');
    expect(driver.disconnect).toHaveBeenCalledTimes(1);
  });

  it('[v0.0.336 G4] close → mcpPid 存活时 killProcessGroupByPid 被调（显式杀 mcp 主进程组）', async () => {
    // DI 注入 killDeps spy（替代 spyOn ESM namespace 不可写问题）
    const isPidAliveSpy = vi.fn((_pid: number) => true);
    const killProcessGroupSpy = vi.fn((_pid: number) => {});
    const killDeps: AttachKillDeps = { isPidAlive: isPidAliveSpy, killProcessGroup: killProcessGroupSpy, execPkill: vi.fn() };
    const driver = makeDriver('success', 4242);
    const impl = new AttachModeImpl({}, killDeps);
    const env = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
    });
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const ah = lr.handle as AttachHandle;
    expect(ah.mcpPid).toBe(4242); // 确认 handle 带 mcpPid（G4 前提）
    const result = await impl.close(lr.handle, env);
    expect(result.ok).toBe(true);
    // G4：mcpPid=4242 存活 → killProcessGroupByPid(4242) 被调
    expect(isPidAliveSpy).toHaveBeenCalledWith(4242);
    expect(killProcessGroupSpy).toHaveBeenCalledWith(4242);
  });

  it('[v0.0.336 G5] close → watchdog pkill 被触发（按 --parent-pid=<mcpPid> 精确锚定）', async () => {
    const execPkillSpy = vi.fn((_cmd: string) => {});
    const killDeps: AttachKillDeps = { isPidAlive: vi.fn(() => true), killProcessGroup: vi.fn(), execPkill: execPkillSpy };
    const driver = makeDriver('success', 4242);
    const impl = new AttachModeImpl({}, killDeps);
    const env = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
    });
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    await impl.close(lr.handle, env);
    // G5：watchdog 兜底 pkill（execPkill 收到含 --parent-pid=4242 的 pkill -9 命令）
    expect(execPkillSpy).toHaveBeenCalledTimes(1);
    const cmd = execPkillSpy.mock.calls[0]![0] as string;
    expect(cmd).toContain('pkill -9 -f');
    expect(cmd).toContain('chrome-devtools-mcp');
    expect(cmd).toContain('--parent-pid=4242');
  });

  it('[v0.0.336 G4/G5] close → mcpPid undefined 时跳过 kill/pkill 不阻断（退化为 disconnect 清 cache）', async () => {
    const killProcessGroupSpy = vi.fn((_pid: number) => {});
    const execPkillSpy = vi.fn((_cmd: string) => {});
    const killDeps: AttachKillDeps = { isPidAlive: vi.fn(() => true), killProcessGroup: killProcessGroupSpy, execPkill: execPkillSpy };
    const driver = makeDriver(); // 无 mcpPid
    const impl = new AttachModeImpl({}, killDeps);
    const env = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
    });
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const result = await impl.close(lr.handle, env);
    expect(result.ok).toBe(true); // 无 mcpPid 仍 ok（disconnect 清 cache + ledger.delete 成功）
    expect(killProcessGroupSpy).not.toHaveBeenCalled(); // 无 mcpPid 跳过 kill
    expect(execPkillSpy).not.toHaveBeenCalled(); // 无 mcpPid 跳过 watchdog pkill
    expect(driver.disconnect).toHaveBeenCalledTimes(1); // disconnect 照常清 cache
  });

  it('[v0.0.336 三层一致] close 清理失败（kill 抛错）→ ok=false 诚实上报（kind=close_incomplete）', async () => {
    const killProcessGroupSpy = vi.fn((_pid: number) => { throw new Error('EPERM'); });
    const killDeps: AttachKillDeps = { isPidAlive: vi.fn(() => true), killProcessGroup: killProcessGroupSpy, execPkill: vi.fn() };
    const driver = makeDriver('success', 4242);
    const impl = new AttachModeImpl({}, killDeps);
    const env = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
    });
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const result = await impl.close(lr.handle, env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('close_incomplete');
      expect(result.error.message).toContain('kill mcp 主进程组失败');
      expect(result.error.message).toContain('EPERM');
    }
    expect(lr.handle.state).toBe('dead'); // state 仍置 dead（best-effort 清理到底）
  });
});

describe('AttachModeImpl cleanupOrphan（v0.0.334 B9：孤儿 MCP 代理回收）', () => {
  it('alive mcpPid → killProcessGroup + 台账硬删', () => {
    const killProcessGroupSpy = vi.fn((_pid: number) => {});
    const execPkillSpy = vi.fn((_cmd: string) => {});
    const killDeps: AttachKillDeps = { isPidAlive: vi.fn(() => true), killProcessGroup: killProcessGroupSpy, execPkill: execPkillSpy };
    const impl = new AttachModeImpl({}, killDeps);
    const env = makeEnv();
    // seed 台账（attach 记录：worker_pid = MCP 子进程 pid）
    ledger.insert({
      key: 'sA:attach',
      mode: 'attach',
      workerPid: 4242,
      createdAt: 1_000,
    });
    impl.cleanupOrphan?.(
      {
        key: 'sA:attach',
        mode: 'attach',
        workerPid: 4242,
        createdAt: 1_000,
      },
      env,
    );
    expect(killProcessGroupSpy).toHaveBeenCalledWith(4242); // 杀 MCP 进程组（DI 注入 spy）
    expect(ledger.listAll()).toHaveLength(0); // 台账硬删
  });

  it('dead mcpPid → 不 kill（幂等 no-op）+ 台账硬删', () => {
    const killProcessGroupSpy = vi.fn((_pid: number) => {});
    const execPkillSpy = vi.fn((_cmd: string) => {});
    const killDeps: AttachKillDeps = { isPidAlive: vi.fn(() => false), killProcessGroup: killProcessGroupSpy, execPkill: execPkillSpy };
    const impl = new AttachModeImpl({}, killDeps);
    const env = makeEnv();
    ledger.insert({
      key: 'sA:attach',
      mode: 'attach',
      workerPid: 4242,
      createdAt: 1_000,
    });
    impl.cleanupOrphan?.(
      {
        key: 'sA:attach',
        mode: 'attach',
        workerPid: 4242,
        createdAt: 1_000,
      },
      env,
    );
    expect(killProcessGroupSpy).not.toHaveBeenCalled(); // dead 不 kill
    expect(ledger.listAll()).toHaveLength(0); // 记录仍清
  });

  it('[v0.0.336 G6] cleanupOrphan → 含 watchdog 兜底（pkill --parent-pid=<mcpPid> 精确锚定）', () => {
    const execPkillSpy = vi.fn((_cmd: string) => {});
    const killDeps: AttachKillDeps = { isPidAlive: vi.fn(() => true), killProcessGroup: vi.fn(), execPkill: execPkillSpy };
    const impl = new AttachModeImpl({}, killDeps);
    const env = makeEnv();
    ledger.insert({
      key: 'sA:attach',
      mode: 'attach',
      workerPid: 4242,
      createdAt: 1_000,
    });
    impl.cleanupOrphan?.(
      {
        key: 'sA:attach',
        mode: 'attach',
        workerPid: 4242,
        createdAt: 1_000,
      },
      env,
    );
    // G6：cleanupOrphan 补 watchdog 兜底（execPkill 收到含 --parent-pid=4242 的 pkill -9 命令）
    expect(execPkillSpy).toHaveBeenCalledTimes(1);
    const cmd = execPkillSpy.mock.calls[0]![0] as string;
    expect(cmd).toContain('pkill -9 -f');
    expect(cmd).toContain('--parent-pid=4242');
    expect(ledger.listAll()).toHaveLength(0); // 台账硬删
  });
});
