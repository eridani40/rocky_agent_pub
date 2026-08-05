/**
 * SSRF 防护单元测试（白盒）
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §4
 *       specs/research/v0.0.23-web-fetch.md §A.6
 *
 * 覆盖：
 *   - 协议白名单：file:///ftp:// 拒；http/https 通过
 *   - IP 黑名单：私网/保留段 IP（10/172.16/192.168/127/169.254/100.64/::1）拒；
 *                公网 IP 通过
 *   - DNS 解析后判定：mock resolveDns 返回私网 IP → 拒
 *   - DNS pinning：mock resolveDns 返回 IP 列表，任一私网即拒
 *   - 跨 origin 重定向剥 Authorization/Cookie（stripAuthOnCrossOrigin）
 *
 * 不真联网（resolveDns 全 mock）。
 */
import { describe, it, expect } from 'vitest';
import {
  SsrfError,
  isPrivateIp,
  isLoopbackIp,
  isLoopbackHost,
  assertSsrfSafe,
  resolveAndCheck,
  stripAuthOnCrossOrigin,
} from '../ssrf';

describe('isPrivateIp', () => {
  it('私网 IPv4 命中黑名单', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('10.255.255.255')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('169.254.1.1')).toBe(true);
    expect(isPrivateIp('0.0.0.0')).toBe(true);
    expect(isPrivateIp('100.64.0.1')).toBe(true); // CGN
  });

  it('公网 IPv4 通过', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('93.184.216.34')).toBe(false);
  });

  it('IPv6 私网/保留段命中', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd00::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('IPv4-mapped IPv6 命中', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
  });
});

describe('isLoopbackIp', () => {
  // loopback CDP 控制面豁免 SSRF（CDP ≠ 页面导航）
  it('127.x loopback IPv4 → true', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('127.5.6.7')).toBe(true); // 127/8 整段
    expect(isLoopbackIp('127.255.255.255')).toBe(true);
  });

  it('::1 loopback IPv6 → true', () => {
    expect(isLoopbackIp('::1')).toBe(true);
  });

  it('IPv4-mapped ::ffff:127.x → true', () => {
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::ffff:127.5.6.7')).toBe(true);
  });

  it('非 loopback → false', () => {
    expect(isLoopbackIp('10.0.0.1')).toBe(false); // 私网但非 loopback
    expect(isLoopbackIp('192.168.1.1')).toBe(false);
    expect(isLoopbackIp('0.0.0.0')).toBe(false); // unspecified 非 loopback
    expect(isLoopbackIp('169.254.169.254')).toBe(false); // link-local
    expect(isLoopbackIp('8.8.8.8')).toBe(false); // 公网
    expect(isLoopbackIp('::')).toBe(false); // unspecified
    expect(isLoopbackIp('::ffff:10.0.0.1')).toBe(false); // mapped 非环回
  });
});

describe('isLoopbackHost', () => {
  it('localhost hostname → true（忽略大小写）', () => {
    expect(isLoopbackHost('http://localhost:9222')).toBe(true);
    expect(isLoopbackHost('http://LOCALHOST:9222')).toBe(true);
    expect(isLoopbackHost('http://LocalHost/x')).toBe(true);
  });

  it('loopback IP 字面量 → true', () => {
    expect(isLoopbackHost('http://127.0.0.1:9222')).toBe(true);
    expect(isLoopbackHost('http://127.5.6.7:9222')).toBe(true);
    expect(isLoopbackHost('http://[::1]:9222')).toBe(true);
  });

  it('非 loopback host → false', () => {
    expect(isLoopbackHost('http://10.0.0.1:9222')).toBe(false);
    expect(isLoopbackHost('http://0.0.0.0:9222')).toBe(false);
    expect(isLoopbackHost('http://8.8.8.8/x')).toBe(false);
    expect(isLoopbackHost('http://example.com/x')).toBe(false); // 域名不在此判
  });

  it('非法 URL → false', () => {
    expect(isLoopbackHost('not-a-url')).toBe(false);
  });
});

