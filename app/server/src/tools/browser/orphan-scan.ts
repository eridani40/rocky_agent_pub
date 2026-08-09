/**
 * orphan-scan —— Rocky 孤儿 Chrome 进程扫描 + 三层孤儿判定（对账兜底回收）
 * 参考: specs/tech/version_logs/v0.0.272/change_plan.md 裁决 1-3
 *       specs/tech/agent/tools/[P1]browser_instance_manager.md §4.8
 *
 * 设计（对账模型）：
 *   - marker 白名单识别（isRockyChromeMarker）：绝不用进程名匹配（用户主 Chrome 也是 chrome 名），
 *     只认 rocky 专属 cmdline 特征（worker/instance 临时目录前缀 / ET prof 目录 / CDP 18800-18899 段）。
 *   - 三层孤儿判定（isOrphanChrome）：①pid ∈ 活跃 chromePidSet（新实例精确）②ppid ∈ 活跃
 *     workerPidSet（旧记录 v0.0.272 前无 chromePid 兼容）③ppid cmdline 含 worker-entry（launch 中
 *     worker 已 spawn 但 handle 未入表保护）→ 否则孤儿（真孤儿 reparent 到 PPID=1）。
 *   - 双段扫描（scanRockyChromeProcesses）：all = 全量进程表（ppid 反查 worker-entry cmdline 用，
 *     C1 修复——procByPid 必须含 worker-entry node 进程）+ candidates = marker chrome 候选集
 *     （isOrphanChrome 只对候选判定回收，worker-entry 进程本身天然不在候选不被回收）。
 *   - 纯函数无副作用：ps 扫描 exec 可注入（测试 mock）。
 */
import { execFile } from 'node:child_process';
import { CDP_PORT_RANGE_START, CDP_PORT_RANGE_END } from './cdp-port';

/** Rocky 临时 worker 目录前缀（node-worker-driver mkdtemp；launch 前 worker 自身临时目录） */
const ROCKY_WORKER_DIR_PREFIX = 'rocky-browser-worker-';
/** Rocky headless 临时实例目录前缀（worker-mode-impl mkdtemp；chrome user-data-dir） */
const ROCKY_INSTANCE_DIR_PREFIX = 'rocky-browser-instance-';
/** ET playwright user-data-dir 前缀（tests/e2e，形如 et<digits>-prof） */
const ET_PROF_RE = /et\d+-prof/;

/** 扫描出的 Chrome 进程信息（对账判定数据源） */
export interface ChromeProcInfo {
  pid: number;
  ppid: number;
  cmdline: string;
  /** 从 cmdline 提取的 rocky user-data-dir（孤儿目录清理用；可能 null） */
  userDataDir: string | null;
}

/** isOrphanChrome 判定上下文（活跃集合 + 进程表） */
export interface OrphanChromeCtx {
  /** 活跃 chromePid 集合（instances chromePid + 持久化记录同字段） */
  chromePidSet: Set<number>;
  /** 活跃 workerPid 集合（instances workerPid + 持久化记录同字段） */
  workerPidSet: Set<number>;
  /** 全量进程表（ppid cmdline 查 worker-entry 用；pid → cmdline） */
  procByPid: Map<number, string>;
}

/**
 * Rocky Chrome marker 白名单判定（纯函数）。
 * 命中任一即 true：rocky-browser-worker-/rocky-browser-instance- 临时目录前缀 /
 * et<digits>-prof（ET playwright）/ --remote-debugging-port ∈ [18800,18899]（rocky CDP 段）。
 * 白名单过滤（非黑名单）：无 marker 一律 false——attach 用户 Chrome（9222 段）不命中。
 */
export function isRockyChromeMarker(cmdline: string): boolean {
  if (typeof cmdline !== 'string' || cmdline.length === 0) return false;
  if (cmdline.includes(ROCKY_WORKER_DIR_PREFIX)) return true;
  if (cmdline.includes(ROCKY_INSTANCE_DIR_PREFIX)) return true;
  if (ET_PROF_RE.test(cmdline)) return true;
  // --remote-debugging-port=<port> 在 rocky CDP 段内（用户 Chrome 9222 不命中）
  const portMatch = cmdline.match(/--remote-debugging-port=(\d+)/);
  if (portMatch) {
    const port = Number(portMatch[1]);
    if (Number.isInteger(port) && port >= CDP_PORT_RANGE_START && port <= CDP_PORT_RANGE_END) return true;
  }
  return false;
}

