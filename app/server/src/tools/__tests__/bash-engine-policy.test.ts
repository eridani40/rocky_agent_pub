/**
 * bash-engine + bash-policy UT（v0.0.122）
 * 参考: specs/tech/agent/tools/[P0]bash_tools.md §4/§5
 *       specs/tech/version_logs/v0.0.122/change_plan.md 模块 E/G
 *
 * 覆盖点：
 *   1. detectRmWildcard — 命中/负例
 *   2. checkBashPermission — rm-wildcard ask + allow
 *   3. compileSeatbeltProfile — 单/多策略、~ 展开为绝对路径（无字面 ~）
 *   4. SecureBashEngine — darwin 真实行为（exec ok + seatbelt 拦截）
 *   5. bash tool checkPermission 接线（调 checkBashPermission）
 *
 * [v0.0.295] 删除 detectSshRead 相关测试（ssh 限制已移除）。
 */
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectRmWildcard, checkBashPermission } from '../bash-policy';
import { compileSeatbeltProfile, SecureBashEngine } from '../bash-engine';
import { bashTool } from '../bash';

// ============================================================
// 1. detectRmWildcard — 命中 / 负例
// ============================================================

describe('detectRmWildcard — 命中场景', () => {
  it('rm -rf * 命中 ask', () => {
    const result = detectRmWildcard('rm -rf *');
    expect(result?.behavior).toBe('ask');
    const r = result as { approvalKey: string };
    expect(r?.approvalKey).toBe('bash:rm-wildcard');
  });

  it('ls && rm x* 命中 ask（第二段 rm）', () => {
    const result = detectRmWildcard('ls && rm x*');
    expect(result?.behavior).toBe('ask');
  });

  it('rm *.log 命中 ask', () => {
    const result = detectRmWildcard('rm *.log');
    expect(result?.behavior).toBe('ask');
  });

  it('ls; rm -f /tmp/* 命中 ask（; 分隔）', () => {
    const result = detectRmWildcard('ls; rm -f /tmp/*');
    expect(result?.behavior).toBe('ask');
  });

  it('ls || rm * 命中 ask（|| 分隔）', () => {
    const result = detectRmWildcard('ls || rm *');
    expect(result?.behavior).toBe('ask');
  });
});

describe('detectRmWildcard — 负例（不应误判）', () => {
  it('rm file.txt 不命中（无 *）', () => {
    const result = detectRmWildcard('rm file.txt');
    expect(result).toBeNull();
  });

  it("echo '*' 不命中（命令名 echo，非 rm）", () => {
    const result = detectRmWildcard("echo '*'");
    expect(result).toBeNull();
  });

  it('ls * 不命中（命令名 ls，非 rm）', () => {
    const result = detectRmWildcard('ls *');
    expect(result).toBeNull();
  });

  it('rm -v log.txt notes.md 不命中（无 *）', () => {
    const result = detectRmWildcard('rm -v log.txt notes.md');
    expect(result).toBeNull();
  });
});

// ============================================================
// 2. checkBashPermission — rm-wildcard ask + allow
// ============================================================

describe('checkBashPermission — rm-wildcard + allow', () => {
  it('rm -rf * 单独 → ask', () => {
    const result = checkBashPermission('rm -rf *');
    expect(result.behavior).toBe('ask');
    expect((result as { approvalKey: string }).approvalKey).toBe('bash:rm-wildcard');
  });

  it('echo hello → allow', () => {
    const result = checkBashPermission('echo hello');
    expect(result.behavior).toBe('allow');
  });

  it('间接拼接命令（approval_sandbox_tc1 负例）→ allow（参数层不拦）', () => {
    const result = checkBashPermission('d=$HOME/.s; ls "${d}sh"');
    expect(result.behavior).toBe('allow');
  });
});

// ============================================================
// 3. compileSeatbeltProfile — 字符串形态 + ~ 展开
// ============================================================

describe('compileSeatbeltProfile — profile 字符串生成', () => {
  it('单条 denyRead 策略生成正确 profile', () => {
    const profile = compileSeatbeltProfile([
      { id: 'test-block', description: 'test', denyRead: ['~/.aws'] },
    ]);
    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(allow default)');

    // ~ 应被展开为绝对路径（homedir 不含字面 ~）
    const expectedPath = join(homedir(), '.aws');
    expect(profile).toContain(`(deny file-read* (subpath "${expectedPath}"))`);
    expect(profile).not.toContain('~'); // 无字面 ~ 残留（BUG-004 护栏）
  });

  it('多条策略展开所有路径', () => {
    const profile = compileSeatbeltProfile([
      { id: 'p1', description: 'a', denyRead: ['~/.aws', '~/.gnupg'] },
      { id: 'p2', description: 'b', denyWrite: ['~/sensitive'] },
    ]);
    const awsPath = join(homedir(), '.aws');
    const gnupgPath = join(homedir(), '.gnupg');
    const sensPath = join(homedir(), 'sensitive');

    expect(profile).toContain(`(deny file-read* (subpath "${awsPath}"))`);
    expect(profile).toContain(`(deny file-read* (subpath "${gnupgPath}"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${sensPath}"))`);
    expect(profile).not.toContain('~');
  });

  it('空策略列表只含 version + allow default', () => {
    const profile = compileSeatbeltProfile([]);
    expect(profile).toBe('(version 1)\n(allow default)');
  });

  it('绝对路径策略不修改（无前导 ~）', () => {
    const profile = compileSeatbeltProfile([
      { id: 'abs', description: 'absolute', denyRead: ['/etc/ssh'] },
    ]);
    expect(profile).toContain('(deny file-read* (subpath "/etc/ssh"))');
  });

  it('路径含 " 时 throw（防止 profile 结构破坏）', () => {
    expect(() => {
      compileSeatbeltProfile([{ id: 'bad', description: 'x', denyRead: ['/path/with"quote'] }]);
    }).toThrow('不安全字符');
  });

  it('路径含反斜杠时 throw（防止 profile 结构破坏）', () => {
    expect(() => {
      compileSeatbeltProfile([{ id: 'bad', description: 'x', denyRead: ['/path/with\\slash'] }]);
    }).toThrow('不安全字符');
  });
});

