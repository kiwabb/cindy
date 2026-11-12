/**
 * The checklist of a personal todo, shared by the list row and the details panel: the step lines
 * (check, title, check time, remove) and the add row (a text button that opens an inline field).
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
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
 * leaving the field with text adds and closes (after the click that left it), leaving it empty
 * just closes; Esc cancels.
 * `onAdd` resolves true when the step was saved. `onClose(added)` is called whenever the field closes.
 */
export function StepAdder({
  adding,
  full = false,
  cancellable = false,
  onStart,
  onClose,
  onAdd,
  flushRef,
}: {
  adding: boolean;
  /** The checklist is at its limit. */
  full?: boolean;
  /** Show the × beside 添加 (the row version). */
  cancellable?: boolean;
  onStart: () => void;
  onClose: (added: boolean) => void;
  onAdd: (title: string) => Promise<boolean>;
  /**
   * Set while the field is open: saves what is typed now (or joins the save already running) so a
   * panel action can go on top of it; null when there is nothing to save.
   */
  flushRef?: MutableRefObject<(() => Promise<boolean> | null) | null>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  // Latest text and callbacks, also for a commit that runs after the press that left the field.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const latest = useRef({ onAdd, onClose });
  latest.current = { onAdd, onClose };
  // One save at a time; a second request (Enter, 添加, leaving, a panel action) joins it.
  const inflight = useRef<Promise<boolean> | null>(null);
  // Whether this opening of the field added any step (a row without steps folds back otherwise).
  const added = useRef(false);
  const pressed = useRef(false);
  const hasText = draft.trim() !== '';

  useEffect(() => {
    if (!adding) return;
    added.current = false;
    const down = () => {
      pressed.current = true;
    };
    const up = () => {
      pressed.current = false;
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      pressed.current = false;
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, [adding]);

  const submit = (): Promise<boolean> => {
    if (inflight.current) return inflight.current;
    const title = draftRef.current.trim();
    if (!title) return Promise.resolve(false);
    const run = (async () => {
      try {
        const saved = await latest.current.onAdd(title);
        if (saved) {
          added.current = true;
          if (draftRef.current.trim() === title) {
            draftRef.current = '';
            setDraft('');
          }
        }
        return saved;
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = run;
    return run;
  };
  if (flushRef)
    flushRef.current = adding
      ? () => inflight.current ?? (draftRef.current.trim() ? submit() : null)
      : null;
  const cancel = () => {
    setDraft('');
    latest.current.onClose(added.current);
  };
  // Leaving the field adds what was typed and closes it; left empty, it just closes. A failed
  // save keeps the field open with its text.
  const leave = async () => {
    if (inflight.current) await inflight.current;
    if (draftRef.current.trim() && !(await submit())) return;
    latest.current.onClose(added.current);
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
          if (!pressed.current) return void leave();
          // A press elsewhere took the focus: add after its click, so the click lands where it
          // was aimed instead of on whatever the added step pushes under the pointer.
          const after = () => {
            window.removeEventListener('pointerup', after, true);
            window.removeEventListener('pointercancel', after, true);
            setTimeout(() => void leave(), 0);
          };
          window.addEventListener('pointerup', after, true);
          window.addEventListener('pointercancel', after, true);
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
