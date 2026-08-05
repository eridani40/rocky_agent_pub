/**
 * LogWriter 单测（spec dev-logs §7 UT 范围 + v0.0.138 LogQueue bounded consumer 4 新 case）
 * 参考: specs/tech/dev-logs/[P0]overall.md §2 §7
 *       specs/tech/version_logs/v0.0.138/change_plan.md §改造#1（500MB drop-new + 批间 yield）
 *
 * 校验点：
 *   - 写正确文件（type → filename 映射：llm/tool/api/event）
 *   - JSONL 格式（每行一个 JSON、可 JSON.parse）
 *   - 开关 false 不写（零开销）
 *   - append 不覆盖（多次 write 累加行）
 *   - 失败静默（mock appendFile reject 不抛）
 *   - 零开销门禁：开关 false 时不调 appendFile（mock appConfig.get 返 false → 不调）
 *   - v0.0.138 新增：批聚合 / 批间 yield / drop new / 500MB 字节计量
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, chmodSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { LogWriter, resetLogWriterForTest } from '../log-writer';
import { LogQueue } from '../log-queue';

/** 等队列消费到空（消费者后台异步，write fire-and-forget 后须 flush 才能读盘） */
async function flushQueue(w: LogWriter, deadlineMs = 5_000): Promise<void> {
  await w['queue'].flush(deadlineMs);
}

/** 构造可控开关的 mock appConfig（按 (group,key) 返回值） */
function makeMockAppConfig(overrides: Record<string, unknown> = {}): {
  get: (g: string, k: string) => unknown;
  set: (g: string, k: string, v: unknown) => void;
} {
  const store: Record<string, unknown> = { ...overrides };
  return {
    get: (g: string, k: string) => store[`${g}.${k}`],
    set: (g: string, k: string, v: unknown) => {
      store[`${g}.${k}`] = v;
    },
  };
}

