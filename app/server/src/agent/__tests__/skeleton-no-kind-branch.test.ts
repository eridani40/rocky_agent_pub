/**
 * 骨架无 if runKind 字面分支结构断言（v0.0.49 UT-S；v0.0.204 forked 退役后现代化）
 * 参考: specs/tech/version_logs/v0.0.49/design.md §3（4 维差异表 — 全参数化）
 *       specs/tech/version_logs/v0.0.49/design_refactor_manifest.md §3（不变量守护）
 *
 * 核心不变量（design §3 + manifest §3）：
 *   runReActLoop 骨架对 runKind 零感知——main/summary/consolidate 差异全收敛到 RunSpec 字段
 *   （scopeId / drainMode / wireStore / backgroundPath / lifecycle hook），骨架代码里
 *   不允许出现 `if (runKind === 'main'|'summary'|'consolidate')` 这种字面分支
 *   （spec 字段名如 drainMode、backgroundPath 不算分支）。
 *
 * 本测试读源文件原文，用正则匹配禁用模式，**模式出现即 fail**。比 reviewer 手 grep 更稳定，
 * 每次 CI 自动执行；防止后续 PR 误回滚到 if 分支风格（spec 与代码对齐的护栏）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENT_DIR = join(__dirname, '..');

/** 读 agent 目录下源文件原文（同步），返回 UTF-8 字符串 */
function readSrc(rel: string): string {
  return readFileSync(join(AGENT_DIR, rel), 'utf-8');
}

describe('[UT-S] 骨架无 if runKind 字面分支（design §3 + manifest §3）', () => {
  // 骨架核心文件 + stage helpers（design §2 骨架伪代码 1:1 实施）：均不允许字面 if runKind
  // v0.0.204 现代化：禁用模式从 main/forked 扩到 main/summary/consolidate（runKind 闭合枚举）
  const skeletonFiles = [
    'run-react-loop.ts',
    'loop-stage-llm.ts',
    'loop-stage-context.ts',
    'agent-loop-stage-tool.ts',
    'agent-loop-stage-pre.ts',
  ];

  it.each(skeletonFiles)('%s 不含 if (runKind === "main"|"summary"|"consolidate") 字面分支', (rel) => {
    const src = readSrc(rel);
    // 匹配 `if (runKind === 'main')` / `if (spec.runKind === 'summary')` 等变体；
    // 不匹配 spec.drainMode（字段名带 Mode 但不是 runKind 判定）。
    // v0.0.204：runKind 三值 main/summary/consolidate 全覆盖（forked 退役）。
    const forbidden = /if\s*\([^)]*===\s*['"](main|summary|consolidate)['"][^)]*\)|if\s*\([^)]*['"](main|summary|consolidate)['"]\s*===/g;
    const matches = src.match(forbidden);
    expect(matches, `${rel} 不应含 if runKind 字面分支，发现: ${matches?.join(', ')}`).toBeNull();
  });

  it.each(skeletonFiles)('%s 不含 if (drainMode/scopeId 比对 mode 字面）隐式 mode 分支', (rel) => {
    const src = readSrc(rel);
    // drainMode 是三态枚举（eager/none/lazy），不应对 main/forked；scopeId 应靠 router 注入不硬比
    // 允许：drainMode === 'eager' / 'none' / 'lazy'（design §3 三态）
    // 禁止：scopeId === 'default'（main 的 scopeId 值，等价 "if main"）/ scopeId === 'forked' /
    //       drainMode === 'main'/'forked' 这类把 mode 字面塞进字段的写法
    // 注：scopeId 的真实值是 'default'(main) / 'forked'，'main' 本身不是 scopeId 值，
    //     故 scopeId === 'main' 是 dead check；真正要拦的是 'default'/'forked' 字面比对
    const forbidden = /scopeId\s*===\s*['"](default|main|forked)['"]|drainMode\s*===\s*['"](main|forked)['"]/g;
    const matches = src.match(forbidden);
    expect(matches, `${rel} 不应硬比 scopeId/drainMode 与 mode 字面`).toBeNull();
  });

  it('context-engine.ts 不含 D15 已删的 `if (scopeId !== FORKED_SCOPE_ID) store.appendMessages` 硬尾', () => {
    const src = readSrc('context-engine.ts');
    // 禁用模式：if (scopeId !== FORKED_SCOPE_ID) { ... store.appendMessages ... }
    //   或反向：if (scopeId === FORKED_SCOPE_ID) skip store —— 关键是"代码 if 决定 sink"而非 chain 配置
    //   [v0.0.66 §2.3] 零 isForked：context-engine.ts 不再含任何 isForked 三元（forked/default 统一主干）。
    //   断言：不应有 `if (scopeId !== FORKED_SCOPE_ID)` 这种 **完整 if 语句**，也不应有 isForked 三元。
    const forbiddenIf = /if\s*\(\s*scopeId\s*!==\s*FORKED_SCOPE_ID\s*\)/g;
    const matches = src.match(forbiddenIf);
    expect(matches, 'context-engine.ts 不应含 D15 已删的 if scopeId!==FORKED 硬尾').toBeNull();

    // [v0.0.66 §2.3] 二次护栏：context-engine.ts 不应含任何 isForked 变量或三元（统一逻辑，零 isForked）
    const isForkedVar = /\bisForked\b/g;
    const isForkedMatches = src.match(isForkedVar);
    expect(isForkedMatches, 'context-engine.ts 不应含 isForked 变量/三元（v0.0.66 §2.3 零 isForked）').toBeNull();

    // 三次护栏：store.appendMessages 不应被 context-engine.ts 直接调用（应经 store_sink impl 写）
    //   D15 后 sink EP 化：context-engine.ingest 只跑 chain，appendMessages 由 store_sink.handle 调
    const directAppend = /\.appendMessages\s*\(/g;
    const appendMatches = src.match(directAppend);
    expect(appendMatches, 'context-engine.ts 不应直接调 store.appendMessages（已 EP 化到 store_sink）').toBeNull();
  });
});
