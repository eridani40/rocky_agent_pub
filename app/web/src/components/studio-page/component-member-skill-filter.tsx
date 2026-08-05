/**
 * component-member-skill-filter —— 成员编辑面板 skills section 的简化版 skill 可见性筛选器
 * 参考: specs/ui/components/studio-page/component-member-skill-filter.md
 *       specs/prd/version_logs/v0.0.113/2-member-skills-mechanism.md（R1-R6 叠加快照 + §4 简化筛选器）
 *       specs/ui/components/framework/primitive-toggle-switch.md（ToggleSwitch 用法）
 *
 * 职责：custom 模式下展开的「enable/disable 开关列表 + 顶部搜索」，非 skill 资产管理器。
 *   拉全局 catalog（listSkills）→ 排除 scope==='workspace'（恒生效不展示）→ 每行 name+desc+ToggleSwitch。
 *   每行显示态 = overrides[name] !== undefined ? overrides[name] : entry.enabled（R4 叠加）。
 *   toggle 上抛父级更新 overrides；catalog 经 onCatalog 上抛父级（保存时 R5 全量补齐）。
 * 边界：只做可见性开关 + 搜索——无 preview/install/delete/evolvable 治理；不持久化（父 PATCH）。
 *
 * 视觉：每行对齐全局 skill 页 component-skill-item 的设计语言（logo 星形 + name/desc + 启用 label
 *   + ToggleSwitch），但简化掉资产管理元素（preview/delete 按钮、evolvable toggle、状态 badge）。
 * 折叠：open 控制 grid-template-rows 0fr↔1fr + overflow-hidden 子容器高度过渡（禁 display:none，
 *   收起态高度≈0 平滑推移相邻 section，不跳动——R4 / member-panel A-7）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listSkills } from '../../lib/api-client';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';
import { IconBox } from '../common/component-icon-box';
import { INPUT } from './studio-styles';

/** catalog 一行精简形态（父级 R5 补齐快照用；来自 SkillEntry） */
export interface SkillFilterEntry {
  name: string;
  description: string;
  /** 全局 enabled（叠加的「底」） */
  enabled: boolean;
}

interface ComponentMemberSkillFilterProps {
  /** custom 模式=true 展开；inherit=false 收起（高度动画，不 display:none） */
  open: boolean;
  /** 受控局部覆盖快照（父持有）；某 skill 有键=局部覆盖，无键=跟全局 */
  overrides: Record<string, boolean>;
  /** 某行开关翻转（name + 翻转后新值），父级 setOverrides({...overrides,[name]:next}) */
  onToggle: (name: string, next: boolean) => void;
  /** 拉到全局 catalog（已排除 workspace）后上抛父级，供保存时 R5 全量补齐 */
  onCatalog?: (entries: SkillFilterEntry[]) => void;
}

/**
 * 简化版 skill 筛选器。挂载即拉 catalog（一次性），custom 时展开可见。
 */
export function ComponentMemberSkillFilter({ open, overrides, onToggle, onCatalog }: ComponentMemberSkillFilterProps) {
  const [entries, setEntries] = useState<SkillFilterEntry[]>([]);
  const [search, setSearch] = useState('');
  // 复用 skill ns 的「启用」label（与全局 skill 页 toggle 文案一致）
  const { t } = useTranslation('skill');
  // onCatalog 存 ref，避免进 fetch effect 依赖导致重复拉取
  const onCatalogRef = useRef(onCatalog);
  onCatalogRef.current = onCatalog;

  // 挂载一次性拉 catalog → 排除 workspace（恒生效不治理）→ 按 name 排序 → 上抛父级
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const items = await listSkills();
        if (!alive) return;
        const filtered: SkillFilterEntry[] = items
          .filter((e) => e.scope !== 'workspace')
          .map((e) => ({ name: e.name, description: e.description, enabled: e.enabled }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setEntries(filtered);
        onCatalogRef.current?.(filtered);
      } catch {
        // 拉取失败不阻塞面板：列表空
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 搜索按 name 子串过滤（大小写不敏感）
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  }, [entries, search]);

  // 某行叠加后显示态 = overrides 有记录用记录值（boolean），否则跟全局 enabled
  //   overrides 值恒为 boolean，缺键为 undefined → ?? 回退全局，等价于 (name in overrides ? … : …)
  const effective = (e: SkillFilterEntry): boolean => overrides[e.name] ?? e.enabled;

  return (
    <div

      className={
        'grid transition-[grid-template-rows,opacity] duration-200 ease-out ' +
        (open ? 'mt-3.5 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')
      }
    >
      {/* overflow-hidden 子容器：min-height:auto→0，配合 0fr 折叠到高度 0 */}
      <div className="overflow-hidden">
        <input

          className={INPUT}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索 skill"
        />
        <div className="mt-2.5 flex flex-col gap-2">
          {shown.map((e) => {
            const on = effective(e);
            return (
              <div
                key={e.name}

                className="group flex items-center gap-[14px] rounded-[10px] border border-border bg-surface-2 px-4 py-[14px] transition-colors hover:border-border-strong"
              >
                {/* logo：IconBox + hash-by-skill.name 8 色 palette（v0.0.165 regulation 02 §4，与 component-skill-item 同源） */}
                <IconBox
                  hueBy={e.name}
                  size={34}
                  icon={<SkillStarIcon />}
                  className="shadow-sm"
                />
                {/* info：name 行 + desc 两行省略（对齐 skill-item） */}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-semibold text-fg">{e.name}</div>
                  {e.description && (
                    <div
                      className="mt-[3px] overflow-hidden text-ellipsis text-[12px] leading-[1.5] text-muted-2"
                      style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
                    >
                      {e.description}
                    </div>
                  )}
                </div>
                {/* 启用 label + ToggleSwitch（对齐 skill-item 的 label+toggle 模式，均 shrink-0） */}
                <div className="flex shrink-0 items-center gap-2">
                  <span className="shrink-0 font-mono text-[11px] text-muted-2">{t('item.enableLabel')}</span>
                  <ToggleSwitch

                    value={on}
                    onChange={(next) => onToggle(e.name, next)}
                    label={e.name}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// —— 内联图标（同 component-skill-item 的四角星，保持 logo 一致） ——
/** 四角星 skill icon（设计稿 Icon skill） */
function SkillStarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2L14 10 22 12 14 14 12 22 10 14 2 12 10 10Z" />
    </svg>
  );
}

export default ComponentMemberSkillFilter;
