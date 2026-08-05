/**
 * bash-engine + bash-policy UT（v0.0.122）
 * 参考: specs/tech/agent/tools/[P0]bash_tools.md §4/§5
 *       specs/tech/version_logs/v0.0.122/change_plan.md 模块 E/G
 *
 * 覆盖点：
 *   1. detectSshRead — 命中/负例（含 AT case approval_sandbox_tc1 的间接拼接负例）
 *   2. detectRmWildcard — 命中/负例
 *   3. checkBashPermission — deny 优先（ls ~/.ssh && rm * → deny）
 *   4. compileSeatbeltProfile — 单/多策略、~ 展开为绝对路径（无字面 ~）
 *   5. SecureBashEngine — darwin 真实行为（exec ok + seatbelt 拦 ~/.ssh）
 *   6. bash tool checkPermission 接线（调 checkBashPermission）
 */
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { detectSshRead, detectRmWildcard, checkBashPermission } from '../bash-policy';
import { compileSeatbeltProfile, SecureBashEngine } from '../bash-engine';
import { bashTool } from '../bash';

// ============================================================
// 1. detectSshRead — 命中 / 负例
// ============================================================

describe('detectSshRead — 命中场景', () => {
  it('ls ~/.ssh 命中 deny', () => {
    const result = detectSshRead('ls ~/.ssh');
    expect(result?.behavior).toBe('deny');
    expect((result as { reason: string })?.reason).toBe('禁止访问 ~/.ssh 敏感目录');
  });

  it('cat $HOME/.ssh/id_rsa 命中 deny', () => {
    const result = detectSshRead('cat $HOME/.ssh/id_rsa');
    expect(result?.behavior).toBe('deny');
  });

  it('/Users/foo/.ssh/known_hosts 命中 deny（具体用户目录形式）', () => {
    const result = detectSshRead('cat /Users/foo/.ssh/known_hosts');
    expect(result?.behavior).toBe('deny');
  });

  it('ls -la ~/.ssh/id_rsa 命中 deny', () => {
    const result = detectSshRead('ls -la ~/.ssh/id_rsa');
    expect(result?.behavior).toBe('deny');
  });

  it('echo ~/.ssh 命中 deny（echo 参数含 .ssh 路径）', () => {
    const result = detectSshRead('echo ~/.ssh');
    expect(result?.behavior).toBe('deny');
  });
});

describe('detectSshRead — 负例（不应误判）', () => {
  it('间接拼接 d=$HOME/.s; ls "${d}sh" 不命中（AT case approval_sandbox_tc1 关键负例）', () => {
    const result = detectSshRead('d=$HOME/.s; ls "${d}sh"');
    expect(result).toBeNull(); // 参数层不检测，交 seatbelt 拦
  });

  it('~/xssh 不命中（点号须转义，否则 ~ + 任意字符 + ssh 会误匹配）', () => {
    const result = detectSshRead('ls ~/xssh');
    expect(result).toBeNull(); // 修正前的 bug：未转义 . 会让此路径误判
  });

  it('~/Essh 不命中（同 ~/xssh 负例）', () => {
    const result = detectSshRead('cat ~/Essh');
    expect(result).toBeNull();
  });

  it('~/myssh_notes 不命中（路径不含 /.ssh）', () => {
    const result = detectSshRead('ls ~/myssh_notes');
    expect(result).toBeNull();
  });

  it('rm file.txt 不命中', () => {
    const result = detectSshRead('rm file.txt');
    expect(result).toBeNull();
  });

  it('普通 ls /tmp 不命中', () => {
    const result = detectSshRead('ls /tmp');
    expect(result).toBeNull();
  });

  it('$HOME 本身不含 .ssh 不命中', () => {
    const result = detectSshRead('echo $HOME');
    expect(result).toBeNull();
  });
});

// ============================================================
// 2. detectRmWildcard — 命中 / 负例
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
// 3. checkBashPermission — deny 优先
// ============================================================

