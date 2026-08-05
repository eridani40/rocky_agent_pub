/**
 * file-op 工具测试共享 helper（makeCtx / textOf / expectNoTmpResidue）。
 * 抽出以避免 file-write.test.ts 与 file-edit.test.ts 重复，并与 tools.test.ts 对齐。
 */
import { readdirSync } from 'node:fs';
import { expect } from 'vitest';
import type { ToolCtx, ToolRunResult } from '../types';

/** 构造一个共享 readSet 的 ctx（workdir = tmpRoot） */
export function makeCtx(tmpRoot: string): ToolCtx {
  return {
    config: { tools: [], workdir: tmpRoot },
    workdir: tmpRoot,
    readSet: new Set<string>(),
  };
}

/** 从 ToolRunResult 取首个 TextBlock 的 text（断言非空，测试专用） */
export function textOf(res: ToolRunResult): string {
  const first = res.content[0] as { text: string } | undefined;
  if (!first || typeof first.text !== 'string') {
    throw new Error(`textOf: content[0].text missing in ${JSON.stringify(res)}`);
  }
  return first.text;
}

/** 断言目录中无 .tmp 残留（atomicWriteSync 应 rename 掉 tmp） */
export function expectNoTmpResidue(dir: string): void {
  const files = readdirSync(dir);
  const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
  expect(tmpFiles, `unexpected .tmp residue: ${tmpFiles.join(',')}`).toEqual([]);
}
