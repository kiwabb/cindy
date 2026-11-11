/**
 * 个人待办行的视觉映射：优先级圈色与标签色球（Mobile 用 taskTag* 色板字段，不另造颜色）。
 * 优先级圈：高红 / 中橙 / 低蓝，无优先级沿用中性灰圈；标签色表示用户分类，不表示状态。
 */
import { taskTagNameKey } from '@cindy/maker-shared';
import type { ThemeColors } from '@/theme';
import type { PersonalTodoItem, PersonalTodoTag } from './usePersonalTodos';

/** 12% tint of the ring color (8-digit hex alpha 0x1f). */
export const RING_TINT_ALPHA = '1f';

export function priorityRingColor(priority: PersonalTodoItem['priority'], colors: ThemeColors): string | null {
  return priority === 3 ? colors.taskTagRed : priority === 2 ? colors.taskTagOrange : priority === 1 ? colors.taskTagBlue : null;
}

/** An unknown color from a newer host reads as the neutral gray. */
export function personalTodoTagColor(color: PersonalTodoTag['color'], colors: ThemeColors): string {
  const palette: Record<string, string> = {
    red: colors.taskTagRed, orange: colors.taskTagOrange, yellow: colors.taskTagYellow, green: colors.taskTagGreen,
    blue: colors.taskTagBlue, purple: colors.taskTagPurple, gray: colors.taskTagGray, pink: colors.taskTagPink,
    coral: colors.taskTagCoral, teal: colors.taskTagTeal, indigo: colors.taskTagIndigo, white: colors.taskTagWhite,
    none: colors.taskTagWhite,
  };
  return palette[color] ?? colors.taskTagGray;
}

/** Preset names localize on the phone (same rule as the task tag list); a renamed tag keeps its own name. */
export function personalTodoTagLabel(tag: PersonalTodoTag, t: (key: string) => string): string {
  const key = taskTagNameKey({ ...tag, favoriteOrder: null, revision: 0 });
  return key ? t(key) : tag.name;
}
