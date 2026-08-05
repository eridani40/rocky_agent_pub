/**
 * page-skill — Skill 管理页根
 * 参考: specs/ui/components/skill-page/page-skill.md
 *       设计稿视觉基线: reqs/v0.0.21/easy-opc-skill-v10.html .config-area/.config-header/.config-title/.config-desc/.config-body (:44-48, :412-420)
 *
 * 组合：header(标题「Skill 管理」+ sub) + tab 栏 + drop-zone + skill list + 预览/删除 modal。
 * 数据走后端 skill API（list/install/toggle/delete/preview-tree/preview-file），不前端解压。
 * 自管理：skills 列表 + tab 状态（预埋，v0.0.21 仅 manage）+ preview/delete modal 显隐。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SkillEntry, SkillFileNode } from '../../lib/api-client';
import {
  deleteSkill,
  getSkillFile,
  getSkillTree,
  installSkill,
  listSkills,
  patchSkillEnabled,
  patchSkillEvolvable,
} from '../../lib/api-client';
import { ComponentSkillTabs, type SkillTabItem } from './component-skill-tabs';
import { ComponentSkillDropZone } from './component-skill-drop-zone';
import { ComponentSkillSourceFilter, filterSkillsBySource, type SkillSourceFilter } from './component-skill-source-filter';
import { SectionSkillList } from './section-skill-list';
import { ComponentSkillPreviewModal } from './component-skill-preview-modal';
import { ComponentSkillDeleteModal } from './component-skill-delete-modal';
import { SectionSkillMarket } from './section-skill-market';

/**
 * tab 列表（数据驱动，ComponentSkillTabs 按 id 自动透出 skill-tab-{id} testid）。
 * label 在 page 内按 tab id 注入 i18n（t('tab.{id}')）。manage=「我的」默认激活，market=「市场」。
 */
const TAB_IDS: SkillTabItem[] = [
  { id: 'manage', label: '' },
  { id: 'market', label: '' },
];

/**
 * 渲染 Skill 管理页根。挂载取列表；install/toggle/delete 后乐观更新（失败靠下次 GET 刷新）。
 */
