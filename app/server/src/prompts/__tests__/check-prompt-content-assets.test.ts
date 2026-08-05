/**
 * checkPromptContentAssets() + readContent(relPath) 可选参数单测（白盒 vitest）
 * 参考: specs/tech/version_logs/v0.0.153/change_plan.md T2
 *       specs/tech/agent/context/[P0]prompt_content_files.md §4
 *
 * 覆盖：
 * - checkPromptContentAssets：目录缺失 → ok=false + missing=全表；目录存在但部分缺失 →
 *   逐项过滤正确；全部齐全 → ok=true。用临时目录注入（contentDir 可选参数），不碰真实
 *   src/prompts/content（隔离，避免与其他并发测试文件互踩真实 content 目录）。
 * - readContent(relPath)：显式传参读取「非主 contentFile」的其余 content 文件；
 *   无参调用行为零变化（既有 prompt-handler.test.ts 全绿即证，本文件补一条直接断言）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkPromptContentAssets,
  CRITICAL_CONTENT_FILES,
  PromptHandler,
  __clearPromptCacheForTests,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';

describe('checkPromptContentAssets', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-assets-check-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('目录缺失 → ok=false, contentDirExists=false, missing=全表', () => {
    const nonexistentDir = path.join(tmpDir, 'does-not-exist');
    const result = checkPromptContentAssets(nonexistentDir);
    expect(result.ok).toBe(false);
    expect(result.contentDirExists).toBe(false);
    expect(result.missing).toEqual([...CRITICAL_CONTENT_FILES]);
  });

  it('目录存在但全部关键文件缺失 → ok=false, contentDirExists=true, missing=全表', () => {
    // 目录本身存在（mkdtempSync 已建），但不写入任何 CRITICAL_CONTENT_FILES 项
    const result = checkPromptContentAssets(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.contentDirExists).toBe(true);
    expect(result.missing).toEqual([...CRITICAL_CONTENT_FILES]);
  });

  it('部分文件存在 → missing 只含缺失项（逐项过滤正确）', () => {
    // 只建 identity.md + squad/leader.md（含子目录场景）
    fs.writeFileSync(path.join(tmpDir, 'identity.md'), 'identity content');
    fs.mkdirSync(path.join(tmpDir, 'squad'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'squad', 'leader.md'), 'leader content');

    const result = checkPromptContentAssets(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.contentDirExists).toBe(true);
    expect(result.missing).not.toContain('identity.md');
    expect(result.missing).not.toContain('squad/leader.md');
    expect(result.missing).toContain('rules.md');
    expect(result.missing).toContain('auto_naming.md');
    expect(result.missing.length).toBe(CRITICAL_CONTENT_FILES.length - 2);
  });

  it('全部关键文件齐全 → ok=true, missing=空数组', () => {
    for (const rel of CRITICAL_CONTENT_FILES) {
      const full = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, `content of ${rel}`);
    }
    const result = checkPromptContentAssets(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.contentDirExists).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('纯查询：不抛异常、无副作用（多次调用结果一致，不改变文件系统）', () => {
    const nonexistentDir = path.join(tmpDir, 'nope');
    expect(() => checkPromptContentAssets(nonexistentDir)).not.toThrow();
    const r1 = checkPromptContentAssets(nonexistentDir);
    const r2 = checkPromptContentAssets(nonexistentDir);
    expect(r1).toEqual(r2);
    // 未曾创建该目录（查询不产生副作用）
    expect(fs.existsSync(nonexistentDir)).toBe(false);
  });

  it('缺省参数（无 contentDir）解析到真实 CONTENT_DIR（不抛异常，返回合法形状）', () => {
    // 不注入参数，走真实 src/prompts/content——此时 T3（Task 2）未落地，
    // 部分 CRITICAL_CONTENT_FILES（如 auto_naming.md）预期 missing，属预期过渡态。
    const result = checkPromptContentAssets();
    expect(typeof result.ok).toBe('boolean');
    expect(typeof result.contentDirExists).toBe('boolean');
    expect(Array.isArray(result.missing)).toBe(true);
  });
});

describe('readContent(relPath) 可选参数', () => {
  beforeEach(() => __clearPromptCacheForTests());

  /** 测试用子类：暴露 readContent 给测试直接调用（相当于子类内部读多段文件） */
  class MultiSegmentHandler extends PromptHandler {
    protected readonly contentFile = 'identity.md';
    build(_ctx: PromptHandlerContext): PromptHandlerResult {
      return { content: this.readContent() };
    }
    /** 测试专用：读取指定相对路径（模拟 side-run-reminder 多段读取场景） */
    readOther(relPath: string): string {
      return this.readContent(relPath);
    }
  }

  it('无参调用 → 读 this.contentFile（既有行为零变化）', () => {
    const h = new MultiSegmentHandler();
    const c = h.build({}).content;
    expect(c.length).toBeGreaterThan(0);
    expect(c).toContain('Rocky');
  });

  it('显式传 relPath → 读取「非主 contentFile」的其余 content 文件', () => {
    const h = new MultiSegmentHandler();
    // 读取同一实例的另一个 content 文件（非 this.contentFile=identity.md）
    const other = h.readOther('rules.md');
    expect(other.length).toBeGreaterThan(0);
    expect(other).toContain('# Operating Rules');
    // 与主 contentFile 内容不同，证明确实读的是另一文件
    const main = h.build({}).content;
    expect(other).not.toBe(main);
  });

  it('relPath 传 undefined 显式值 → 等价于不传（回退 this.contentFile）', () => {
    const h = new MultiSegmentHandler();
    const explicit = h.readOther(undefined as unknown as string);
    const implicit = h.build({}).content;
    expect(explicit).toBe(implicit);
  });
});