describe('assertSsrfSafe', () => {
  it('禁 file:// 协议', async () => {
    await expect(assertSsrfSafe('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
  });

  it('禁 ftp:// 协议', async () => {
    await expect(assertSsrfSafe('ftp://example.com/x')).rejects.toBeInstanceOf(SsrfError);
  });

  it('私网 IP 字面量拒绝', async () => {
    await expect(assertSsrfSafe('http://127.0.0.1/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSsrfSafe('http://10.0.0.1/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSsrfSafe('http://192.168.1.1/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('公网 IP 字面量通过', async () => {
    await expect(assertSsrfSafe('http://8.8.8.8/')).resolves.toBeUndefined();
  });

  it('DNS 解析返回私网 IP → 拒绝', async () => {
    const mockResolve = async () => ['10.0.0.1'];
    await expect(assertSsrfSafe('http://example.com/', mockResolve)).rejects.toBeInstanceOf(
      SsrfError,
    );
  });

  it('DNS 解析返回公网 IP → 通过', async () => {
    const mockResolve = async () => ['93.184.216.34'];
    await expect(assertSsrfSafe('http://example.com/', mockResolve)).resolves.toBeUndefined();
  });

  it('DNS pinning：返回多个 IP 含私网 → 拒绝', async () => {
    const mockResolve = async () => ['93.184.216.34', '127.0.0.1'];
    await expect(assertSsrfSafe('http://example.com/', mockResolve)).rejects.toBeInstanceOf(
      SsrfError,
    );
  });

  it('DNS 解析失败（空数组）→ 拒绝', async () => {
    const mockResolve = async () => [];
    await expect(assertSsrfSafe('http://example.com/', mockResolve)).rejects.toBeInstanceOf(
      SsrfError,
    );
  });

  it('非法 URL → 拒绝', async () => {
    await expect(assertSsrfSafe('not-a-url')).rejects.toBeInstanceOf(SsrfError);
  });

  it('resolveAndCheck 返回公网 IP 列表', async () => {
    const mockResolve = async () => ['8.8.8.8', '1.1.1.1'];
    const ips = await resolveAndCheck('http://example.com/', mockResolve);
    expect(ips).toEqual(['8.8.8.8', '1.1.1.1']);
  });
});

describe('stripAuthOnCrossOrigin', () => {
  it('同 origin：保留 Authorization / Cookie', () => {
    const headers = {
      Authorization: 'Bearer secret',
      Cookie: 'session=abc',
      'Content-Type': 'text/html',
    };
    const result = stripAuthOnCrossOrigin(
      'https://a.com/x',
      'https://a.com/y',
      headers,
    );
    expect(result.Authorization).toBe('Bearer secret');
    expect(result.Cookie).toBe('session=abc');
  });

  it('跨 origin（不同 host）：剥 Authorization / Cookie', () => {
    const headers = {
      Authorization: 'Bearer secret',
      Cookie: 'session=abc',
      'Content-Type': 'text/html',
    };
    const result = stripAuthOnCrossOrigin(
      'https://a.com/x',
      'https://b.com/y',
      headers,
    );
    expect(result.Authorization).toBeUndefined();
    expect(result.Cookie).toBeUndefined();
    expect(result['Content-Type']).toBe('text/html');
  });

  it('跨 origin（不同 protocol）：剥凭证', () => {
    const headers = {
      authorization: 'Bearer secret',
      cookie: 'session=abc',
    };
    const result = stripAuthOnCrossOrigin(
      'https://a.com/x',
      'http://a.com/y',
      headers,
    );
    expect(result.authorization).toBeUndefined();
    expect(result.cookie).toBeUndefined();
  });

  it('非法 URL：保守剥全部凭证', () => {
    const headers = { Authorization: 'Bearer x', Other: '1' };
    const result = stripAuthOnCrossOrigin('not-a-url', 'also-bad', headers);
    expect(result.Authorization).toBeUndefined();
    expect(result.Other).toBe('1');
  });
});
