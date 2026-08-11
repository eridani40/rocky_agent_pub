/**
 * ContextFilesHandler — 项目上下文片段（读项目 AGENTS.md/CLAUDE.md，非 content 目录）。
 * 参考: specs/tech/agent/context/[P0]prompt_content_files.md §4 §7.7
 *       specs/prd/overall/13-agent-definition.md §13.2.2（团队 + 个人两级注入）
 *
 * 两级读取（v0.0.232）：
 *   - 主文件（团队/课程/个人单份）：从 ctx.cwd 读首个存在的候选（AGENTS.md→CLAUDE.md），
 *     截断 MAX_FILE_CHARS=20000。
 *   - 个人差异文件（可选）：ctx.personalContextFile 绝对路径（squad leader/mate 的
 *     `.rocky/agents/{名字}-{memberId}.md`，由 mapper 后缀扫描命中传入），截断
 *     MAX_PERSONAL_FILE_CHARS=8000。拼接 = 团队段在前、个人段在后（个人叠加团队），
 *     两段各带「来自…：{绝对路径}」来源标注。
 * 两份都不存在 → 返空 content；任一份不存在/为空 → 该段省略（MUST NOT 注入空壳段）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';

/** 候选上下文文件名（项目根目录，按顺序读首个存在的） */
const CANDIDATE_FILES = ['AGENTS.md', 'CLAUDE.md'];
/** 主文件读取上限（char，避免超大文件灌满 prompt；对齐既有 context_files mapper） */
const MAX_FILE_CHARS = 100000;
/**
 * 个人差异文件读取上限（char）。两级合计 ≤200000，与 memory_session 在
 * budget_truncate floor（40000）内共存（change_plan E 节架构结论）。
 */
export const MAX_PERSONAL_FILE_CHARS = 100000;

/** 截断标记（readFirst / readPersonalFile 共用） */
const TRUNCATE_NOTE = '\n…[context file truncated by context_files handler]';

/** 截断到上限（超加 TRUNCATE_NOTE） */
function truncateAt(content: string, max: number): string {
  return content.length > max ? content.slice(0, max) + TRUNCATE_NOTE : content;
}

/** 项目文件读取结果（找到的文件名 + 正文，含截断标记） */
export interface ContextFilesResult {
  /** 命中的文件名（用于 fragment 标题展示） */
  name: string;
  /** 正文（已截断到上限，超出加 truncation 标记） */
  content: string;
}

/** ContextFilesHandler：读项目 AGENTS.md/CLAUDE.md（cwd）+ 可选个人差异文件 */
export class ContextFilesHandler extends PromptHandler {
  // 无 contentFile（读项目文件，非 content 目录）

  build(ctx: PromptHandlerContext): PromptHandlerResult {
    const cwd = ctx.cwd ?? '';
    const sections: string[] = [];

    // 团队/主文件段（cwd 候选，单级读取语义不变）
    if (cwd) {
      const found = this.readFirst(cwd);
      if (found) {
        const fullPath = path.join(cwd, found.name);
        sections.push(
          `# Project Context (${found.name})\n\n来自本会话工作目录：${fullPath}\n\n${found.content}`,
        );
      }
    }

    // 个人差异文件段（可选，叠加在主文件之后）
    if (ctx.personalContextFile) {
      const personal = this.readPersonalFile(ctx.personalContextFile);
      if (personal) {
        sections.push(
          `# Personal Context (${personal.name})\n\n来自个人差异文件：${ctx.personalContextFile}\n\n${personal.content}`,
        );
      }
    }

    return { content: sections.join('\n\n') };
  }

  /**
   * 按候选顺序读首个存在的非空文件，截断到 MAX_FILE_CHARS。
   * 行为对齐既有 context_files mapper 的 readFirst。
   */
  private readFirst(cwd: string): ContextFilesResult | null {
    for (const name of CANDIDATE_FILES) {
      const full = path.join(cwd, name);
      try {
        if (!fs.existsSync(full)) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (!content.trim()) continue;
        return { name, content: truncateAt(content, MAX_FILE_CHARS) };
      } catch {
        // 读失败（权限/编码）→ 试下一个候选
      }
    }
    return null;
  }

  /**
   * 读个人差异文件（绝对路径），截断到 MAX_PERSONAL_FILE_CHARS。
   * 文件不存在 / 为空 / 读失败 → null（不抛；caller 据此省略该段）。
   */
  private readPersonalFile(absPath: string): ContextFilesResult | null {
    try {
      if (!fs.existsSync(absPath)) return null;
      const content = fs.readFileSync(absPath, 'utf8');
      if (!content.trim()) return null;
      return { name: path.basename(absPath), content: truncateAt(content, MAX_PERSONAL_FILE_CHARS) };
    } catch {
      return null;
    }
  }
}

export default ContextFilesHandler;
