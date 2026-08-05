/**
 * readSessionType 'rocky' 归一化单测（BUG-004：playground identity 缺失回归）
 * 参考: states/v0.0.153/bugs/BUG-004-playground缺identity正文-readSessionType回归-[open].md
 *
 * 覆盖：kind.role='rocky' → undefined（standalone）；无 kind → undefined；isSubagent 优先于 role 归一化；
 *      leader/mate/squad 正向匹配不变。
 */
import { describe, it, expect } from 'vitest';
import { readSessionType } from '../squad_reminder_shared';

describe('readSessionType 归一化（BUG-004）', () => {
  it("kind.role='rocky' → undefined（standalone 语义，对齐 readSessionKind 注释）", () => {
    expect(readSessionType({ config: { kind: { role: 'rocky' } } })).toBeUndefined();
  });

  it('无 kind → undefined（原本即如此，非回归点）', () => {
    expect(readSessionType({ config: {} })).toBeUndefined();
  });

  it('isSubagent=true → subagent（不受 role 归一化影响，subagent 判定优先）', () => {
    expect(readSessionType({ config: { kind: { role: 'rocky', isSubagent: true } } })).toBe('subagent');
  });

  it.each(['leader', 'mate', 'squad'])("kind.role=%s → 原样返回（不变）", (role) => {
    expect(readSessionType({ config: { kind: { role } } })).toBe(role);
  });
});
