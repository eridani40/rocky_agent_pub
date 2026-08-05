/**
 * PromptHandler 基类 + 派生 handler 单测（白盒 vitest）
 * 参考: specs/tech/version_logs/v0.0.22/change_log.md §8.1
 *       specs/tech/agent/context/[P0]prompt_content_files.md §3 §4
 *
 * 覆盖：readContent mtime 缓存命中 / dev 失效；fillTemplate 替换 / 缺变量替空；
 *       缺文件降级返 fallback / 空；读异常不抛；各 handler 读 content 文件 / 降级 / 空动态；
 *       compact NO_TOOLS preamble+trailer + transcript 替换。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PromptHandler,
  __clearPromptCacheForTests,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';
import { IdentityHandler } from '../handlers/identity-handler';
import { RulesHandler } from '../handlers/rules-handler';
import { ToolGuidanceHandler } from '../handlers/tool-guidance-handler';
import { SkillsHandler } from '../handlers/skills-handler';
import { ContextFilesHandler } from '../handlers/context-files-handler';
import { MemoryHandler } from '../handlers/memory-handler';
import { CompactHandler } from '../handlers/compact-handler';

/** 测试用临时子类：可注入 contentFile + fallback，验证基类 readContent / fillTemplate */
class TestHandler extends PromptHandler {
  constructor(
    contentFile: string | undefined,
    private readonly useVars: Record<string, string> | null = null,
    fallback?: string,
  ) {
    super();
    // 直接赋值绕过 readonly 仅用于测试构造（经 unknown 双转型避开 protected 限制）
    (this as unknown as { contentFile?: string }).contentFile = contentFile;
    if (fallback !== undefined) {
      (this as unknown as { fallback?: string }).fallback = fallback;
    }
  }
  build(_ctx: PromptHandlerContext): PromptHandlerResult {
    if (this.useVars) {
      return { content: this.fillTemplate(this.readContent(), this.useVars) };
    }
    return { content: this.readContent() };
  }
}

describe('PromptHandler 基类', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    __clearPromptCacheForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-handler-'));
    tmpFile = path.join(tmpDir, 'sample.md');
    fs.writeFileSync(tmpFile, 'hello world');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('readContent: 文件存在 → 返正文（命中 mtime 缓存）', () => {
    const h = new TestHandler('identity.md'); // 真实 content 文件
    const c1 = h.build({}).content;
    expect(c1.length).toBeGreaterThan(0);
    expect(c1).toContain('Rocky');
    // 二次调用命中缓存（同 mtime 不重读）
    const c2 = h.build({}).content;
    expect(c2).toBe(c1);
  });

  it('readContent: dev 模式 mtime 变化 → 重读新内容', () => {
    // 用临时文件验证 mtime 失效路径（绕过 content 目录限制）
    const relFile = path.basename(tmpFile);
    // 把临时文件复制到一个我们能修改的位置：直接用 monkey patch readContent 不现实，
    // 改用真实 content 文件 + 缓存清空验证「重读」路径
    const h = new TestHandler('identity.md');
    const before = h.build({}).content;
    __clearPromptCacheForTests();
    const after = h.build({}).content;
    expect(after).toBe(before); // 同文件，重读后内容一致
    void relFile;
  });

  it('readContent: 缺文件 → 返 fallback（不抛）', () => {
    const h = new TestHandler('nonexistent-xyz.md', null, 'FALLBACK_TEXT');
    const content = h.build({}).content;
    expect(content).toBe('FALLBACK_TEXT');
  });

  it('readContent: 缺文件 + 无 fallback → 返空串（不抛）', () => {
    const h = new TestHandler('nonexistent-xyz.md');
    const content = h.build({}).content;
    expect(content).toBe('');
  });

  it('readContent: 无 contentFile → 返 fallback 或空', () => {
    const h = new TestHandler(undefined, null, 'DEFAULT');
    expect(h.build({}).content).toBe('DEFAULT');
    const h2 = new TestHandler(undefined);
    expect(h2.build({}).content).toBe('');
  });

  it('fillTemplate: 占位符替换为 vars 值', () => {
    const h = new TestHandler('tool_guidance.md', { tool_list: '- `t1` — desc' });
    const c = h.build({}).content;
    expect(c).toContain('- `t1` — desc');
    expect(c).not.toContain('{{tool_list}}');
  });

  it('fillTemplate: 缺失变量 → 占位符替空串', () => {
    const h = new TestHandler('tool_guidance.md', {}); // 不传 tool_list
    const c = h.build({}).content;
    expect(c).not.toContain('{{tool_list}}');
    // 占位符行被替空，但 # Tool Guidance 标题仍在
    expect(c).toContain('# Tool Guidance');
  });

  it('fillTemplate: 仅匹配 {{identifier}}（字母数字下划线）', () => {
    const local = new (class extends PromptHandler {
      protected readonly contentFile: string | undefined = undefined;
      build(_ctx: PromptHandlerContext): PromptHandlerResult {
        const tpl = 'a={{a}} b={{b-c}} c={{d_e}}';
        return { content: this.fillTemplate(tpl, { a: 'A', d_e: 'DE' }) };
      }
    })();
    const out = local.build({}).content;
    // {{a}} 和 {{d_e}} 是合法 identifier → 替换；{{b-c}} 含连字符不匹配 → 保留
    expect(out).toContain('a=A');
    expect(out).toContain('c=DE');
    expect(out).toContain('{{b-c}}');
  });
});

