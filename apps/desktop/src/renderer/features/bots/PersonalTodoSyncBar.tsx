import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { PersonalTodoSyncStatus } from '../../../shared/personalTodo';
import { personalTodoSyncLabels } from './personalTodoModel';

export function PersonalTodoSyncBar({
  status,
  busy,
  failed,
  onToggle,
  onSetAsHome,
}: {
  status: PersonalTodoSyncStatus;
  busy: boolean;
  failed: boolean;
  onToggle: (on: boolean) => void;
  onSetAsHome: () => void;
}) {
  const { t } = useTranslation();
  const labels = personalTodoSyncLabels(status, t);
  return (
    <div
      data-testid="todo-sync-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-2 pt-3 text-12 text-[var(--text-secondary)]"
    >
      <label className="inline-flex items-center gap-2">
        <Switch
          aria-label={t('personalTodos.sync.toggle')}
          checked={status.role !== 'off'}
          disabled={busy}
          onCheckedChange={onToggle}
        />
        <span className="text-[var(--text-primary)]">{t('personalTodos.sync.toggle')}</span>
      </label>
      {labels.map((label) => (
        <span
          key={label.text}
          className={
            label.tone === 'warning'
              ? 'inline-flex items-center gap-1 text-[var(--text-primary)]'
              : undefined
          }
        >
          {label.tone === 'warning' ? (
            <TriangleAlert size={12} className="text-[var(--warning-fg)]" aria-hidden />
          ) : null}
          {label.text}
        </span>
      ))}
      {status.role === 'replica' ? (
        <Button variant="secondary" size="sm" disabled={busy} onClick={onSetAsHome}>
          {t('personalTodos.sync.setAsHome')}
        </Button>
      ) : null}
      {failed ? (
        <span role="alert" className="text-[var(--error-fg)]">
          {t('personalTodos.sync.failed')}
        </span>
      ) : null}
    </div>
  );
}
