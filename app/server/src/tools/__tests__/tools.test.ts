/**
 * tools 子系统单元测试（v0.0.8 task-4）
 * 参考: states/v0.0.8/task.json task-4 acceptance
 *       specs/tech/agent/tools/[P0]file_op_tools.md
 *       specs/tech/agent/tools/[P0]bash_tools.md
 *       specs/tech/agent/tools/[P0]tool_execution_engine.md §4
 *
 * 覆盖（acceptance 逐条）：
 *   - file-read 正确读（含行号）
 *   - file-write 先 read 后写（未 read 覆盖 → isError）
 *   - file-edit 精确替换 + 唯一性失败 isError
 *   - file-glob pattern 匹配
 *   - file-grep 正则匹配
 *   - bash timeout 触发 reject（isError）
 *   - bash 输出 >64KB 截断含标记
 *   - 串行引擎 results 顺序绑定 toolCallId
 *   - 相对路径 file 操作 isError
 *
 * 文件系统隔离：全部用 os.tmpdir() + mkdtempSync，afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolExecutionEngine } from '../engine';
import { defaultTools } from '../registry';
import { fileReadTool } from '../file-read';
import { fileWriteTool } from '../file-write';
import { fileEditTool } from '../file-edit';
import { fileGlobTool } from '../file-glob';
import { fileGrepTool } from '../file-grep';
import { bashTool } from '../bash';
import type { ToolCtx, ToolInput } from '../types';
import type { ToolCallBlock } from '../../message/types';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'tools-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造一个共享 readSet 的 ctx（workdir = tmpRoot） */
function makeCtx(): ToolCtx {
  return {
    config: { tools: [], workdir: tmpRoot },
    workdir: tmpRoot,
    readSet: new Set<string>(),
  };
}

/** 从 ToolRunResult/ToolResultBlock 取出首个 TextBlock 的 text（断言非空，测试专用） */
function textOf(
  res: { content: { type: string; text?: string }[] } | undefined,
): string {
  // noUncheckedIndexedAccess 下 content[0] 可能为 undefined；测试断言保证存在，用 as 断言
  const first = (res as { content: { text: string }[] }).content[0];
  return (first as { text: string }).text;
}