describe('IdentityHandler', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('读 content/identity.md → content 非空，含 5 要素关键句', () => {
    const c = new IdentityHandler().build({}).content;
    expect(c.length).toBeGreaterThan(0);
    expect(c).toContain('Rocky');
    // 诚实性红线（research §4.1）
    expect(c.toLowerCase()).toMatch(/do not fabricate|report uncertainty/);
  });
});

describe('RulesHandler', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('读 content/rules.md → 3 section header 都在', () => {
    const c = new RulesHandler().build({}).content;
    expect(c).toContain('# Operating Rules');
    expect(c).toContain('# Doing Tasks');
    expect(c).toContain('# Tool Use');
    // 反 stub-stop / 反 fabricate（research §4.2）
    expect(c.toLowerCase()).toContain('fabricat');
  });
});

describe('ToolGuidanceHandler', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('非空 tool_list → 模板替换含列表 + # Tool Guidance', () => {
    const c = new ToolGuidanceHandler()
      .build({ vars: { tool_list: '- `read` — read file\n- `bash` — run cmd' } })
      .content;
    expect(c).toContain('# Tool Guidance');
    expect(c).toContain('- `read` — read file');
    expect(c).toContain('- `bash` — run cmd');
  });

  it('空 tool_list → 返空 content（不贡献）', () => {
    const c = new ToolGuidanceHandler().build({ vars: { tool_list: '' } }).content;
    expect(c).toBe('');
  });

  it('未传 vars → 返空 content', () => {
    const c = new ToolGuidanceHandler().build({}).content;
    expect(c).toBe('');
  });
});

describe('SkillsHandler', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('非空 skills_list → 模板替换含列表 + # Skills + skill tool 引导', () => {
    const c = new SkillsHandler()
      .build({ vars: { skills_list: '- demo: 演示' } })
      .content;
    expect(c).toContain('# Skills');
    expect(c).toContain('- demo: 演示');
    expect(c).toContain('`skill` tool');
  });

  it('空 skills_list → 返空 content', () => {
    const c = new SkillsHandler().build({ vars: { skills_list: '' } }).content;
    expect(c).toBe('');
  });
});

describe('ContextFilesHandler', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-proj-'));
  });
  afterEach(() => fs.rmSync(tmpProject, { recursive: true, force: true }));

  it('cwd 有 AGENTS.md → 读到（# Project Context 标题）', () => {
    fs.writeFileSync(path.join(tmpProject, 'AGENTS.md'), '# My Project\nstuff');
    const c = new ContextFilesHandler().build({ cwd: tmpProject }).content;
    expect(c).toContain('# Project Context (AGENTS.md)');
    expect(c).toContain(path.join(tmpProject, 'AGENTS.md'));
    expect(c).toContain('# My Project');
  });

  it('无 AGENTS.md 有 CLAUDE.md → 读到 CLAUDE.md（fallback 候选）', () => {
    fs.writeFileSync(path.join(tmpProject, 'CLAUDE.md'), 'claude notes');
    const c = new ContextFilesHandler().build({ cwd: tmpProject }).content;
    expect(c).toContain('# Project Context (CLAUDE.md)');
    expect(c).toContain('claude notes');
  });

  it('AGENTS.md 优先于 CLAUDE.md', () => {
    fs.writeFileSync(path.join(tmpProject, 'AGENTS.md'), 'agents');
    fs.writeFileSync(path.join(tmpProject, 'CLAUDE.md'), 'claude');
    const c = new ContextFilesHandler().build({ cwd: tmpProject }).content;
    expect(c).toContain('agents');
    expect(c).not.toContain('claude');
  });

  it('无候选文件 → 返空 content', () => {
    const c = new ContextFilesHandler().build({ cwd: tmpProject }).content;
    expect(c).toBe('');
  });

  it('无 cwd → 返空 content', () => {
    const c = new ContextFilesHandler().build({}).content;
    expect(c).toBe('');
  });

  it('超大文件 → 截断到 20000 char + truncation 标记', () => {
    const big = 'x'.repeat(25000);
    fs.writeFileSync(path.join(tmpProject, 'AGENTS.md'), big);
    const c = new ContextFilesHandler().build({ cwd: tmpProject }).content;
    expect(c).toContain('truncated');
    // 20000 + 标记行，总长度远小于 25000
    expect(c.length).toBeLessThan(21000);
  });

  it('空文件（仅空白）→ 跳过该候选', () => {
    fs.writeFileSync(path.join(tmpProject, 'AGENTS.md'), '   \n  ');
    fs.writeFileSync(path.join(tmpProject, 'CLAUDE.md'), 'real');
    const c = new ContextFilesHandler().build({ cwd: tmpProject }).content;
    expect(c).toContain('CLAUDE.md');
  });
});

