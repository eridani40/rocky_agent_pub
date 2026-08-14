/**
 * BrowserInstanceLedger 单元测试（v0.0.334 U5：sqlite 台账全方法）
 * 参考: specs/tech/version_logs/v0.0.334/change_plan.md B1 + U5
 *
 * 覆盖：
 *   ① 建表幂等（多次构造不炸）
 *   ② insert：INSERT OR REPLACE 幂等（同 key 覆盖）
 *   ③ delete：硬删（DELETE 非 soft）+ 幂等（key 不存在 no-op）
 *   ④ listAll：全量读取（含 attach 记录：userDataDir/cdpPort 空）
 *   ⑤ clearAll：全清幂等
 *   ⑥ 失败吞错：mock driver 抛错 → warn 不抛（best-effort）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserInstanceLedger } from '../instance-ledger';
import { BunSqlDriver, type SqlDriver, type SqlStatement } from '../../../persistence/search-sql-driver';

/** 测试临时 db 文件路径 + 真实 BunSqlDriver */
let dbPath: string;
let driver: BunSqlDriver;
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-ut-'));
  dbPath = join(dir, 'browser.sqlite');
  driver = await BunSqlDriver.create(dbPath);
});
afterEach(() => {
  driver.close();
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

/** headless 记录样例 */
function headlessRec() {
  return {
    key: 's1:headless',
    mode: 'headless' as const,
    userDataDir: '/tmp/rocky-browser-instance-1',
    cdpPort: 18800,
    workerPid: 23456,
    chromePid: 555,
    createdAt: 1_000,
  };
}

describe('BrowserInstanceLedger：建表', () => {
  it('构造建表 + 幂等（二次构造不炸；表存在 IF NOT EXISTS）', () => {
    const l1 = new BrowserInstanceLedger(driver);
    expect(l1).toBeInstanceOf(BrowserInstanceLedger);
    // 二次构造（同 driver）→ 建表幂等
    const l2 = new BrowserInstanceLedger(driver);
    expect(l2).toBeInstanceOf(BrowserInstanceLedger);
    // 表存在：insert/listAll 正常
    l2.insert(headlessRec());
    expect(l2.listAll()).toHaveLength(1);
  });
});

describe('BrowserInstanceLedger：insert', () => {
  it('insert 后 listAll 可读（字段完整 round-trip）', () => {
    const ledger = new BrowserInstanceLedger(driver);
    ledger.insert(headlessRec());
    const rows = ledger.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      key: 's1:headless',
      mode: 'headless',
      userDataDir: '/tmp/rocky-browser-instance-1',
      cdpPort: 18800,
      workerPid: 23456,
      chromePid: 555,
      createdAt: 1_000,
    });
  });

  it('INSERT OR REPLACE 幂等：同 key 二次 insert → 覆盖（不重复行）', () => {
    const ledger = new BrowserInstanceLedger(driver);
    ledger.insert(headlessRec());
    ledger.insert({ ...headlessRec(), workerPid: 99999, chromePid: undefined }); // 覆盖同 key
    const rows = ledger.listAll();
    expect(rows).toHaveLength(1); // 不重复
    expect(rows[0]!.workerPid).toBe(99999);
    expect(rows[0]!.chromePid).toBeUndefined(); // 覆盖后字段清空
  });

  it('insert attach 记录（userDataDir/cdpPort 空）→ 可读且字段缺省', () => {
    const ledger = new BrowserInstanceLedger(driver);
    ledger.insert({
      key: 'sA:attach',
      mode: 'attach',
      workerPid: 4242,
      createdAt: 1_000,
    });
    const rows = ledger.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mode).toBe('attach');
    expect(rows[0]!.userDataDir).toBeUndefined();
    expect(rows[0]!.cdpPort).toBeUndefined();
  });
});

describe('BrowserInstanceLedger：delete', () => {
  it('delete 硬删：记录消失（DELETE 非 soft）', () => {
    const ledger = new BrowserInstanceLedger(driver);
    ledger.insert(headlessRec());
    ledger.delete('s1:headless');
    expect(ledger.listAll()).toHaveLength(0);
  });

  it('delete 幂等：key 不存在 no-op（不抛）', () => {
    const ledger = new BrowserInstanceLedger(driver);
    expect(() => ledger.delete('s1:headless')).not.toThrow();
    expect(ledger.listAll()).toHaveLength(0);
  });

  it('delete 只删目标 key（其他记录保留）', () => {
    const ledger = new BrowserInstanceLedger(driver);
    ledger.insert(headlessRec());
    ledger.insert({ ...headlessRec(), key: 's2:headless', workerPid: 333 });
    ledger.delete('s1:headless');
    const rows = ledger.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe('s2:headless');
  });
});

describe('BrowserInstanceLedger：listAll / clearAll', () => {
  it('listAll 空表 → []（不抛）', () => {
    const ledger = new BrowserInstanceLedger(driver);
    expect(ledger.listAll()).toEqual([]);
  });

  it('clearAll 全清 + 幂等', () => {
    const ledger = new BrowserInstanceLedger(driver);
    ledger.insert(headlessRec());
    ledger.insert({ ...headlessRec(), key: 's2:headless' });
    ledger.clearAll();
    expect(ledger.listAll()).toEqual([]);
    ledger.clearAll(); // 幂等
    expect(ledger.listAll()).toEqual([]);
  });
});

describe('BrowserInstanceLedger：失败吞错（best-effort）', () => {
  /** mock driver：指定方法抛错，验证 ledger 不抛（catch warn） */
  function makeThrowingDriver(method: 'exec' | 'prepare'): SqlDriver {
    return {
      exec: vi.fn(() => {
        if (method === 'exec') throw new Error('exec boom');
      }),
      prepare: vi.fn((): SqlStatement => {
        if (method === 'prepare') throw new Error('prepare boom');
        throw new Error('unexpected');
      }),
      close: vi.fn(() => {}),
    };
  }

  it('构造建表失败（exec 抛）→ 不抛构造（warn 降级）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => new BrowserInstanceLedger(makeThrowingDriver('exec'))).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('insert 失败（prepare 抛）→ 不抛（catch warn）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ledger = new BrowserInstanceLedger(driver);
    // 替换 driver 为抛错 driver（构造后换 driver 不可行——用注入抛错 driver 直接构造）
    const badLedger = new BrowserInstanceLedger(makeThrowingDriver('prepare'));
    expect(() => badLedger.insert(headlessRec())).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('listAll 失败 → []（不抛）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badLedger = new BrowserInstanceLedger(makeThrowingDriver('prepare'));
    expect(badLedger.listAll()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('delete 失败 → 不抛（catch warn）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badLedger = new BrowserInstanceLedger(makeThrowingDriver('prepare'));
    expect(() => badLedger.delete('s1:headless')).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('clearAll 失败 → 不抛（catch warn）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badLedger = new BrowserInstanceLedger(makeThrowingDriver('exec'));
    expect(() => badLedger.clearAll()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
