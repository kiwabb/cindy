/**
 * learning-today —— 导师对话右侧的「今天」页签（学习目标的当前进度，只读）。
 *
 * 只由 LearningTodayTabAutoOpen 在绑定了学习目标的本机对话里自动加上，不进「+」菜单；
 * 每个任务至多一个。正文与自动加入逻辑在 features/learning。
 */
import { lazy } from 'react';
import { GraduationCap } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const LearningTodayTabBody = lazy(() =>
  import('@/features/learning/LearningTodayTab').then((module) => ({
    default: module.LearningTodayTabBody,
  })),
);

type LearningTodayState = Record<never, never>;

function LearningTodayTabPillTitle({ t }: { state: LearningTodayState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.learningToday')}</>;
}

function LearningTodayTabPillIcon() {
  return <GraduationCap size={13} />;
}

const plugin: TabKindPlugin<LearningTodayState> = {
  kind: 'learning-today',
  menu: {
    kind: 'learning-today',
    labelKey: 'rightSidebar.tabs.kinds.learningToday',
    icon: GraduationCap,
    order: 19,
    enabled: true,
    hiddenFromMenu: true,
    singleton: true,
  },
  TabPillTitle: LearningTodayTabPillTitle,
  TabPillIcon: LearningTodayTabPillIcon,
  TabBody: LearningTodayTabBody,
  defaultState: () => ({}),
  serializeState: () => ({}),
  hydrateState: () => ({}),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
