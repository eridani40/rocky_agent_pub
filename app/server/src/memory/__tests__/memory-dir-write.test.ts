/**
 * memory-dir-write 单测（v0.0.247 — writeLocked create 分支配额拦截 + 不变量#1 archive 不自锁）
 * 参考: specs/tech/version_logs/v0.0.247/change_plan.md（memory 子系统 + 6 核心不变量）
 *       app/server/src/memory/memory-dir-write.ts
 *
 * 覆盖（对应 acceptanceCriteria + 6 核心不变量）：
 *   - create 路径超配额 → 拒绝（不变量#1 create-only 触发）
 *   - update 路径（writeEntry existing）不触发配额（不变量#1）
 *   - archiveEntry 不触发配额（不变量#1 — archive 不自锁）
 *   - 并发两 create 不同 name（Promise.all）→ 仅一条通过（不变量#5 dir 锁原子防 TOCTOU）
 *   - evolvable=false 计入配额 + 错误文案（不变量#4）
 *   - opts.store 缺省 → 不查配额（向后兼容；不变量#6）
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveEntry, createEntry, writeEntry } from '../memory-dir-write';
import { MemoryQuotaExceededError } from '../policy';
import { serializeEntryFile, listEntries } from '../memory-dir-store';
import type { MemoryStoreQuotas } from '../store-quota';
import type { AppConfigService } from '../../config/app-config-service';

let tmpRoot: string;
let dir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-memdirwrite-quota-'));
  dir = join(tmpRoot, 'mem');
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** AppConfigService 桩：get('session','default') 返 { maxMemoryInject*, ... } 形态 */
function fakeAppConfig(q: MemoryStoreQuotas): AppConfigService {
  return {
    get: () => ({
      maxMemoryInject: q.global,
      maxMemoryInjectGroup: q.group,
      maxMemoryInjectSession: q.session,
    }),
    set: () => {},
  } as unknown as AppConfigService;
}

const Q2: MemoryStoreQuotas = { global: 2, group: 2, session: 2 };
const Q5: MemoryStoreQuotas = { global: 5, group: 5, session: 5 };

interface EntryInput {
  name: string;
  intro?: string;
  type?: 'user' | 'feedback' | 'project' | 'reference';
  body?: string;
}

/** 构造 writeEntry 入参（默认值方便测试） */
function inp(e: EntryInput) {
  return {
    name: e.name,
    intro: e.intro ?? `intro-${e.name}`,
    type: (e.type ?? 'user') as 'user',
    body: e.body ?? `body-${e.name}`,
  };
}

/** 落盘 N 条 active entry（name=e0..eN-1，evolvable 默认 true） */
function seed(n: number, opts: { evolvable?: boolean; dir?: string } = {}): void {
  const target = opts.dir ?? dir;
  mkdirSync(target, { recursive: true });
  for (let i = 0; i < n; i++) {
    const e = {
      name: `e${i}`,
      intro: `i${i}`,
      type: 'user' as const,
      archived: false,
      evolvable: opts.evolvable === false ? false : true,
      source: 'agent' as const,
      updatedAt: '',
      body: `b${i}`,
    };
    writeFileSync(join(target, `e${i}.md`), serializeEntryFile(e));
  }
}

