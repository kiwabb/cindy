/**
 * The checklist of a personal todo, shared by the list row and the details panel: the step lines
 * (check, title, check time, remove) and the add row (a text button that opens an inline field).
 */
import { useRef, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { composing } from './PersonalTodoComposer';
import { stepDoneTime, type PersonalStep } from './personalTodoModel';

const REMOVE_CLASS =
  'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] opacity-0 outline-none transition-opacity hover:bg-[var(--surface-hover)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] group-focus-within:opacity-100 group-hover:opacity-100 disabled:opacity-0';

/** The step lines; `readOnly` shows them without check, remove or add controls. */
export function StepList({
  steps,
  now,
  disabled = false,
  readOnly = false,
  onToggle,
  onRemove,
  className,
}: {
  steps: readonly PersonalStep[];
  now: Date;
  disabled?: boolean;
  readOnly?: boolean;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  if (!steps.length) return null;
  return (
    <ul className={cn('flex flex-col', className)}>
      {steps.map((step) => {
        const doneTime = step.done ? stepDoneTime(step.doneAt, now, i18n.language) : null;
        return (
          <li
            key={step.id}
            className="group -mx-1.5 flex min-h-[30px] items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-[var(--surface-hover)]"
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={step.done}
              aria-label={t(step.done ? 'personalTodos.steps.reopen' : 'personalTodos.steps.complete', {
                title: step.title,
              })}
              disabled={disabled || readOnly}
              onClick={() => onToggle(step.id)}
              className="-m-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-default"
            >
              <span
                aria-hidden
                className={cn(
                  'box-border inline-flex size-4 items-center justify-center rounded-full border-[1.5px]',
                  step.done
                    ? 'border-[var(--text-secondary)] bg-[var(--text-secondary)] text-[var(--surface-elevated)]'
                    : 'border-[var(--text-tertiary)]',
                  (disabled || readOnly) && 'opacity-60',
                )}
              >
                {step.done ? <Check size={10} strokeWidth={3.2} /> : null}
              </span>
            </button>
            <span
              className={cn(
                'min-w-0 flex-1 break-words text-13 leading-[18px]',
                step.done
                  ? 'text-[var(--text-tertiary)] line-through'
                  : 'text-[var(--text-primary)]',
              )}
            >
              {step.title}
            </span>
            {doneTime ? (
              <span
                title={doneTime.title}
                className="shrink-0 text-12 tabular-nums text-[var(--text-tertiary)]"
              >
                {doneTime.text}
              </span>
            ) : null}
            {readOnly ? null : (
              <Tip text={t('personalTodos.steps.remove', { title: step.title })}>
                <button
                  type="button"
                  aria-label={t('personalTodos.steps.remove', { title: step.title })}
                  disabled={disabled}
                  onClick={() => onRemove(step.id)}
                  className={REMOVE_CLASS}
                >
                  <X size={12} aria-hidden />
                </button>
              </Tip>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Under the step lines: 「＋ 添加步骤」 opens a field. Enter or 添加 adds and keeps the field open;
 * leaving the field with text adds and closes, leaving it empty just closes; Esc cancels.
 * `onAdd` resolves true when the step was saved. `onClose(added)` is called whenever the field closes.
 */
export function StepAdder({
  adding,
  full = false,
  cancellable = false,
  onStart,
  onClose,
  onAdd,
}: {
  adding: boolean;
  /** The checklist is at its limit. */
  full?: boolean;
  /** Show the × beside 添加 (the row version). */
  cancellable?: boolean;
  onStart: () => void;
  onClose: (added: boolean) => void;
  onAdd: (title: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const sending = useRef(false);
  const hasText = draft.trim() !== '';

  const submit = async (): Promise<boolean> => {
    const title = draft.trim();
    if (!title || sending.current) return false;
    sending.current = true;
    try {
      const saved = await onAdd(title);
      if (saved) setDraft((current) => (current.trim() === title ? '' : current));
      return saved;
    } finally {
      sending.current = false;
    }
  };
  const cancel = () => {
    setDraft('');
    onClose(false);
  };

  if (!adding)
    return (
      <button
        type="button"
        disabled={full}
        onClick={onStart}
        className="-mx-1.5 flex min-h-[30px] items-center gap-2.5 rounded-lg px-1.5 text-left text-13 text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-60"
      >
        <span aria-hidden className="inline-flex size-4 items-center justify-center">
          <Plus size={13} />
        </span>
        {t('personalTodos.steps.add')}
      </button>
    );

  return (
    <div className="-mx-1.5 flex min-h-[34px] items-center gap-2 px-1.5">
      <span
        aria-hidden
        className="box-border inline-block size-4 shrink-0 rounded-full border-[1.5px] border-dashed border-[var(--text-tertiary)]"
      />
      <Input
        size="sm"
        autoFocus
        className="min-w-0 flex-1"
        inputClassName="h-7 rounded-lg px-2.5 text-13"
        aria-label={t('personalTodos.steps.name')}
        placeholder={t('personalTodos.steps.name')}
        maxLength={300}
        value={draft}
        onChange={setDraft}
        onKeyDown={(event) => {
          if (composing(event)) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
          } else if (event.key === 'Escape') {
            // Cancels the field only; a panel around it stays open.
            event.stopPropagation();
            cancel();
          }
        }}
        onBlur={() => {
          if (!hasText) return onClose(false);
          void submit().then((saved) => {
            if (saved) onClose(true);
          });
        }}
      />
      <Button
        variant="cta"
        size="sm"
        compact
        aria-disabled={!hasText}
        className={cn('text-12', !hasText && 'opacity-60')}
        // The field's blur must not race the click: add on press and keep the field focused.
        onMouseDown={(event) => {
          event.preventDefault();
          void submit();
        }}
        // A keyboard activation has no press; it adds here.
        onClick={(event) => {
          if (event.detail === 0) void submit();
        }}
      >
        {t('personalTodos.steps.confirm')}
      </Button>
      {cancellable ? (
        <button
          type="button"
          aria-label={t('personalTodos.steps.cancel')}
          onMouseDown={(event) => {
            event.preventDefault();
            cancel();
          }}
          onClick={(event) => {
            if (event.detail === 0) cancel();
          }}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <X size={12} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
