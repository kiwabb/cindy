/** Small shared pieces of the personal todo page: priority ring and flag, tag dot, chip classes. */
import { Flag } from 'lucide-react';
import type { TaskTag } from '@cindy/maker-shared';
import type { TodoPriority } from '@cindy/maker-shared/teammate-todo';
import { taskTagNameKey } from '@cindy/maker-shared';

import { cn } from '@/lib/utils';

export const PRIORITY_COLOR: Record<TodoPriority, string> = {
  3: 'var(--task-tag-red)',
  2: 'var(--task-tag-orange)',
  1: 'var(--task-tag-blue)',
  0: 'var(--text-tertiary)',
};
export const PRIORITY_KEY: Record<TodoPriority, string> = {
  3: 'high',
  2: 'medium',
  1: 'low',
  0: 'none',
};

/** The completion ring: 18px, 1.5px border in the priority colour and a 12% tint of it. */
export function PriorityRing({ priority, className }: { priority: TodoPriority; className?: string }) {
  const color = PRIORITY_COLOR[priority];
  return (
    <span
      aria-hidden
      className={cn('box-border inline-block h-[18px] w-[18px] shrink-0 rounded-full border-[1.5px]', className)}
      style={{
        borderColor: color,
        backgroundColor: priority ? `color-mix(in srgb, ${color} 12%, transparent)` : 'transparent',
      }}
    />
  );
}

/** A flag in the priority colour; filled when there is a priority. */
export function PriorityFlag({ priority, size = 14 }: { priority: TodoPriority; size?: number }) {
  return (
    <Flag
      size={size}
      aria-hidden
      className="shrink-0"
      style={{ color: PRIORITY_COLOR[priority], fill: priority ? 'currentColor' : 'none' }}
    />
  );
}

const isPlainWhite = (color: TaskTag['color']) => color === 'none' || color === 'white';

/** The colour ball of a tag; white and no-colour tags use a border so they read on both themes. */
export function TagDot({ color, className }: { color: TaskTag['color']; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'box-border inline-block h-2 w-2 shrink-0 rounded-full',
        isPlainWhite(color) && 'border border-[var(--border-default)]',
        className,
      )}
      style={{ backgroundColor: `var(--task-tag-${isPlainWhite(color) ? 'white' : color})` }}
    />
  );
}

/** A tag's display name: presets are localised until renamed. */
export function tagDisplayName(tag: TaskTag, t: (key: string) => string): string {
  const key = taskTagNameKey(tag);
  return key ? t(key) : tag.name;
}

/** Toolbar and composer chips: 28px pills; the active one uses the chip fill. */
export function chipClass(active = false, extra?: string) {
  return cn(
    'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-12 outline-none transition-colors',
    'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
    active
      ? 'border-transparent bg-[var(--surface-chip)] text-[var(--text-primary)]'
      : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
    extra,
  );
}

export function Count({ value }: { value: number }) {
  return <span className="text-12 tabular-nums text-[var(--text-tertiary)]">{value}</span>;
}