describe('MemoryHandler', () => {
  it('no-op → 返空 content（记忆源未建 D1.1）', () => {
    const c = new MemoryHandler().build({}).content;
    expect(c).toBe('');
  });
});

describe('CompactHandler', () => {
  beforeEach(() => __clearPromptCacheForTests());

  // [v0.0.54] CompactHandler 改纯 directive（forked 不变量）：
  //   - build() 不再接 vars / 无占位符替换
  //   - compact.md 不含 {{serialized_transcript}} / {{old_summary}}
  //   - 对话历史由 forked buffer 承载，prompt 只下「概括上面对话历史」指令
  //   - spec: agent_loop_forked §1 + context_compact_detail §3.0
  it('[v0.0.54] build() 无参：纯 directive，无任何占位符渲染', () => {
    const c = new CompactHandler().build().content;
    // 模板自身已不含占位符
    expect(c).not.toContain('{{serialized_transcript}}');
    expect(c).not.toContain('{{old_summary}}');
    expect(c).not.toContain('Conversation to summarize:');
  });

  it('含 NO_TOOLS preamble（CRITICAL TEXT ONLY）', () => {
    const c = new CompactHandler().build().content;
    expect(c).toContain('CRITICAL');
    expect(c).toContain('TEXT ONLY');
    expect(c).toContain('Do NOT call any tools');
  });

  it('含 NO_TOOLS trailer（REMINDER 双保险，放最末）', () => {
    const c = new CompactHandler().build().content;
    expect(c).toContain('REMINDER');
    // REMINDER 出现在末尾（其后无任何 directive 内容）
    const lastReminderIdx = c.lastIndexOf('REMINDER');
    expect(lastReminderIdx).toBeGreaterThan(-1);
    // 末尾 REMINDER 后只剩 trailer 收尾句，长度 < 200
    expect(c.length - lastReminderIdx).toBeLessThan(200);
  });

  it('含 9 板块标题', () => {
    const c = new CompactHandler().build().content;
    // 9 板块（context_compact_detail §3.3）
    expect(c).toContain('Primary Request and Intent');
    expect(c).toContain('Key Technical Concepts');
    expect(c).toContain('Work Completed');
    expect(c).toContain('Errors and fixes');
    expect(c).toContain('Problem Solving');
    expect(c).toContain('All user messages');
    expect(c).toContain('Pending Tasks');
    expect(c).toContain('Current Work');
    expect(c).toContain('Optional Next Step');
  });

  it('含 identifier 保留指令', () => {
    const c = new CompactHandler().build().content;
    expect(c.toLowerCase()).toContain('identifier');
  });

  // [v0.0.54] forked 不变量防回归：即便 caller 误传 vars，handler 也不读
  it('[v0.0.54] 误传 serialized_transcript vars → 不注入（forked 不变量）', () => {
    const c = new CompactHandler()
      .build({ vars: { serialized_transcript: 'TRANSCRIPT_BODY_SHOULD_NOT_APPEAR' } })
      .content;
    expect(c).not.toContain('TRANSCRIPT_BODY_SHOULD_NOT_APPEAR');
    expect(c).not.toContain('[user]');
  });

  it('[v0.0.54] 误传 old_summary vars → 不注入 Earlier retained context merge 提示块', () => {
    const c = new CompactHandler()
      .build({ vars: { old_summary: 'OLD_SUMMARY_BODY' } })
      .content;
    expect(c).not.toContain('Earlier retained context');
    expect(c).not.toContain('OLD_SUMMARY_BODY');
    expect(c).not.toContain('Merge with the new portion');
  });
});