// ============================================================
// create 路径：超配额拒绝
// ============================================================
describe('writeLocked create 分支 — 配额拦截', () => {
  it('count < limit → 写入成功（不抛）', async () => {
    seed(1); // count=1, limit=2
    const out = await writeEntry(dir, inp({ name: 'new1' }), {
      store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
    });
    expect(out.name).toBe('new1');
    expect(listEntries(dir).map((e) => e.name)).toContain('new1');
  });

  it('count == limit → throw MemoryQuotaExceededError（边界：等于即拒）', async () => {
    seed(2); // count=2, limit=2
    await expect(
      writeEntry(dir, inp({ name: 'new1' }), {
        store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
      }),
    ).rejects.toBeInstanceOf(MemoryQuotaExceededError);
  });

  it('count > limit → throw', async () => {
    seed(5); // count=5, limit=2
    await expect(
      writeEntry(dir, inp({ name: 'new1' }), {
        store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
      }),
    ).rejects.toBeInstanceOf(MemoryQuotaExceededError);
  });

  it('超限时新条目不落盘（write 在 check 之后）', async () => {
    seed(2);
    await expect(
      writeEntry(dir, inp({ name: 'new1' }), {
        store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
      }),
    ).rejects.toThrow();
    expect(listEntries(dir).map((e) => e.name)).not.toContain('new1');
  });

  it('createEntry 同样受配额拦截（UI POST 路径）', async () => {
    seed(2);
    await expect(
      createEntry(dir, inp({ name: 'new1' }), {
        store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
      }),
    ).rejects.toBeInstanceOf(MemoryQuotaExceededError);
  });

  it('错误字段携 scope/global + current/limit', async () => {
    seed(2);
    try {
      await writeEntry(dir, inp({ name: 'new1' }), {
        store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
      });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as MemoryQuotaExceededError;
      expect(err.scope).toBe('global');
      expect(err.current).toBe(2);
      expect(err.limit).toBe(2);
    }
  });

  it('session scope 配额独立生效', async () => {
    seed(1); // count=1
    // session quota=1（limit=1，count=1 → 边界等 → throw）；global quota=5（不超）
    const q = { global: 5, group: 5, session: 1 };
    await expect(
      writeEntry(dir, inp({ name: 'new1' }), {
        store: { scope: 'session', appConfig: fakeAppConfig(q) },
      }),
    ).rejects.toBeInstanceOf(MemoryQuotaExceededError);
  });
});

// ============================================================
// update 路径：不触发配额（不变量#1）
// ============================================================
describe('writeLocked update 分支 — 不查配额（不变量#1）', () => {
  it('update 既有条目（existing）即使 count==limit 也成功', async () => {
    seed(2); // count=2, limit=2（边界）
    // update 既有 e0 而非新建 → 不触发配额
    const out = await writeEntry(dir, inp({ name: 'e0', body: 'updated' }), {
      store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
    });
    expect(out.body).toBe('updated');
  });

  it('update 既有条目（count>limit）也成功', async () => {
    seed(5); // count=5 > limit=2（模拟存量超限场景）
    const out = await writeEntry(dir, inp({ name: 'e0', body: 'updated' }), {
      store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
    });
    expect(out.body).toBe('updated');
  });

  it('createEntry 同名已存在（archive 后复活）走 update 路径不查配额', async () => {
    // archive 一条使 listEntries 不含；但 readRaw 仍能 parse → existing truthy → update 路径
    seed(2);
    await archiveEntry(dir, 'e0');
    // writeEntry e0 → existing（含 archived）→ update 路径不查配额 + 反归档
    const out = await writeEntry(dir, inp({ name: 'e0', body: 'revive' }), {
      store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
    });
    expect(out.archived).toBe(false);
    expect(out.body).toBe('revive');
  });
});

// ============================================================
// archiveEntry 不触发配额（不变量#1 — archive 不自锁）
// ============================================================
describe('archiveEntry — 不查配额（不变量#1 archive 不自锁）', () => {
  it('archive 在 count==limit 时成功（archive 不查配额）', async () => {
    seed(2); // count=2, limit=2
    const out = await archiveEntry(dir, 'e0');
    expect(out.archived).toBe(true);
  });

  it('archive 在 count>limit 时成功（存量超限场景 archive 仍可用）', async () => {
    seed(5);
    const out = await archiveEntry(dir, 'e0');
    expect(out.archived).toBe(true);
    // archive 后 active count 减 1，但配额本就不查 archive
    expect(listEntries(dir)).toHaveLength(4);
  });

  it('archive 后再 create 新条目：腾出位后写入成功（引导 agent 收敛）', async () => {
    seed(2); // count=2, limit=2 → 边界
    await archiveEntry(dir, 'e0'); // active 减到 1
    // 现在再 create → count=1<2 → OK
    const out = await writeEntry(dir, inp({ name: 'new1' }), {
      store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
    });
    expect(out.name).toBe('new1');
  });
});