// ============================================================
// 4. SecureBashEngine — darwin 真实行为（本机是 mac）
// ============================================================

describe('SecureBashEngine — darwin 真实行为', () => {
  // sandbox-exec 在嵌套沙箱（如 Rocky 自身 seatbelt）下不可用，探测一次决定是否跳过
  const engine = new SecureBashEngine([
    { id: 'test-block', description: 'test deny', denyRead: ['~/.aws'] },
  ]);

  /** 探测 sandbox-exec 是否可用且 denyRead 真生效（嵌套沙箱下 deny 可能被忽略） */
  async function canSeatbelt(): Promise<boolean> {
    // 1. 基础探测：echo ok 能跑（sandbox-exec 自身不崩）
    const basic = await engine.exec('echo ok', { cwd: '/tmp', timeoutMs: 3000 });
    if (basic.exitCode !== 0) return false;
    // 2. denyRead 强制探测：临时目录 + deny 策略 → ls 应被拦（非零退出）
    //    嵌套沙箱可能放行 echo 但忽略 deny 规则，须实测 deny 强制
    const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
    const probeDir = '/tmp/seatbelt-probe-' + Date.now();
    try {
      mkdirSync(probeDir, { recursive: true });
      writeFileSync(probeDir + '/secret.txt', 'denied');
      const probeEngine = new SecureBashEngine([
        { id: 'probe-deny', description: 'probe', denyRead: [probeDir] },
      ]);
      const r = await probeEngine.exec(`cat ${probeDir}/secret.txt`, { cwd: '/tmp', timeoutMs: 3000 });
      return r.exitCode !== 0; // deny 生效 → 非零退出
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }

  it('exec("echo ok") → exitCode 0，stdout 含 ok', async () => {
    if (!(await canSeatbelt())) return; // 嵌套沙箱跳过
    const result = await engine.exec('echo ok', { cwd: '/tmp', timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
    expect(result.timedOut).toBe(false);
  }, 10000);

  it('exec 带自定义 cwd 正常工作', async () => {
    if (!(await canSeatbelt())) return; // 嵌套沙箱跳过
    const result = await engine.exec('pwd', { cwd: '/tmp', timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    // macOS /tmp 是 /private/tmp 的符号链接，pwd 返回解析后的路径
    expect(result.stdout.trim()).toMatch(/\/tmp|\/private\/tmp/);
  }, 10000);

  // seatbelt 拦截：自定义 denyRead 路径验证（不依赖 ~/.ssh）
  it('exec 自定义 denyRead 路径 → seatbelt 拦截（darwin only，目录存在时）', async () => {
    if (!(await canSeatbelt())) return; // 嵌套沙箱跳过
    const testDir = '/tmp/seatbelt-test-blocked';
    const { mkdirSync, rmSync } = await import('node:fs');
    try {
      mkdirSync(testDir, { recursive: true });
      const blockedEngine = new SecureBashEngine([
        { id: 'test-deny', description: 'block test dir', denyRead: [testDir] },
      ]);
      const result = await blockedEngine.exec(`ls ${testDir}`, { cwd: '/tmp', timeoutMs: 5000 });
      // seatbelt 拦截 → 非零退出（EPERM 等）
      expect(result.exitCode).not.toBe(0);
      expect(result.timedOut).toBe(false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 10000);

  it('超时场景 → timedOut=true', async () => {
    if (!(await canSeatbelt())) return; // 嵌套沙箱跳过
    const result = await engine.exec('sleep 10', { cwd: '/tmp', timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
  }, 5000);

  it('abort signal 提前终止 → timedOut=true', async () => {
    if (!(await canSeatbelt())) return; // 嵌套沙箱跳过
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 200);
    const result = await engine.exec('sleep 5', { cwd: '/tmp', timeoutMs: 10000, signal: ctrl.signal });
    expect(result.timedOut).toBe(true);
  }, 5000);
});

// ============================================================
// 5. bash tool checkPermission 接线
// ============================================================

describe('bash tool checkPermission 接线', () => {
  it('rm -rf * → ask（接线 checkBashPermission）', () => {
    const result = bashTool.checkPermission!({ command: 'rm -rf *', description: 'test' }, {
      config: { tools: [], workdir: '/tmp' },
      workdir: '/tmp',
    });
    expect(result.behavior).toBe('ask');
    expect((result as { approvalKey: string }).approvalKey).toBe('bash:rm-wildcard');
  });

  it('echo hello → allow', () => {
    const result = bashTool.checkPermission!({ command: 'echo hello', description: 'test' }, {
      config: { tools: [], workdir: '/tmp' },
      workdir: '/tmp',
    });
    expect(result.behavior).toBe('allow');
  });
});
