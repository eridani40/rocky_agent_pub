/**
 * raise-nofile 单测 — packaged Electron 主进程抬 nofile soft limit
 * 参考: specs/tech/version_logs/v0.0.236/change_plan.md（B 段 UT 行）
 *       states/v0.0.236/verify/test-plan.md §1
 *
 * 校验点（4 分支）：
 *   ① currentSoft > target → 不调 setrlimit（保持当前 soft）
 *   ② currentSoft < target → 调 setrlimit({soft:max, hard:当前hard})，hard 不动
 *   ③ posix require 失败（模块缺失/rebuild 失败）→ 静默返 {raised:false}
 *   ④ setrlimit 抛错 → console.warn 不抛，返 {raised:false}
 *
 * 依赖注入：分支 ①②④ 注入 mock binding（参照 backend-bootstrap.test.ts DI 模式，不真 require）。
 * 分支 ③ 用 vi.mock('posix') 让 require 抛错（模拟 packaged rebuild 失败 / 模块缺失场景）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { raiseNofileLimit, type PosixBinding } from '../raise-nofile';

// vi.mock 被 vitest 提升到文件顶部：让 require('posix') 在测试中抛错。
// 工厂同步抛错 → raise-nofile.loadPosixBinding 的 try/catch 捕获 → 返 undefined → 静默降级。
// 仅分支 ③（不注入 binding 时）会触发 require；分支 ①②④ 注入 binding 走 `binding ??` 短路不触发。
vi.mock('posix', () => {
  throw new Error('posix mocked as unavailable (simulate packaged rebuild failure)');
});

/** 构造可记录调用的 mock binding */
function makeMockBinding(soft: number | null, hard: number | null): {
  binding: PosixBinding;
  setrlimit: ReturnType<typeof vi.fn>;
  getrlimit: ReturnType<typeof vi.fn>;
} {
  const getrlimit = vi.fn(() => ({ soft, hard }));
  const setrlimit = vi.fn(() => undefined);
  return { binding: { getrlimit, setrlimit }, getrlimit, setrlimit };
}

describe('raiseNofileLimit', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('① currentSoft > target → 不调 setrlimit，返回 raised:false + 当前 soft', () => {
    const { binding, setrlimit } = makeMockBinding(/* soft */ 8192, /* hard */ 92160);
    const result = raiseNofileLimit(/* targetSoft */ 4096, binding);
    expect(result.raised).toBe(false);
    expect(result.newSoft).toBe(8192);
    expect(setrlimit).not.toHaveBeenCalled();
  });

  it('② currentSoft < target → 调 setrlimit({soft:max, hard:当前hard})，hard 不动', () => {
    const { binding, setrlimit } = makeMockBinding(/* soft */ 256, /* hard */ 92160);
    const result = raiseNofileLimit(/* targetSoft */ 4096, binding);
    expect(result.raised).toBe(true);
    expect(result.newSoft).toBe(4096);
    // 关键断言：hard 保持 92160 不动（防超 kern.maxfilesperproc）
    expect(setrlimit).toHaveBeenCalledTimes(1);
    expect(setrlimit).toHaveBeenCalledWith('nofile', { soft: 4096, hard: 92160 });
  });

  it('② currentSoft === target → 不调 setrlimit（边界：已相等无需 raise）', () => {
    const { binding, setrlimit } = makeMockBinding(/* soft */ 4096, /* hard */ 92160);
    const result = raiseNofileLimit(/* targetSoft */ 4096, binding);
    expect(result.raised).toBe(false);
    expect(result.newSoft).toBe(4096);
    expect(setrlimit).not.toHaveBeenCalled();
  });

  it('③ posix require 失败（不注入 binding）→ 静默返 {raised:false}，不抛错', () => {
    // 不注入 binding → 内部 require('posix') → vi.mock 工厂抛错 → loadPosixBinding 返 undefined
    const result = raiseNofileLimit(4096);
    expect(result.raised).toBe(false);
    // newSoft 为 -1 占位（NOFILE_UNKNOWN：未知，因 posix 缺失读不到当前 soft）
    expect(result.newSoft).toBe(-1);
  });

  it('④ setrlimit 抛错 → console.warn 不抛，返 {raised:false}', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getrlimit = vi.fn(() => ({ soft: 256, hard: 92160 }));
    const setrlimit = vi.fn(() => {
      throw new Error('EPERM: setrlimit denied');
    });
    const binding: PosixBinding = { getrlimit, setrlimit };

    // 不得抛错（容错红线：不阻塞启动）
    const result = raiseNofileLimit(4096, binding);
    expect(result.raised).toBe(false);
    expect(result.newSoft).toBe(-1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0]?.[0] ?? '';
    expect(String(warnArg)).toContain('raiseNofileLimit');
  });

  it('soft=RLIM_INFINITY(null) → 无需 raise，返 {raised:false, newSoft:Infinity}', () => {
    const { binding, setrlimit } = makeMockBinding(/* soft */ null, /* hard */ null);
    const result = raiseNofileLimit(4096, binding);
    expect(result.raised).toBe(false);
    expect(result.newSoft).toBe(Infinity);
    expect(setrlimit).not.toHaveBeenCalled();
  });
});