// ============================================================
// 并发原子（不变量#5 — dir 锁内 count+write 原子，防 TOCTOU race）
// ============================================================
describe('writeLocked 并发 — dir 锁原子（不变量#5）', () => {
  it('两 create 不同 name 并发 → 仅一条通过，另一条 throw（防 race）', async () => {
    seed(1); // count=1, limit=2 → 仅允许再写 1 条
    const results = await Promise.allSettled([
      writeEntry(dir, inp({ name: 'newA' }), {
        store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
      }),
      writeEntry(dir, inp({ name: 'newB' }), {
        store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(MemoryQuotaExceededError);
    // 最终 active 条目数 = 初始 1 + 新增 1 = 2（不超 limit）
    expect(listEntries(dir)).toHaveLength(2);
  });

  it('三 create 不同 name 并发（limit=2，count=1）→ 仅 1 条通过，2 条 throw', async () => {
    seed(1);
    const results = await Promise.allSettled([
      writeEntry(dir, inp({ name: `c${Math.random()}` }), {
        store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
      }),
      writeEntry(dir, inp({ name: `d${Math.random()}` }), {
        store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
      }),
      writeEntry(dir, inp({ name: `f${Math.random()}` }), {
        store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    expect(listEntries(dir)).toHaveLength(2); // 初始 1 + 新增 1
  });

  it('无 dir 锁时本应双写（假想对照：seed 1 + 并发 2 都通过会落 3 条超 limit）— 实际被锁拦', async () => {
    // 本测试验证「dir 锁确实生效」：若无锁，两并发都看到 count=1 都写 → count=3 > limit=2
    // 实际：dir 锁串行 → 第二个看到 count=2 → throw → 最终 count=2
    seed(1);
    await Promise.allSettled([
      writeEntry(dir, inp({ name: 'p1' }), { store: { scope: 'global', appConfig: fakeAppConfig(Q2) } }),
      writeEntry(dir, inp({ name: 'p2' }), { store: { scope: 'global', appConfig: fakeAppConfig(Q2) } }),
    ]);
    expect(listEntries(dir)).toHaveLength(2); // 不是 3（锁拦住了第二个）
  });
});

// ============================================================
// evolvable=false 计入配额（不变量#4）
// ============================================================
describe('writeLocked — evolvable=false 计入配额（不变量#4）', () => {
  it('evolvable=false 条目计入 count（不被绕过）', async () => {
    seed(2, { evolvable: false }); // 2 条 evolvable=false，count=2=limit=2
    await expect(
      writeEntry(dir, inp({ name: 'new1' }), {
        store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
      }),
    ).rejects.toBeInstanceOf(MemoryQuotaExceededError);
  });

  it('错误文案带「其中 X 条 evolvable=false 无法 archive」', async () => {
    seed(2, { evolvable: false });
    try {
      await writeEntry(dir, inp({ name: 'new1' }), {
        store: { scope: 'global', appConfig: fakeAppConfig(Q2) },
      });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as MemoryQuotaExceededError;
      expect(err.nonEvolvableCount).toBe(2);
      expect(err.message).toContain('其中 2 条 evolvable=false 无法 archive');
    }
  });
});

// ============================================================
// opts.store 缺省 → 不查配额（不变量#6 向后兼容）
// ============================================================
describe('writeLocked — opts.store 缺省（不变量#6 向后兼容）', () => {
  it('不传 store → 即使 count==limit 也写入成功（向后兼容存量 caller / UT）', async () => {
    seed(5); // count=5 远超 limit=2，但 opts.store 缺省 → 不查
    const out = await writeEntry(dir, inp({ name: 'new1' }), {});
    expect(out.name).toBe('new1');
  });

  it('store.appConfig=null → 用默认配额 50/30/20', async () => {
    seed(50); // count=50=默认 global limit → 边界等 → throw
    await expect(
      writeEntry(dir, inp({ name: 'new1' }), {
        store: { scope: 'global', appConfig: null },
      }),
    ).rejects.toBeInstanceOf(MemoryQuotaExceededError);
  });

  it('store.appConfig=null + count<50 → 写入成功', async () => {
    seed(49);
    const out = await writeEntry(dir, inp({ name: 'new1' }), {
      store: { scope: 'global', appConfig: null },
    });
    expect(out.name).toBe('new1');
  });
});
