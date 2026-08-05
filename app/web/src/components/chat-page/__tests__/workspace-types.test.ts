// @vitest-environment jsdom
/**
 * workspace-types 工具函数单测 —— testid 编码 + parentOfPath
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §5（testid {path} 编码规则）
 */
import { describe, it, expect } from 'vitest';
import { encodePathForTestid, parentOfPath } from '../workspace-types';

describe('encodePathForTestid', () => {
  it('相对路径 / 替换为 -（防 testid 选择器歧义）', () => {
    expect(encodePathForTestid('src/auth/login.ts')).toBe('src-auth-login.ts');
    expect(encodePathForTestid('a.ts')).toBe('a.ts');
    expect(encodePathForTestid('src/deep/dir/x.ts')).toBe('src-deep-dir-x.ts');
  });

  it('空串保持空串', () => {
    expect(encodePathForTestid('')).toBe('');
  });
});

describe('parentOfPath', () => {
  it('顶层文件 → ""（parent=顶层）', () => {
    expect(parentOfPath('a.ts')).toBe('');
    expect(parentOfPath('README.md')).toBe('');
  });

  it('多层 → 取倒数第一层父目录', () => {
    expect(parentOfPath('src/login.ts')).toBe('src');
    expect(parentOfPath('src/auth/login.ts')).toBe('src/auth');
    expect(parentOfPath('src/deep/dir/x.ts')).toBe('src/deep/dir');
  });
});