export function PageSkill() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('manage');
  const [preview, setPreview] = useState<{ skill: SkillEntry; tree: SkillFileNode[] } | null>(null);
  const [delTarget, setDelTarget] = useState<SkillEntry | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // 安装弹层展开状态（默认 false 收起）+ 来源筛选（默认 'all'）
  const [installExpanded, setInstallExpanded] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<SkillSourceFilter>('all');
  // [v0.0.62 i18n] skill 页 UI 文案走 skill ns
  const { t } = useTranslation('skill');
  // 注入 i18n label（按 tab id：manage→「我的」，market→「市场」）
  const TABS: SkillTabItem[] = TAB_IDS.map((it) => ({ ...it, label: t(`tab.${it.id}`) }));
  // 派生可见列表（filter 后）；useMemo 避免每渲染重算，切 sourceFilter 时重算
  const visibleSkills = useMemo(
    () => filterSkillsBySource(skills, sourceFilter),
    [skills, sourceFilter],
  );

  // 刷新列表（install/toggle/delete 后调）
  const refresh = useCallback(async () => {
    try {
      const items = await listSkills();
      setSkills(items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('page.loadFail'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 安装：收集 payload → POST /skill/install multipart → 刷新列表
  // 成功分支末尾调 setInstallExpanded(false) 收起弹层；失败分支保留展开（让用户看到 error）。
  const handleInstall = async (payload: { kind: 'files' | 'folder' | 'zip'; files: File[] }) => {
    setUploading(true);
    try {
      await installSkill(payload.files);
      await refresh();
      setInstallExpanded(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('page.installFail'));
    } finally {
      setUploading(false);
    }
  };

  // toggle：乐观更新 + PATCH 持久化（失败回滚靠下次 refresh）
  const handleToggle = async (name: string) => {
    const target = skills.find((s) => s.name === name);
    if (!target) return;
    // group 层 skill 走团队 ws 管理，本页 PATCH 契约不含 group（listSkills 不带 sessionId 也不会
    // 返回 group）——guard 收窄 scope 为 builtin|app|workspace 供 patchSkillEnabled
    if (target.scope === 'group') return;
    setSkills((s) => s.map((it) => (it.name === name ? { ...it, enabled: !it.enabled } : it)));
    try {
      await patchSkillEnabled(name, !target.enabled, { scope: target.scope });
    } catch {
      // 失败回滚 + 刷新确保一致
      await refresh();
    }
  };

  // [v0.0.55] toggle evolvable：乐观更新 + PATCH governance 持久化（失败回滚靠 refresh）
  // evolvable 仅 UI 改（PATCH /skill/:name/governance），agent 不碰治理元字段（见 06a-skill-governance v2.0）
  const handleToggleEvolvable = async (name: string) => {
    const prev = skills;
    const target = prev.find((s) => s.name === name);
    if (!target) return;
    // builtin skill 随 app 发版，治理元字段（evolvable）只读——后端 governance 端点拒 builtin（400）；
    // 此处直接 no-op 不发请求（同时把 scope 收窄为 app|workspace 供下方 patchSkillEvolvable）
    if (target.scope === 'builtin') return;
    // group 层同 handleToggle：本页 governance PATCH 契约不含 group，guard 收窄类型
    if (target.scope === 'group') return;
    const nextEvolvable = !(target.evolvable ?? false);
    setSkills((s) => s.map((it) => (it.name === name ? { ...it, evolvable: nextEvolvable } : it)));
    try {
      await patchSkillEvolvable(name, nextEvolvable, { scope: target.scope });
    } catch {
      // 失败回滚 + 刷新确保一致
      await refresh();
    }
  };

  // 预览：取整树 → 打开 modal
  const handlePreview = async (skill: SkillEntry) => {
    try {
      const tree = await getSkillTree(skill.name);
      setPreview({ skill, tree });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('page.previewFail'));
    }
  };

  // 删除确认：DELETE → 关闭 + 刷新
  const handleDeleteConfirm = async (name: string) => {
    setDeleting(true);
    try {
      await deleteSkill(name);
      setDelTarget(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('page.deleteFail'));
    } finally {
      setDeleting(false);
    }
  };

  // 预览 modal 懒取文件内容（转发到 GET /skill/:name/file）
  const handleFetchFile = useCallback(
    async (skillName: string, path: string) => {
      const r = await getSkillFile(skillName, path);
      return { content: r.content, binary: r.binary, truncated: r.truncated };
    },
    [],
  );

  return (
    <main

      // 单一 scroll 容器：h-full 从 app-shell main（block 且高度受 h-screen 约束）拿到有界高度，
      // overflow-y-auto 才真正生效（对齐 page-chat/page-studio 的 h-full min-h-0）；
      // 原 flex-1 对 block 父惰性、高度按内容自增 → overflow 永不触发。header shrink-0 随内容滚动（无 sticky）。
      className="h-full min-h-0 overflow-y-auto flex flex-col"
    >
      {/* header：标题 + sub desc（设计稿 .config-header，padding 24px 32px 18px + 底分隔线） */}
      <div className="px-8 pt-6 pb-[18px] border-b border-border shrink-0">
        <div className="text-[20px] font-bold tracking-[-0.02em] text-fg">
          {t('page.headerTitle')}
        </div>
        <div className="mt-[3px] text-[12px] text-muted font-mono">
          {t('page.headerDesc')}
        </div>
      </div>

      {/* body：tab 栏 → 按 tab 分支（manage=拖拽+列表 / market=市场内容区），设计稿 .config-body */}
      <div className="px-8 pt-5 pb-10 flex-1" style={{ maxWidth: '880px' }}>
        <ComponentSkillTabs
          tabs={TABS}
          active={tab}
          onChange={setTab}
          // 「+」安装按钮塞 tabs actionSlot 通用右槽；token 配色 bg-fg/text-surface-2 自动双主题反色；
          // expanded 时 rotate-45（+→×）提供「再点收起」语义；始终占固定空间（shrink-0 不随 expanded 切换位移）
          actionSlot={
            <button
              type="button"
              data-action-key="skill.skill.open-install"
              onClick={() => setInstallExpanded((v) => !v)}
              aria-label={t('install.addAria')}
              aria-expanded={installExpanded}
              className={
                'shrink-0 w-[26px] h-[26px] rounded-[7px] flex items-center justify-center ' +
                'bg-fg text-surface-2 hover:opacity-85 transition-all duration-150 ' +
                (installExpanded ? 'rotate-45' : '')
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          }
        />

        {/* manage tab：弹层（条件渲染）→ 来源筛选 → error → loading/list（tab 切换不卸载已加载列表，skills state 常驻） */}
        {tab === 'manage' && (
          <>
            {/* 安装区弹层：installExpanded 才条件渲染（不用 display:none）；外层 relative 让右上角 × 按钮绝对定位 */}
            {installExpanded && (
              <div className="relative mb-[22px]">
                <ComponentSkillDropZone onInstall={handleInstall} uploading={uploading} />
                <button
                  type="button"
                  data-action-key="skill.skill.close-install"
                  onClick={() => setInstallExpanded(false)}
                  aria-label={t('install.closeAria')}
                  className="absolute top-2 right-2 w-[24px] h-[24px] rounded-[6px] flex items-center justify-center text-muted-2 hover:text-fg hover:bg-bg-warm transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}

            {/* 来源筛选条（仅 manage tab 内渲染；列表上方） */}
            <ComponentSkillSourceFilter active={sourceFilter} onChange={setSourceFilter} />

            {/* error 提示（mono 红，不阻塞，刷新后消失） */}
            {error && (
              <div className="mb-2 px-3 py-2 rounded-md text-[12px] font-mono text-danger bg-danger-light">
                {error}
              </div>
            )}

            {/* loading 占位（首次取列表时） */}
            {loading ? (
              <div className="py-7 text-center text-[13px] text-muted font-mono border border-dashed border-border rounded-[10px]">
                {t('page.loading')}
              </div>
            ) : (
              <SectionSkillList
                skills={visibleSkills}
                onToggle={handleToggle}
                onToggleEvolvable={handleToggleEvolvable}
                onPreview={handlePreview}
                onDelete={setDelTarget}
              />
            )}
          </>
        )}

        {/* market tab：市场内容区（fetch/state 全下沉 section）；装完 refresh 刷「我的」使来源 badge/同源态即时生效 */}
        {tab === 'market' && (
          <SectionSkillMarket installedSkills={skills} onInstalled={refresh} />
        )}
      </div>

      {/* 预览 modal（按需挂载） */}
      {preview && (
        <ComponentSkillPreviewModal
          skill={preview.skill}
          tree={preview.tree}
          onClose={() => setPreview(null)}
          onFetchFile={handleFetchFile}
        />
      )}

      {/* 删除确认 modal（按需挂载） */}
      {delTarget && (
        <ComponentSkillDeleteModal
          skill={delTarget}
          onCancel={() => setDelTarget(null)}
          onConfirm={handleDeleteConfirm}
          deleting={deleting}
        />
      )}
    </main>
  );
}

export default PageSkill;
