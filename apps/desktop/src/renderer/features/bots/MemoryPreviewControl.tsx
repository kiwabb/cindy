import { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { useBotTranslation } from './botPronounContext';

/** Normal local settings entry. Viewing this panel never enables analysis. */
export function MemoryPreviewControl({
  botId,
  assertCurrent,
}: {
  botId: string;
  assertCurrent(): void;
}) {
  const { t } = useBotTranslation();
  const [value, setValue] = useState<
    import('../../../shared/botMemory').MemoryPreviewStatus | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    setValue(null);
    setFailed(false);
    void Promise.resolve()
      .then(() => window.electronAPI.localDb.bots.memoryPreview.get({ botId }))
      .then((result) => {
        assertCurrent();
        if (!disposed && result.botId === botId) setValue(result);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [botId, assertCurrent]);
  const change = async (enabled: boolean) => {
    if (!value || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      assertCurrent();
      const result = await window.electronAPI.localDb.bots.memoryPreview.set({
        botId,
        enabled,
        expectedRevision: value.revision,
      });
      assertCurrent();
      if (result.botId !== botId) throw Error('MEMORY_PREVIEW_SCOPE_CHANGED');
      setValue(result);
    } catch {
      try {
        assertCurrent();
        setFailed(true);
      } catch {
        /* Stale owner/source view. */
      }
    } finally {
      try {
        assertCurrent();
        setBusy(false);
      } catch {
        /* Closed view. */
      }
    }
  };
  return (
    <section className="flex flex-col gap-2" aria-label={t('bots.memory.previewLabel')}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-13">{t('bots.memory.previewLabel')}</span>
        <Switch
          checked={value?.enabled ?? false}
          disabled={!value || busy || (!value.available && !value.enabled)}
          onCheckedChange={(enabled) => void change(enabled)}
          aria-label={t('bots.memory.previewLabel')}
        />
      </div>
      <p className="text-12 text-[var(--text-secondary)]">
        {t('bots.memory.previewHint', { model: value?.model ?? '—' })}
      </p>
      {value && !value.available ? (
        <p className="text-12 text-[var(--text-secondary)]">
          {t('bots.memory.previewUnavailable')}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-12 text-[var(--text-secondary)]">
          {t('bots.memory.previewError')}
        </p>
      ) : null}
    </section>
  );
}