// ============================================================
// file-read
// ============================================================
describe('file-read', () => {
  it('正确读取文件（cat -n 风格含行号）', async () => {
    const p = join(tmpRoot, 'a.txt');
    writeFileSync(p, 'line1\nline2\nline3');
    const res = await fileReadTool.run({ filePath: p }, makeCtx());
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBeDefined();
    const text = textOf(res);
    // 行号 + tab + 内容
    expect(text).toContain('1\tline1');
    expect(text).toContain('2\tline2');
    expect(text).toContain('3\tline3');
  });

  it('相对路径 → isError', async () => {
    const res = await fileReadTool.run({ filePath: 'relative/x.txt' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/path_not_absolute/i);
  });

  it('文件不存在 → isError', async () => {
    const res = await fileReadTool.run({ filePath: join(tmpRoot, 'nope.txt') }, makeCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not_found/i);
  });

  it('支持 offset/limit 分页', async () => {
    const p = join(tmpRoot, 'p.txt');
    writeFileSync(p, '1\n2\n3\n4\n5');
    const res = await fileReadTool.run({ filePath: p, offset: 2, limit: 2 }, makeCtx());
    const text = textOf(res);
    expect(text).toContain('2\t2');
    expect(text).toContain('3\t3');
    expect(text).not.toContain('4\t4');
  });

  // offset 越界 → error（防 textResult('') 撞 LLM 400）
  it('offset 越界 → isError + 文案含实际行数 + invalid_input', async () => {
    const p = join(tmpRoot, 'o.txt');
    writeFileSync(p, 'a\nb\nc\n'); // 3 内容行（尾换行不算）
    const res = await fileReadTool.run({ filePath: p, offset: 10 }, makeCtx());
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/\binvalid_input\b/);
    expect(text).toMatch(/offset 10/);
    expect(text).toMatch(/3 lines/); // 报实际内容行数（不是 split.length=4）
  });

  it('offset 越界（无尾换行文件）→ 报准确行数', async () => {
    const p = join(tmpRoot, 'no-trailing.txt');
    writeFileSync(p, 'x\ny'); // 2 行无尾换行
    const res = await fileReadTool.run({ filePath: p, offset: 5 }, makeCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/2 lines/);
  });

  it('offset 越界不破坏正常末行 + 不写入 readSet', async () => {
    const p = join(tmpRoot, 'last.txt');
    writeFileSync(p, 'a\nb\n'); // 2 内容行（lines=['a','b',''], length=3）
    const ctx = makeCtx();
    // offset=4 越界（startIdx=3>=lines.length=3 → slice 返 []）→ error，不写 readSet
    const res = await fileReadTool.run({ filePath: p, offset: 4 }, ctx);
    expect(res.isError).toBe(true);
    expect(ctx.readSet?.has(p)).toBe(false);
    // offset=2 正常末行 → 成功，写 readSet
    const ok = await fileReadTool.run({ filePath: p, offset: 2 }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(ctx.readSet?.has(p)).toBe(true);
  });

  it('read 后写入 readSet（供 write/edit 校验）', async () => {
    const ctx = makeCtx();
    const p = join(tmpRoot, 'r.txt');
    writeFileSync(p, 'x');
    await fileReadTool.run({ filePath: p }, ctx);
    expect(ctx.readSet?.has(p)).toBe(true);
  });
});

// ============================================================
// file-write
// ============================================================
describe('file-write', () => {
  it('新建文件无 read 约束 → 成功', async () => {
    const p = join(tmpRoot, 'new.txt');
    const res = await fileWriteTool.run({ filePath: p, content: 'hello' }, makeCtx());
    expect(res.isError).toBe(false);
  });

  it('覆盖已存在文件未 read → isError（先 read 后写硬约束）', async () => {
    const p = join(tmpRoot, 'exist.txt');
    writeFileSync(p, 'old');
    const res = await fileWriteTool.run({ filePath: p, content: 'new' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not_read/i);
  });

  it('read 后覆盖 → 成功', async () => {
    const ctx = makeCtx();
    const p = join(tmpRoot, 'rw.txt');
    writeFileSync(p, 'old');
    await fileReadTool.run({ filePath: p }, ctx);
    const res = await fileWriteTool.run({ filePath: p, content: 'new content' }, ctx);
    expect(res.isError).toBe(false);
  });

  it('相对路径 → isError', async () => {
    const res = await fileWriteTool.run({ filePath: 'rel/x.txt', content: 'x' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/path_not_absolute/i);
  });
});

// ============================================================
// file-edit
// ============================================================
describe('file-edit', () => {
  it('精确替换（唯一匹配）', async () => {
    const ctx = makeCtx();
    const p = join(tmpRoot, 'e.txt');
    writeFileSync(p, 'foo\nbar\nbaz');
    await fileReadTool.run({ filePath: p }, ctx);
    const res = await fileEditTool.run(
      { filePath: p, oldString: 'bar', newString: 'BAR' },
      ctx,
    );
    expect(res.isError).toBe(false);
    // 再 read 确认替换生效
    const r2 = await fileReadTool.run({ filePath: p }, makeCtx());
    expect(textOf(r2)).toContain('BAR');
    expect(textOf(r2)).not.toMatch(/\bbar\b/);
  });

  it('oldString 多处匹配且 replaceAll=false → isError（唯一性校验）', async () => {
    const ctx = makeCtx();
    const p = join(tmpRoot, 'multi.txt');
    writeFileSync(p, 'dup\ndup\ndup');
    await fileReadTool.run({ filePath: p }, ctx);
    const res = await fileEditTool.run(
      { filePath: p, oldString: 'dup', newString: 'x' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/multiple_matches/i);
  });

  it('replaceAll=true 替换所有', async () => {
    const ctx = makeCtx();
    const p = join(tmpRoot, 'all.txt');
    writeFileSync(p, 'dup\ndup\n');
    await fileReadTool.run({ filePath: p }, ctx);
    const res = await fileEditTool.run(
      { filePath: p, oldString: 'dup', newString: 'x', replaceAll: true },
      ctx,
    );
    expect(res.isError).toBe(false);
    // 文件 'dup\ndup\n' 含 2 个 dup（末尾换行不产生第三个）
    expect(textOf(res)).toMatch(/replaced 2/);
  });

  it('oldString 未找到 → isError', async () => {
    const ctx = makeCtx();
    const p = join(tmpRoot, 'nf.txt');
    writeFileSync(p, 'abc');
    await fileReadTool.run({ filePath: p }, ctx);
    const res = await fileEditTool.run(
      { filePath: p, oldString: 'zzz', newString: 'y' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/string_not_found/i);
  });

  it('未 read 直接 edit → isError', async () => {
    const ctx = makeCtx();
    const p = join(tmpRoot, 'nr.txt');
    writeFileSync(p, 'abc');
    const res = await fileEditTool.run(
      { filePath: p, oldString: 'a', newString: 'b' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not_read/i);
  });
});

// ============================================================
// file-glob
// ============================================================
describe('file-glob', () => {
  beforeEach(() => {
    writeFileSync(join(tmpRoot, 'a.ts'), 'x');
    mkdirSync(join(tmpRoot, 'sub'));
    writeFileSync(join(tmpRoot, 'sub', 'b.ts'), 'x');
    writeFileSync(join(tmpRoot, 'c.md'), 'x');
  });

  it('pattern **/*.ts 匹配所有 .ts（含子目录）', async () => {
    const res = await fileGlobTool.run({ pattern: '**/*.ts', path: tmpRoot }, makeCtx());
    expect(res.isError).toBe(false);
    const text = textOf(res);
    expect(text).toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).not.toContain('c.md');
  });

  it('相对路径 path → isError', async () => {
    const res = await fileGlobTool.run({ pattern: '**/*.ts', path: 'rel/' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/path_not_absolute/i);
  });

  it('无匹配 → 非错误（空提示）', async () => {
    const res = await fileGlobTool.run({ pattern: '**/*.nope', path: tmpRoot }, makeCtx());
    expect(res.isError).toBe(false);
    expect(textOf(res)).toMatch(/no matches/i);
  });
});

// ============================================================
// file-grep
// ============================================================
describe('file-grep', () => {
  beforeEach(() => {
    writeFileSync(join(tmpRoot, 'g1.ts'), 'export const HELLO = 1;\nconst world = 2;');
    writeFileSync(join(tmpRoot, 'g2.md'), '# HELLO world\n');
  });

  it('正则匹配（files_with_matches 默认模式）', async () => {
    const res = await fileGrepTool.run({ pattern: 'HELLO', path: tmpRoot }, makeCtx());
    expect(res.isError).toBe(false);
    const text = textOf(res);
    expect(text).toContain('g1.ts');
    expect(text).toContain('g2.md');
  });

  it('ignoreCase 生效', async () => {
    const res = await fileGrepTool.run(
      { pattern: 'hello', path: tmpRoot, ignoreCase: true },
      makeCtx(),
    );
    expect(res.isError).toBe(false);
    const text = textOf(res);
    expect(text).toContain('g1.ts');
  });

  it('content 模式 + lineNumber', async () => {
    const res = await fileGrepTool.run(
      { pattern: 'world', path: tmpRoot, outputMode: 'content', lineNumber: true },
      makeCtx(),
    );
    expect(res.isError).toBe(false);
    const text = textOf(res);
    expect(text).toMatch(/g1\.ts:2:.*world/);
  });

  it('非法正则 → isError', async () => {
    const res = await fileGrepTool.run({ pattern: '(unclosed', path: tmpRoot }, makeCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/invalid/i);
  });

  it('glob 过滤文件名', async () => {
    const res = await fileGrepTool.run(
      { pattern: 'HELLO', path: tmpRoot, glob: '*.ts' },
      makeCtx(),
    );
    expect(res.isError).toBe(false);
    const text = textOf(res);
    expect(text).toContain('g1.ts');
    expect(text).not.toContain('g2.md');
  });
});

// ============================================================
// bash
// ============================================================
describe('bash', () => {
  it('正常命令执行成功（cwd = workdir 外层，无 workspace 嵌套）', async () => {
    const res = await bashTool.run(
      { command: 'echo hello', description: 'test echo' },
      makeCtx(),
    );
    expect(res.isError).toBe(false);
    expect(textOf(res)).toContain('hello');
  });

  it('cwd 直接落 workdir 外层（#1：bash 写文件不套 workspace/ 子目录）', async () => {
    // 用 pwd 验证 cwd = workdir（外层），而非 workdir/workspace
    const res = await bashTool.run(
      { command: 'pwd', description: 'print working dir' },
      makeCtx(),
    );
    expect(res.isError).toBe(false);
    const text = textOf(res).trim();
    // cwd 应 = tmpRoot（workdir），而非 tmpRoot/workspace
    // realpathSync 解析 macOS /var → /private/var 符号链接，与 shell pwd 真实路径对齐
    expect(text).toBe(realpathSync(tmpRoot));
    expect(text).not.toMatch(/workspace$/);
    // 落盘验证：bash 在 cwd 创建的文件直接出现在 workdir 外层
    const writeRes = await bashTool.run(
      { command: 'echo data > marker.txt', description: 'create marker file' },
      makeCtx(),
    );
    expect(writeRes.isError).toBe(false);
    // 文件应直接在 tmpRoot 下（外层），不在 tmpRoot/workspace 下
    expect(existsSync(join(tmpRoot, 'marker.txt'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'workspace', 'marker.txt'))).toBe(false);
  });

  it('timeout 触发 → isError（超时 reject）', async () => {
    const res = await bashTool.run(
      { command: 'sleep 5', description: 'sleep long', timeout: 500 },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/timeout/i);
  }, 10000);

  it('退出码非 0 → isError', async () => {
    const res = await bashTool.run(
      { command: 'exit 3', description: 'fail exit' },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/non_zero_exit/i);
  });

  it('输出 >64KB 被截断含 [truncated] 标记', async () => {
    // 输出 100000 字节（>64KB）
    const res = await bashTool.run(
      { command: 'yes x | head -c 100000', description: 'large output' },
      makeCtx(),
    );
    expect(res.isError).toBe(false);
    const text = textOf(res);
    expect(text).toContain('[truncated]');
    // 截断后总长不超过 64KB + 标记
    expect(text.length).toBeLessThan(64 * 1024 + 100);
  });

  it('交互式 flag -i → reject isError', async () => {
    const res = await bashTool.run(
      { command: 'git rebase -i HEAD~1', description: 'interactive rebase' },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/interactive_unsupported|not supported/i);
  });

  it('缺 description → isError', async () => {
    const res = await bashTool.run({ command: 'echo x' } as ToolInput, makeCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/description/i);
  });
});

// ============================================================
// engine（串行 + 顺序绑定）
// ============================================================
describe('ToolExecutionEngine', () => {
  it('串行执行：results[i] 对应 toolCalls[i]（toolCallId 顺序绑定）', async () => {
    const p1 = join(tmpRoot, 's1.txt');
    const p2 = join(tmpRoot, 's2.txt');
    writeFileSync(p1, 'content1');
    writeFileSync(p2, 'content2');

    const engine = new ToolExecutionEngine();
    const config = { tools: defaultTools(tmpRoot), workdir: tmpRoot };
    const calls: ToolCallBlock[] = [
      { type: 'tool_call', id: 'call-A', name: 'read', arguments: { filePath: p1 } },
      { type: 'tool_call', id: 'call-B', name: 'read', arguments: { filePath: p2 } },
    ];
    const { results, pending } = await engine.execute(config, calls); expect(pending).toEqual([]);

    expect(results).toHaveLength(2);
    expect(results[0]!.toolCallId).toBe('call-A');
    expect(results[1]!.toolCallId).toBe('call-B');
    expect(textOf(results[0])).toContain('content1');
    expect(textOf(results[1])).toContain('content2');
  });

  it('单个工具 isError 不中断后续（失败不中断）', async () => {
    const engine = new ToolExecutionEngine();
    const config = { tools: defaultTools(tmpRoot), workdir: tmpRoot };
    const calls: ToolCallBlock[] = [
      { type: 'tool_call', id: 'c1', name: 'read', arguments: { filePath: join(tmpRoot, 'noexist') } },
      { type: 'tool_call', id: 'c2', name: 'bash', arguments: { command: 'echo ok', description: 'd' } },
    ];
    const { results, pending } = await engine.execute(config, calls); expect(pending).toEqual([]);
    expect(results).toHaveLength(2);
    expect(results[0]!.isError).toBe(true);
    expect(results[1]!.isError).toBe(false);
  });

  it('未知工具 → isError + [tool_not_allowed] 统一拒绝 code（v0.0.48）', async () => {
    // [v0.0.48] 未注册路径合并到 rejectToolCall，文案前缀 `[tool_not_allowed]` reason=`not registered`
    //   参考: specs/tech/agent/tools/[P0]tool_execution_engine.md §3.1（统一拒绝错误 code）
    const engine = new ToolExecutionEngine();
    const config = { tools: defaultTools(tmpRoot), workdir: tmpRoot };
    const calls: ToolCallBlock[] = [
      { type: 'tool_call', id: 'c1', name: 'nonexistent_tool', arguments: {} },
    ];
    const { results, pending } = await engine.execute(config, calls); expect(pending).toEqual([]);
    expect(results[0]!.isError).toBe(true);
    expect(textOf(results[0])).toMatch(/\[tool_not_allowed\]/i);
    expect(textOf(results[0])).toMatch(/not registered/i);
  });

  it('参数缺失必填 → isError', async () => {
    const engine = new ToolExecutionEngine();
    const config = { tools: defaultTools(tmpRoot), workdir: tmpRoot };
    const calls: ToolCallBlock[] = [
      { type: 'tool_call', id: 'c1', name: 'read', arguments: {} },
    ];
    const { results, pending } = await engine.execute(config, calls); expect(pending).toEqual([]);
    expect(results[0]!.isError).toBe(true);
    expect(textOf(results[0])).toMatch(/missing required|invalid_input/i);
  });

  it('read→write 跨工具 readSet 共享（先 read 后 write 链）', async () => {
    const engine = new ToolExecutionEngine();
    const config = { tools: defaultTools(tmpRoot), workdir: tmpRoot };
    const p = join(tmpRoot, 'chain.txt');
    writeFileSync(p, 'old');
    const calls: ToolCallBlock[] = [
      { type: 'tool_call', id: 'c1', name: 'read', arguments: { filePath: p } },
      { type: 'tool_call', id: 'c2', name: 'write', arguments: { filePath: p, content: 'new' } },
    ];
    const { results, pending } = await engine.execute(config, calls); expect(pending).toEqual([]);
    // 第一个 read 成功；第二个 write 因 readSet 含 p 而成功（不报 not_read）
    expect(results[0]!.isError).toBe(false);
    expect(results[1]!.isError).toBe(false);
  });
});
