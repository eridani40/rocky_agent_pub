/**
 * skill 读工具（纯读，progressive disclosure L1）
 * 参考: specs/tech/agent/skills/[P0]skill_tool.md §2 §3
 *       specs/tech/agent/skills/[P0]skill_architecture.md §9
 *
 * 工具名 `skill`（skill_tool §7：纯读语义清晰）。
 * 输入 {name} → 读 SKILL.md 全文 + skillDir 绝对路径 + scope。
 *
 * 寻址（skill_tool §3）：从 ctx.config.skills（resolve 时已 workspace 覆盖 app 去重）
 * 按 name 查 → 读 skillDir/SKILL.md。不重复扫盘（与 system prompt skills mapper 共用同一 catalog）。
 *
 * 不做 list：L0 catalog 已常驻 system prompt（skills mapper），工具 list 冗余。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from './types';
import { errorResult, textResult, ToolErrorCode } from './types';
import { toExternalSkillScope } from './skill-manage';
import type { SkillScope } from '../skills/types';

/**
 * skill 读工具（单例导出，registry defaultTools 引用）。
 * ctx.config.skills 为 SessionConfig.skills（arch §7），entries 已过滤 enabled。
 */
export const skillTool: Tool = {
  definition: {
    name: 'skill',
    description:
      "Read a skill's full SKILL.md by name (progressive disclosure L1). " +
      'Returns body + skillDir + scope. Use the Read tool for L2 drill-down into references/*.',
    intro: "Read a skill's full content by name.",
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          description: 'skill name (kebab-case, from system prompt L0 catalog)',
        },
      },
    },
  },

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const name = String(input.name ?? '').trim();
    if (!name) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] skill name is required`);
    }

    // 从 ctx.config.skills catalog 按 name 寻址（arch §9.2）
    const skills = (ctx.config as { skills?: { entries: Array<{ name: string; skillDir: string; scope: string }> } }).skills;
    const entry = skills?.entries.find((e) => e.name === name);
    if (!entry) {
      return errorResult(
        `[${ToolErrorCode.NOT_FOUND}] skill "${name}" not found in catalog ` +
          '(check available skills in system prompt)',
      );
    }

    const skillMdPath = join(entry.skillDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
      return errorResult(
        `[${ToolErrorCode.NOT_FOUND}] SKILL.md missing on disk for skill "${name}" at ${entry.skillDir}`,
      );
    }
    let body: string;
    try {
      body = readFileSync(skillMdPath, 'utf8');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] failed to read SKILL.md: ${msg}`);
    }

    const payload = {
      name,
      skillDir: entry.skillDir,
      // 输出 scope 回显 external（不变量#1：app/builtin→global，workspace→session）
      scope: toExternalSkillScope(entry.scope as SkillScope),
      body,
    };
    return textResult(JSON.stringify(payload));
  },
};