describe('checkBashPermission — deny 优先（ls ~/.ssh && rm * → deny）', () => {
  it('ls ~/.ssh && rm * → deny（deny 优先于 ask）', () => {
    const result = checkBashPermission('ls ~/.ssh && rm *');
    expect(result.behavior).toBe('deny');
    expect((result as { reason: string }).reason).toBe('禁止访问 ~/.ssh 敏感目录');
  });

  it('ls ~/.ssh 单独 → deny', () => {
    const result = checkBashPermission('ls ~/.ssh');
    expect(result.behavior).toBe('deny');
  });

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
// 4. compileSeatbeltProfile — 字符串形态 + ~ 展开
// ============================================================

describe('compileSeatbeltProfile — profile 字符串生成', () => {
  it('单条 denyRead 策略生成正确 profile', () => {
    const profile = compileSeatbeltProfile([
      { id: 'ssh-read-block', description: 'test', denyRead: ['~/.ssh'] },
    ]);
    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(allow default)');

    // ~ 应被展开为绝对路径（homedir 不含字面 ~）
    const expectedPath = join(homedir(), '.ssh');
    expect(profile).toContain(`(deny file-read* (subpath "${expectedPath}"))`);
    expect(profile).not.toContain('~'); // 无字面 ~ 残留（BUG-004 护栏）
  });

  it('多条策略展开所有路径', () => {
    const profile = compileSeatbeltProfile([
      { id: 'p1', description: 'a', denyRead: ['~/.ssh', '~/.aws'] },
      { id: 'p2', description: 'b', denyWrite: ['~/sensitive'] },
    ]);
    const sshPath = join(homedir(), '.ssh');
    const awsPath = join(homedir(), '.aws');
    const sensPath = join(homedir(), 'sensitive');

    expect(profile).toContain(`(deny file-read* (subpath "${sshPath}"))`);
    expect(profile).toContain(`(deny file-read* (subpath "${awsPath}"))`);
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
// 5. SecureBashEngine — darwin 真实行为（本机是 mac）
// ============================================================

describe('SecureBashEngine — darwin 真实行为', () => {
  const engine = new SecureBashEngine([
    { id: 'ssh-read-block', description: 'block ssh', denyRead: ['~/.ssh'] },
  ]);

  it('exec("echo ok") → exitCode 0，stdout 含 ok', async () => {
    const result = await engine.exec('echo ok', { cwd: '/tmp', timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
    expect(result.timedOut).toBe(false);
  }, 10000);

  it('exec 带自定义 cwd 正常工作', async () => {
    const result = await engine.exec('pwd', { cwd: '/tmp', timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    // macOS /tmp 是 /private/tmp 的符号链接，pwd 返回解析后的路径
    expect(result.stdout.trim()).toMatch(/\/tmp|\/private\/tmp/);
  }, 10000);

  // seatbelt 拦截：仅当本机存在 ~/.ssh 时才跑（不自建假目录）
  it('exec("ls ~/.ssh") → seatbelt 拦截，非零退出（darwin only，~/.ssh 存在时）', async () => {
    const sshPath = join(homedir(), '.ssh');
    if (!existsSync(sshPath)) {
      // 本机无 ~/.ssh，跳过此 case（安全红线：不自建 .ssh 目录）
      console.log('SKIP: ~/.ssh 不存在，跳过 seatbelt 拦截 UT');
      return;
    }
    const result = await engine.exec('ls ~/.ssh', { cwd: '/tmp', timeoutMs: 5000 });
    // seatbelt 拦截 → 非零退出（EPERM 等）
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  }, 10000);

  it('超时场景 → timedOut=true', async () => {
    const result = await engine.exec('sleep 10', { cwd: '/tmp', timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
  }, 5000);

  it('abort signal 提前终止 → timedOut=true', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 200);
    const result = await engine.exec('sleep 5', { cwd: '/tmp', timeoutMs: 10000, signal: ctrl.signal });
    expect(result.timedOut).toBe(true);
  }, 5000);
});

// ============================================================
// 6. bash tool checkPermission 接线
// ============================================================

describe('bash tool checkPermission 接线', () => {
  it('ls ~/.ssh → deny（接线 checkBashPermission）', () => {
    const result = bashTool.checkPermission!({ command: 'ls ~/.ssh', description: 'test' }, {
      config: { tools: [], workdir: '/tmp' },
      workdir: '/tmp',
    });
    expect(result.behavior).toBe('deny');
  });

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