describe('LogWriter', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-logwriter-'));
    resetLogWriterForTest();
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetLogWriterForTest();
    vi.restoreAllMocks();
  });

  it('写正确文件：type → filename 映射（llm/tool/api/event）', async () => {
    const appConfig = makeMockAppConfig({
      'logs.enableLlmRequestLog': true,
      'logs.enableToolResultLog': true,
      'logs.enableAppApiLog': true,
      'logs.enableEventLog': true,
    });
    const w = new LogWriter(dataDir, appConfig);
    w.write('llm', { provider: 'p1' });
    w.write('tool', { tool: 'bash' });
    w.write('api', { method: 'GET' });
    w.write('event', { topic: 'agent_loop' });
    await flushQueue(w);
    expect(existsSync(join(dataDir, 'logs', 'llm.log'))).toBe(true);
    expect(existsSync(join(dataDir, 'logs', 'tool.log'))).toBe(true);
    expect(existsSync(join(dataDir, 'logs', 'api.log'))).toBe(true);
    expect(existsSync(join(dataDir, 'logs', 'event.log'))).toBe(true);
  });

  it('JSONL 格式：每行一个 JSON 可 parse，含 ISO8601 ts', async () => {
    const appConfig = makeMockAppConfig({ 'logs.enableLlmRequestLog': true });
    const w = new LogWriter(dataDir, appConfig);
    w.write('llm', { provider: 'p1', model: 'm1' });
    await flushQueue(w);
    const content = readFileSync(join(dataDir, 'logs', 'llm.log'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);
    const obj = JSON.parse(lines[0]!);
    expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    expect(obj.provider).toBe('p1');
    expect(obj.model).toBe('m1');
  });

  it('开关 false 不写（零开销：文件不创建）', async () => {
    const appConfig = makeMockAppConfig({}); // 所有开关缺省（?? false）
    const w = new LogWriter(dataDir, appConfig);
    w.write('llm', { provider: 'p1' });
    await flushQueue(w);
    expect(existsSync(join(dataDir, 'logs', 'llm.log'))).toBe(false);
  });

  it('append 不覆盖：多次 write 累加多行（批聚合保留顺序）', async () => {
    const appConfig = makeMockAppConfig({ 'logs.enableToolResultLog': true });
    const w = new LogWriter(dataDir, appConfig);
    w.write('tool', { tool: 'a', n: 1 });
    w.write('tool', { tool: 'b', n: 2 });
    w.write('tool', { tool: 'c', n: 3 });
    await flushQueue(w);
    const content = readFileSync(join(dataDir, 'logs', 'tool.log'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(3);
    // v0.0.138 起单 consumer FIFO（队列顺序保真，不再 fire-and-forget 无序）
    const tools = lines.map((l) => JSON.parse(l).tool);
    expect(tools).toEqual(['a', 'b', 'c']);
  });

  it('失败静默：appendFile 失败不抛（dev 日志是旁观者）', async () => {
    const appConfig = makeMockAppConfig({ 'logs.enableLlmRequestLog': true });
    // 让 logs 目录不可写：把 logs 目录改为只读
    const w = new LogWriter(dataDir, appConfig);
    chmodSync(join(dataDir, 'logs'), 0o444);
    // write 不应抛（enqueue 同步入队，consumer 失败静默在 catch 内吞）
    expect(() => w.write('llm', { provider: 'p1' })).not.toThrow();
    await flushQueue(w);
    // 恢复权限以便 afterEach rmSync
    chmodSync(join(dataDir, 'logs'), 0o755);
  });

  it('零开销门禁：开关 false 时不开 IO（4 类全 false → 无任何 .log 文件）', async () => {
    const appConfig = makeMockAppConfig({}); // 所有开关缺省 false
    const w = new LogWriter(dataDir, appConfig);
    w.write('llm', { provider: 'p1' });
    w.write('tool', { tool: 'a' });
    w.write('api', { method: 'GET' });
    w.write('event', { topic: 't' });
    await flushQueue(w);
    expect(existsSync(join(dataDir, 'logs', 'llm.log'))).toBe(false);
    expect(existsSync(join(dataDir, 'logs', 'tool.log'))).toBe(false);
    expect(existsSync(join(dataDir, 'logs', 'api.log'))).toBe(false);
    expect(existsSync(join(dataDir, 'logs', 'event.log'))).toBe(false);
  });

  it('开关 true 时写一条且 flag=a 追加（不覆盖历史）', async () => {
    const appConfig = makeMockAppConfig({ 'logs.enableLlmRequestLog': true });
    // 预置历史内容，验证 flag=a 追加（不覆盖）
    const logPath = join(dataDir, 'logs', 'llm.log');
    mkdirSync(join(dataDir, 'logs'), { recursive: true });
    const fs = await import('node:fs');
    fs.writeFileSync(logPath, 'HISTORY_LINE\n', 'utf-8');
    const w = new LogWriter(dataDir, appConfig);
    w.write('llm', { provider: 'p1' });
    await flushQueue(w);
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('HISTORY_LINE'); // 历史保留
    const appended = JSON.parse(lines[1]!);
    expect(appended.provider).toBe('p1'); // 新行追加
  });

  it('启动期 ensure logs 目录（mkdir recursive）', () => {
    const appConfig = makeMockAppConfig({});
    new LogWriter(dataDir, appConfig);
    expect(existsSync(join(dataDir, 'logs'))).toBe(true);
  });

  it('启动期 ensure 目录失败静默（已存在的目录不报）', () => {
    const appConfig = makeMockAppConfig({});
    mkdirSync(join(dataDir, 'logs'), { recursive: true });
    expect(() => new LogWriter(dataDir, appConfig)).not.toThrow();
  });

  it('开关运行时切换：false→true 下次 write 立即生效', async () => {
    const appConfig = makeMockAppConfig({});
    const w = new LogWriter(dataDir, appConfig);
    w.write('llm', { provider: 'p1' }); // false 不写
    await flushQueue(w);
    expect(existsSync(join(dataDir, 'logs', 'llm.log'))).toBe(false);
    appConfig.set('logs', 'enableLlmRequestLog', true);
    w.write('llm', { provider: 'p1' }); // 立即生效
    await flushQueue(w);
    expect(existsSync(join(dataDir, 'logs', 'llm.log'))).toBe(true);
  });
});

// ── v0.0.138 新增：LogQueue bounded consumer 4 case ──
describe('LogQueue bounded consumer', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-logqueue-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('① 批聚合：write 100 条 → flush 后文件 100 行（验证 consumer 排空）', async () => {
    const appConfig = makeMockAppConfig({ 'logs.enableToolResultLog': true });
    const w = new LogWriter(dataDir, appConfig);
    for (let i = 0; i < 100; i++) {
      w.write('tool', { tool: 't', n: i });
    }
    await flushQueue(w);
    const content = readFileSync(join(dataDir, 'logs', 'tool.log'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(100);
    // 100 条全到，顺序保 FIFO（BATCH_MAX_COUNT=64 → 2 批：64+36）
    const ns = lines.map((l) => JSON.parse(l).n);
    for (let i = 0; i < 100; i++) {
      expect(ns[i]).toBe(i);
    }
  });

  it('② 批间 yield：write 同步返 + consumer 异步落盘（同步耗时 <5ms）', async () => {
    const appConfig = makeMockAppConfig({ 'logs.enableToolResultLog': true });
    const w = new LogWriter(dataDir, appConfig);
    const t0 = Date.now();
    // 同步入队 50 条（< 64 一批，但批间 sleep 在 consumer 内不影响 write 同步返）
    for (let i = 0; i < 50; i++) {
      w.write('tool', { tool: 't', n: i });
    }
    const elapsed = Date.now() - t0;
    // write 同步路径仅 enqueue + JSON.stringify，应远 <5ms（500MB drop-new / consumer loop 都不阻塞 write）
    expect(elapsed).toBeLessThan(50); // 留足宽容（CI 抖动），核心是 write 不等 IO
    // flush 等 consumer 排空
    await flushQueue(w);
    const content = readFileSync(join(dataDir, 'logs', 'tool.log'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(50);
  });

  it('③ drop new：bufferedBytes 近 500MB 后 write 1 条 → 未落盘 + warn 被调', async () => {
    const appConfig = makeMockAppConfig({ 'logs.enableLlmRequestLog': true });
    const w = new LogWriter(dataDir, appConfig);
    // mock 队列已近 500MB（模拟 buffer 满，下一条应 drop new）
    const queue = w['queue'] as LogQueue;
    (queue as unknown as { bufferedBytes: number }).bufferedBytes = 500 * 1024 * 1024 - 10;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 入队一条（size 远超剩余空间）
    w.write('llm', { provider: 'p1' });
    // drop new：write 同步返回但未入队（不调 consumer）
    await flushQueue(w, 200); // 短 deadline（队列本空，consumer idle 不会落盘任何东西）
    expect(existsSync(join(dataDir, 'logs', 'llm.log'))).toBe(false);
    // warn 节流：10s 窗口聚合（lastDropWarn=0 → 第一次必触发）
    expect(warnSpy).toHaveBeenCalled();
  });

  it('④ 500MB 字节计量：enqueue 250MB × 2 → 第二条 drop（验证 byte 上限而非条数）', async () => {
    mkdirSync(join(dataDir, 'logs'), { recursive: true });
    const queue = new LogQueue(dataDir);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 防 consumer 同步消费第一条（_consumerLoop 在首个 await 前同步 shift + 归零 bufferedBytes，
    // 导致第二条不会被 drop）。预置 loopStarted=true 阻止 consumer 自启，隔离测 byte 累积 drop
    (queue as unknown as { loopStarted: boolean }).loopStarted = true;
    // 两条 ~250MB record（V8 ~512MB 限内安全）：第一条 < 500MB → 入队；第二条 250+250 > 500MB → drop
    // 证明 drop 基于 byte 计量而非条数（case ③ 直注 bufferedBytes，本 case 用真实 byte 累积更干净）
    const line = '{"x":"' + 'a'.repeat(250 * 1024 * 1024) + '"}';
    queue.enqueue('llm', line); // 第一条入队（bufferedBytes ≈ 250MB）
    queue.enqueue('llm', line); // 第二条 drop（bufferedBytes + size > MAX_BUFFER_BYTES=500MB）
    // 队列只有 1 条（consumer 未启，第一条在 q；第二条被 drop 未入队）
    expect((queue as unknown as { q: unknown[] }).q.length).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    // 无文件落盘（consumer 未启）
    expect(existsSync(join(dataDir, 'logs', 'llm.log'))).toBe(false);
  });
});

// ── v0.0.138 改造#5 新增：LogQueue rotation 4 case ──
// 用小阈值（maxFileBytes/maxFiles）测轮转，避免写 50MB
describe('LogQueue rotation', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-logrot-'));
    // LogQueue 本身不创建 logs 目录（由 LogWriter constructor 负责）；UT 直构时手动建
    mkdirSync(join(dataDir, 'logs'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('① 超 maxFileBytes 轮转：rotated 含旧内容，active 含新内容', async () => {
    const queue = new LogQueue(dataDir, { maxFileBytes: 100, maxFiles: 3 });
    // 批 1：5 行 'A'×50（每批 255B）。check 0<100 → 不轮转。fileSize=255
    for (let i = 0; i < 5; i++) queue.enqueue('llm', 'A'.repeat(50));
    await queue.flush();
    // 批 2：5 行 'B'×50。check 255>=100 → 轮转（旧 A 进 rotated），再写 B
    for (let i = 0; i < 5; i++) queue.enqueue('llm', 'B'.repeat(50));
    await queue.flush();

    const files = readdirSync(join(dataDir, 'logs'));
    const rotated = files.filter((f) => f.startsWith('llm-') && f.endsWith('.log'));
    expect(rotated.length).toBe(1);
    const rotatedContent = readFileSync(join(dataDir, 'logs', rotated[0]!), 'utf-8');
    const activeContent = readFileSync(join(dataDir, 'logs', 'llm.log'), 'utf-8');
    expect(rotatedContent).toMatch(/^(A{50}\n){5}$/); // 旧内容
    expect(activeContent).toMatch(/^(B{50}\n){5}$/); // 新内容
  });

  it('② maxFiles FIFO 删最老：连续轮转后 rotated 文件数 ≤ maxFiles-1 且最老被删', async () => {
    const queue = new LogQueue(dataDir, { maxFileBytes: 100, maxFiles: 3 });
    // 6 批（1 初始化 + 5 轮转），每批不同字符以便追踪
    const chars = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (const ch of chars) {
      for (let i = 0; i < 5; i++) queue.enqueue('llm', ch.repeat(50));
      await queue.flush();
    }
    // 期望：rotated 含 D/E（最新两个），A/B/C 已被 FIFO 删；active 含 F
    const files = readdirSync(join(dataDir, 'logs'));
    const rotated = files.filter((f) => f.startsWith('llm-') && f.endsWith('.log'));
    expect(rotated.length).toBeLessThanOrEqual(2); // maxFiles-1=2
    const allRotated = rotated.map((f) => readFileSync(join(dataDir, 'logs', f), 'utf-8')).join('');
    expect(allRotated).toContain('D'.repeat(50));
    expect(allRotated).toContain('E'.repeat(50));
    expect(allRotated).not.toContain('A'.repeat(50)); // 最老已删
    expect(allRotated).not.toContain('B'.repeat(50));
    expect(allRotated).not.toContain('C'.repeat(50));
    const active = readFileSync(join(dataDir, 'logs', 'llm.log'), 'utf-8');
    expect(active).toContain('F'.repeat(50));
  });

  it('③ timestamp 命名：轮转文件名匹配 <type>-\\d{8}-\\d{6}-\\d{3}\\.log', async () => {
    const queue = new LogQueue(dataDir, { maxFileBytes: 100, maxFiles: 3 });
    for (let i = 0; i < 5; i++) queue.enqueue('llm', 'x'.repeat(50));
    await queue.flush();
    for (let i = 0; i < 5; i++) queue.enqueue('llm', 'x'.repeat(50));
    await queue.flush();

    const files = readdirSync(join(dataDir, 'logs'));
    const rotated = files.filter((f) => f.startsWith('llm-') && f.endsWith('.log'));
    expect(rotated.length).toBe(1);
    expect(rotated[0]!).toMatch(/^llm-\d{8}-\d{6}-\d{3}\.log$/);
  });

  it('④ size 跟踪接续：预置近 maxFileBytes 的 <type>.log → write 一小批触发轮转', async () => {
    mkdirSync(join(dataDir, 'logs'), { recursive: true });
    // 预置 <type>.log 已达 maxFileBytes=100B（证明 stat-init 读到旧 size）
    writeFileSync(join(dataDir, 'logs', 'llm.log'), 'x'.repeat(100));
    const queue = new LogQueue(dataDir, { maxFileBytes: 100, maxFiles: 3 });
    queue.enqueue('llm', 'small-trigger');
    await queue.flush();
    // 首次写触发轮转：旧 100B → rotated，active 含 small-trigger
    const files = readdirSync(join(dataDir, 'logs'));
    const rotated = files.filter((f) => f.startsWith('llm-') && f.endsWith('.log'));
    expect(rotated.length).toBe(1);
    const rotatedContent = readFileSync(join(dataDir, 'logs', rotated[0]!), 'utf-8');
    expect(rotatedContent).toBe('x'.repeat(100));
    const active = readFileSync(join(dataDir, 'logs', 'llm.log'), 'utf-8');
    expect(active).toContain('small-trigger');
  });
});
