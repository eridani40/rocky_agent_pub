/**
 * squad 工具 inputSchema 一致性回归测试
 * 参考: states/v0.0.37.okf_mgmt/design/part-a-tool-schema.md §5（防回归 UT 设计）
 *
 * 抓的 bug：handler 实读的 flat 顶层字段（`input.title` 等）若未在 inputSchema.properties 声明，
 * LLM 据 schema 发参数时会漏字段 → 每个 write action 运行时崩。
 * 直接调 run()（带全参）的老 UT 永远绿（它绕过 schema 直接塞 input），只有「schema 声明 ⊇ handler 实读」
 * 的一致性测试能抓 schema 漏声明。
 *
 * 断言：每个工具「handler 实读的顶层字段」expected 列表 ⊆ definition.inputSchema.properties。
 * 字段增删时此测试卡住 → 强制同步 schema。
 *
 * 白名单（不要求顶层声明）：
 *   - `action`（已在 required，单独声明）
 *   - 嵌套子对象内部字段（如 `patch.goals`、`query.ref`）——
 *     handler 通过 `input.query.ref` 读，但只要求顶层 `query` 声明即可。
 */
import { describe, it, expect } from 'vitest';
import { teamTool } from '../team-tool';

/** 抽工具 inputSchema 顶层 properties 的 key 集合 */
function schemaProps(tool: { definition: { inputSchema: { properties?: Record<string, unknown> } } }): Set<string> {
  return new Set(Object.keys(tool.definition.inputSchema.properties ?? {}));
}

describe('squad 工具 inputSchema 一致性（handler 实读 ⊆ schema 声明）', () => {
  it('team 工具：handler 实读字段全部在 schema 声明', () => {
    // 扫描范围：team-tool.ts（只读 action list/query）+ team-write-actions.ts（4 写 action）。
    // 从两文件 handler 源码读出的真值（input.XXX 读取点）：
    // —— team-tool.ts ——
    //   list:  （无 input 字段，读 rtc.selfSquadId）
    //   query: query（对象，内含 ref —— ref 是嵌套字段，不要求顶层声明）
    // —— team-write-actions.ts ——
    //   hire:   mode / name / intro / skillConfig / deriveFrom / overrides（v0.0.250 inheritMemory 删）
    //   deploy: roleId
    //   bench:  roleId / reason
    //   edit:   roleId / patch
    const expected = [
      'query', 'patch', 'reason',
      'mode', 'name', 'intro', 'skillConfig',
      'deriveFrom', 'overrides', 'roleId',
    ];
    const declared = schemaProps(teamTool);
    for (const f of expected) {
      expect(declared, `team schema 漏声明 handler 实读字段 "${f}"`).toContain(f);
    }
    expect(declared).toContain('action');
  });
});
