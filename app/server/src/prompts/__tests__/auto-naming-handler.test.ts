/**
 * AutoNamingHandler 单测（v0.0.153 T3-a：NAMING_PROMPT 迁 content/auto_naming.md）
 * 参考: specs/tech/version_logs/v0.0.153/change_plan.md T3-a
 *
 * 逐字一致性验证法：ORIGINAL_NAMING_PROMPT 为 auto-naming-service.ts 删除前的常量原文快照
 * （手工核对逐字复制），断言 handler.build() 产出 === ORIGINAL_NAMING_PROMPT + query，
 * 锁死「md 文件正文 + 占位符替换」与旧内联模板字面量完全等价（含无尾随换行的拼接语义）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AutoNamingHandler } from '../handlers/auto-naming-handler';
import { __clearPromptCacheForTests } from '../prompt-handler';

/** 原 auto-naming-service.ts 内 NAMING_PROMPT 常量的原文快照（迁移前逐字复制） */
const ORIGINAL_NAMING_PROMPT = `为以下对话生成一个简短的会话标题（4-12 个字，中文优先），要求：
- 直接给出标题文本，不要加引号、不要加「标题：」之类前缀
- 不要超过一行
- 概括用户问题的核心主题
- 用名词短语或短句，不用完整句子

用户问题：`;

describe('AutoNamingHandler（v0.0.153 T3-a）', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('build({vars:{query}}) 产出 === 原 NAMING_PROMPT + query（逐字拼接等价，无多余换行）', () => {
    const content = new AutoNamingHandler().build({ vars: { query: '今天天气怎么样' } }).content;
    expect(content).toBe(ORIGINAL_NAMING_PROMPT + '今天天气怎么样');
  });

  it('未传 query → {{query}} 替空串，产出 === 原 NAMING_PROMPT', () => {
    const content = new AutoNamingHandler().build({}).content;
    expect(content).toBe(ORIGINAL_NAMING_PROMPT);
  });

  it('产出无尾随换行（与原内联模板字面量拼接语义一致）', () => {
    const content = new AutoNamingHandler().build({ vars: { query: 'x' } }).content;
    expect(content.endsWith('\n')).toBe(false);
    expect(content.endsWith('x')).toBe(true);
  });
});