/**
 * 从 cmdline 提取 rocky user-data-dir（孤儿目录清理用）。
 * 只提取 rocky marker 目录（rocky-browser-instance- 前缀或 et*-prof 前缀），
 * rmSync 前二次验证防误删；解析失败返 null。
 */
export function extractUserDataDir(cmdline: string): string | null {
  if (typeof cmdline !== 'string') return null;
  const m = cmdline.match(/--user-data-dir=("?)([^"\s]+)\1/);
  if (!m) return null;
  const dir = m[2]!;
  // 二次验证：只认 rocky marker 目录（防误删用户 Chrome 数据目录）
  const base = dir.split('/').pop() ?? '';
  if (base.includes(ROCKY_INSTANCE_DIR_PREFIX)) return dir;
  if (ET_PROF_RE.test(base)) return dir;
  return null;
}

/**
 * 全量 ps 扫描 → 双段返回（exec 可注入；坏行跳过容错）。
 * ps -axo pid,ppid,command（BSD 语法，macOS 支持）。
 *
 * 设计（C1 修复）：procByPid 反查必须基于**全量进程表**（含 worker-entry node 进程——
 * cmdline 无 rocky marker 但 ppid 反查需要它），回收判定只对 marker chrome 候选集。
 * 两段分离：
 *   - all = 全量进程（pid → cmdline 建 procByPid，供 isOrphanChrome 第三层 ppid 反查）
 *   - candidates = marker chrome 候选（isOrphanChrome 只对候选判定回收；
 *     worker-entry 进程本身不在候选 → 天然不会被回收）
 */
export interface ChromeScanResult {
  /** 全量进程表（含 worker-entry / 用户 chrome / 任意进程；建 procByPid 用） */
  all: ChromeProcInfo[];
  /** marker chrome 候选集（回收判定对象；仅 rocky marker 命中） */
  candidates: ChromeProcInfo[];
}

export function scanRockyChromeProcesses(
  exec?: (cmd: string, args: string[]) => Promise<string>,
): Promise<ChromeScanResult> {
  const run = exec ?? defaultPsExec;
  return run('ps', ['-axo', 'pid,ppid,command']).then((out) => {
    const all: ChromeProcInfo[] = [];
    const candidates: ChromeProcInfo[] = [];
    const lines = out.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue; // 坏行跳过
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      const cmdline = m[3] ?? '';
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      const info: ChromeProcInfo = { pid, ppid, cmdline, userDataDir: extractUserDataDir(cmdline) };
      all.push(info);
      if (isRockyChromeMarker(cmdline)) candidates.push(info);
    }
    return { all, candidates };
  });
}

/**
 * 三层孤儿判定（纯函数）：
 *   ① pid ∈ 活跃 chromePidSet → 活跃（新实例 chromePid 精确）
 *   ② ppid ∈ 活跃 workerPidSet → 活跃（旧记录 v0.0.272 前无 chromePid 兼容）
 *   ③ ppid cmdline 含 worker-entry → 活跃（launch 中：worker 已 spawn 但 handle 未入 instances）
 *   ④ 否则 → 孤儿（真孤儿 reparent 到 PPID=1 / 无 worker-entry）
 * @returns true = 孤儿（应回收）；false = 活跃（受保护）
 */
export function isOrphanChrome(proc: ChromeProcInfo, ctx: OrphanChromeCtx): boolean {
  // ① chromePid 精确命中 → 活跃
  if (ctx.chromePidSet.has(proc.pid)) return false;
  // ② ppid ∈ workerPidSet → 活跃
  if (ctx.workerPidSet.has(proc.ppid)) return false;
  // ③ ppid cmdline 含 worker-entry（launch 中保护）
  const ppidCmdline = ctx.procByPid.get(proc.ppid);
  if (ppidCmdline && ppidCmdline.includes('worker-entry')) return false;
  // ④ 否则孤儿
  return true;
}

/** 默认 ps 执行（execFile promise 化；失败 reject 由调用方 catch） */
function defaultPsExec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { reject(err); return; }
      resolve(stdout);
    });
  });
}

/** 构造 isOrphanChrome 判定上下文（从扫描结果建 procByPid） */
export function buildOrphanCtx(procs: ChromeProcInfo[]): { procByPid: Map<number, string> } {
  const procByPid = new Map<number, string>();
  for (const p of procs) procByPid.set(p.pid, p.cmdline);
  return { procByPid };
}
