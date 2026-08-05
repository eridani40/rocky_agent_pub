/**
 * jobMatches / findJobById UT — jobId 健壮化匹配（v0.0.58.cron BUG-001）。
 * 参考: specs/tech/scheduling/[P1]cron_subsystem.md §6/§7（cron agent 工具 + UI HTTP 共用）
 *
 * 背景：UI 端把 `cron:sid:eid` 整体当 URL path segment，`encodeURIComponent` 把 `:` 编码成
 * `%3A`，router `new URL().pathname` 不解码 → handler 收到 `cron%3Asid%3Aeid`，原 `===` 比
 * 失败 → "job not found"。jobMatches 在匹配层修（一处改双双过）。
 *
 * 覆盖：
 *   - 完整 decoded（agent 工具 + UT 直传）
 *   - 完整 encoded（UI HTTP 经 URL path 透传未 decode；BUG-001 场景）
 *   - 后缀 entryId（未来兼容；caller 简写）
 *   - 非法 % 序列不抛（try/catch 兜底）
 *   - 不匹配（不同 sessionId / 不同 entryId）
 *   - findJobById 找首个 + 不在返 null
 */
import { describe, it, expect } from 'vitest';
import { jobMatches, findJobById } from '../cron-tool-shared';
import type { Job } from '../../../scheduling/types';

function mkJob(sessionId: string, entryId: string): Job {
  return {
    id: `cron:${sessionId}:${entryId}`,
    type: 'cron',
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
    payload: { sessionId, name: 'n', prompt: 'p', squadId: null },
    lastFiredAt: null,
    enabled: true,
    createdAt: '2026-07-03T00:00:00.000Z',
    owner: sessionId,
  };
}

describe('jobMatches — 三种入参形态兼容', () => {
  const job = mkJob('S-1', 'E-aaa');

  it('形态 1：完整 decoded（agent 工具 + UT 直传）', () => {
    expect(jobMatches(job, 'cron:S-1:E-aaa')).toBe(true);
  });

  it('形态 2：完整 encoded（UI HTTP 经 URL path 未 decode；BUG-001 场景）', () => {
    // encodeURIComponent('cron:S-1:E-aaa') = 'cron%3AS-1%3AE-aaa'
    expect(jobMatches(job, 'cron%3AS-1%3AE-aaa')).toBe(true);
  });

  it('形态 3：后缀 entryId（未来兼容；caller 简写）', () => {
    expect(jobMatches(job, 'E-aaa')).toBe(true);
  });

  it('非法 % 序列不抛（decodeURIComponent 兜底）', () => {
    // 孤立 `%` 会让 decodeURIComponent throw URIError；jobMatches 须 try/catch 不阻断
    expect(() => jobMatches(job, 'cron%ZZ')).not.toThrow();
    expect(jobMatches(job, 'cron%ZZ')).toBe(false);
  });

  it('不匹配：不同 sessionId', () => {
    expect(jobMatches(job, 'cron:S-OTHER:E-aaa')).toBe(false);
    expect(jobMatches(job, 'cron%3AS-OTHER%3AE-aaa')).toBe(false);
  });

  it('不匹配：不同 entryId', () => {
    expect(jobMatches(job, 'cron:S-1:E-other')).toBe(false);
    expect(jobMatches(job, 'E-other')).toBe(false);
  });

  it('不匹配：suffix 含 : 视作 full，不走后缀分支（避免误匹配）', () => {
    // 形如 `sid:eid` 含 : → 不走后缀匹配，full 比也不中（缺 cron: 前缀）→ false
    expect(jobMatches(job, 'S-1:E-aaa')).toBe(false);
  });

  it('空字符串 / 空前缀 → false（不误匹配空 endsWith）', () => {
    expect(jobMatches(job, '')).toBe(false);
  });
});

describe('findJobById — 列表查 + 不在返 null', () => {
  const jobs = [mkJob('S-1', 'E-aaa'), mkJob('S-1', 'E-bbb'), mkJob('S-2', 'E-ccc')];

  it('decoded 命中首个', () => {
    expect(findJobById(jobs, 'cron:S-1:E-aaa')?.id).toBe('cron:S-1:E-aaa');
  });

  it('encoded 命中（BUG-001 场景）', () => {
    expect(findJobById(jobs, 'cron%3AS-1%3AE-bbb')?.id).toBe('cron:S-1:E-bbb');
  });

  it('suffix entryId 命中', () => {
    expect(findJobById(jobs, 'E-ccc')?.id).toBe('cron:S-2:E-ccc');
  });

  it('不在 → null', () => {
    expect(findJobById(jobs, 'cron:S-X:Y')).toBeNull();
    expect(findJobById(jobs, 'cron%3AS-X%3AY')).toBeNull();
  });

  it('空列表 → null', () => {
    expect(findJobById([], 'whatever')).toBeNull();
  });
});
