/**
 * PromptHandler 抽象基类（prompt 正文文件化的 server 核心层）。
 * 参考: specs/tech/agent/context/[P0]prompt_content_files.md §3
 *       specs/tech/version_logs/v0.0.22/change_log.md §3.1
 *
 * 职责：把 system prompt / compact prompt 的「正文 / 模板」从代码内置常量改为文件读取，
 * 子类 override build() 提供动态段 + 选 content 文件；基类负责读文件、mtime 缓存、
 * 模板占位符替换、降级（不中断 builder）。
 *
 * 依赖方向：本模块是纯 server 核心，无 plugin / EP 契约依赖（避免反向耦合）。
 * plugin 层 mapper（rocky_context）反向委托本模块取 content（plugin → server 正常方向）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** handler 构建结果（已替换占位符 / 已拼接动态段） */
export interface PromptHandlerResult {
  /** section 正文（空串表示不贡献——上游 mapper 据此决定返空数组） */
  content: string;
}

/** handler 通用上下文（不依赖 SessionConfig / EP 契约，避免反向耦合） */
export interface PromptHandlerContext {
  /** 动态数据：tools / skills / serialized transcript / 老 summary 等（子类按需读） */
  vars?: Record<string, string>;
  /** 项目工作目录（context_files handler 读 AGENTS.md 用） */
  cwd?: string;
  /**
   * 个人差异文件绝对路径（context_files handler 两级读取用，可选）。
   * squad leader/mate 的 `{workdir}/.rocky/agents/{名字}-{memberId}.md`，
   * 由 mapper 后缀扫描命中后传入；缺省 = 单级读取（现状）。
   */
  personalContextFile?: string;
}

/** 文件内容 + mtime 缓存项 */
interface CachedContent {
  text: string;
  mtimeMs: number;
}

/** content 目录绝对路径（handler 子类 contentFile 相对此解析） */
const CONTENT_DIR = path.join(__dirname, 'content');

/**
 * 关键 content 文件清单（打包/部署完整性自检用，见 checkPromptContentAssets）。
 * 与各 Handler 的 contentFile 声明保持同步——新增/删除 content 文件时一并维护本表。
 * 参考: specs/tech/agent/context/[P0]prompt_content_files.md §4
 *       specs/tech/version_logs/v0.0.153/change_plan.md T2/T3
 */
export const CRITICAL_CONTENT_FILES: readonly string[] = [
  'identity.md',
  'rules.md',
  'tool_guidance.md',
  'skills.md',
  'compact.md',
  'consolidation.md',
  'squad/leader.md',
  'squad/mate.md',
  'squad/squad_chat.md',
  'auto_naming.md',
  'routing_decision.md',
  'side_run_reminder/skeleton.md',
  'tick_heartbeat.md',
];

/**
 * 查询关键 content 文件是否齐全（打包/部署完整性自检，供 bootstrap 启动期调用）。
 * 纯查询、无副作用（不 log、不抛异常）——只用 existsSync，不读文件内容。
 * @param contentDir 待检查的 content 目录（默认真实 CONTENT_DIR；测试可传临时目录注入）
 * @returns ok=是否全部齐全；contentDirExists=目录本身是否存在；missing=缺失的相对路径列表
 *          （目录不存在时 missing = 全部清单，因为此时无法逐项判断哪些存在）
 */
export function checkPromptContentAssets(contentDir: string = CONTENT_DIR): {
  ok: boolean;
  contentDirExists: boolean;
  missing: string[];
} {
  const contentDirExists = fs.existsSync(contentDir);
  if (!contentDirExists) {
    return { ok: false, contentDirExists: false, missing: [...CRITICAL_CONTENT_FILES] };
  }
  const missing = CRITICAL_CONTENT_FILES.filter(
    (rel) => !fs.existsSync(path.join(contentDir, rel)),
  );
  return { ok: missing.length === 0, contentDirExists: true, missing };
}

/** 判断 dev 模式（mtime 检测）；prod 走 once cache */
function isDev(): boolean {
  const env = (typeof process !== 'undefined' && process.env?.NODE_ENV) || '';
  return env !== 'production';
}

/**
 * PromptHandler 抽象基类。
 * 子类声明 contentFile（可选）+ fallback（可选），override build() 提供动态段。
 */
export abstract class PromptHandler {
  /** content 文件相对路径（相对 content/ 目录，如 'identity.md'）；undefined 表示不读文件 */
  protected readonly contentFile?: string;
  /** 降级常量（读文件失败时用；可选，未声明则返空串） */
  protected readonly fallback?: string;

  /** 进程级缓存（path → { text, mtimeMs }）；dev mtime 失效 / prod once */
  protected static readonly cache = new Map<string, CachedContent>();

  /** 主入口：子类提供动态数据（如 tools/skills/serialized transcript） */
  public abstract build(ctx: PromptHandlerContext): PromptHandlerResult;

  /**
   * 子类调：读 content 文件（带 mtime 缓存 + 降级）。
   * - dev（NODE_ENV !== 'production'）：mtime 变 → 重读
   * - prod：once cache（启动读一次后不重读）
   * - 失败（缺文件 / 读异常）：返 this.fallback ?? ''（warn log，不抛）
   * @param relPath 可选，指定读取 content/ 下的哪个相对路径文件；缺省 = this.contentFile
   *                （子类需在同一实例内读取多个 content 段时传入，如 side-run-reminder 多段 md）
   * @returns 文件正文（失败时返 fallback 或空串）
   */
  protected readContent(relPath: string | undefined = this.contentFile): string {
    if (!relPath) return this.fallback ?? '';
    const full = path.join(CONTENT_DIR, relPath);
    try {
      // dev 模式检测 mtime 失效
      if (isDev()) {
        const stat = fs.statSync(full);
        const cached = PromptHandler.cache.get(full);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
          return cached.text;
        }
        const text = fs.readFileSync(full, 'utf8');
        PromptHandler.cache.set(full, { text, mtimeMs: stat.mtimeMs });
        return text;
      }
      // prod once cache
      const cached = PromptHandler.cache.get(full);
      if (cached) return cached.text;
      const stat = fs.statSync(full);
      const text = fs.readFileSync(full, 'utf8');
      PromptHandler.cache.set(full, { text, mtimeMs: stat.mtimeMs });
      return text;
    } catch (err) {
      // 缺文件 / 读异常 → 降级返 fallback（无 fallback 返空串），不抛中断 builder
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[PromptHandler] readContent failed for ${full}: ${msg}; falling back`,
      );
      return this.fallback ?? '';
    }
  }

  /**
   * 子类调：模板占位符替换 `{{name}}` → vars[name]。
   * 缺失变量替空串（不报错，spec §3.2/§3.3）。
   * 仅匹配 `{{identifier}}`（字母数字下划线），避免误伤 markdown 内容。
   * @param template 含 {{name}} 占位符的模板字符串
   * @param vars 变量名 → 值映射
   */
  protected fillTemplate(
    template: string,
    vars: Record<string, string>,
  ): string {
    return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (whole, key: string) => {
      const v = vars[key];
      return typeof v === 'string' ? v : '';
    });
  }

  /** 测试用：清空进程级缓存（dev mtime 检测下强制重读） */
  public static resetCacheForTests(): void {
    PromptHandler.cache.clear();
  }
}

/** 暴露给测试用：清缓存（dev mtime 检测下 ut 可强制重读） */
export function __clearPromptCacheForTests(): void {
  // 经静态方法访问 protected cache（避免模块级直接访问 private/protected）
  PromptHandler.resetCacheForTests();
}
