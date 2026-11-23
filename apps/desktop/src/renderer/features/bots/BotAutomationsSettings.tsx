import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Schedule } from '@cindy/maker-scheduler';
import { teammateFolderName, teammateFolderOfProjectPath } from '@cindy/maker-shared/teammate-project';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useSchedules } from '../scheduler/hooks/useSchedules';
import { cronToHuman } from '../../../shared/scheduleCronLabel';
import { formatLastRun, formatNextRun } from '../scheduler/lib/formatters';
import { useBotTranslation } from './botPronounContext';

type AutonomousApi = Window['electronAPI']['maker']['schedule']['companionAutonomous'];

function CompanionAutonomousSettings({ botId }: { botId: string }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Awaited<ReturnType<AutonomousApi>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const api = window.electronAPI.maker.schedule.companionAutonomous;
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api({ botId }).then(result => { if (active) setSettings(result); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [api, botId]);
  const save = async (update: NonNullable<Parameters<AutonomousApi>[0]['update']>) => {
    setBusy(true);
    setError(false);
    try {
      setSettings(await api({ botId, update }));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  if (!api) return null;
  const editable = !!settings?.canEdit && !settings.homeChanged && !busy;
  const prefix = 'bots.automations.autonomous';
  return <section className="space-y-3 rounded-xl border border-[var(--border-default)] p-4">
    <h3 className="text-14 font-medium">{t(prefix + '.title')}</h3>
    <p className="text-13 text-[var(--text-secondary)]">{t(prefix + '.description')}</p>
    {error && <p role="alert" className="text-13 text-[var(--text-danger)]">{t(prefix + '.error')}</p>}
    {settings && <>
      <label className="flex items-center justify-between gap-2 text-13">
        {t(prefix + '.greeting')}
        <Switch checked={settings.greeting} disabled={!editable}
          onCheckedChange={greeting => void save({ greeting })} />
      </label>
      <label className="flex items-center justify-between gap-2 text-13">
        {t(prefix + '.sharing')}
        <Switch checked={settings.sharing} disabled={!editable}
          onCheckedChange={sharing => void save({ sharing })} />
      </label>
      {settings.homeChanged && <p className="text-13">{t(prefix + '.homeChanged')}</p>}
      {(settings.greeting || settings.sharing || settings.homeChanged) && (
        <Button type="button" variant="secondary" disabled={!settings.canEdit || busy}
          onClick={() => void save(settings.paused || settings.homeChanged ? { resume: true } : { paused: true })}>
          {t(prefix + (settings.paused || settings.homeChanged ? '.resume' : '.pause'))}
        </Button>
      )}
    </>}
  </section>;
}

/** The automations of a teammate's own project, as in the Automations page. */
export function teammateProjectSchedules(schedules: readonly Schedule[], botId: string): Schedule[] {
  const folder = teammateFolderName(botId);
  return schedules.filter((schedule) => schedule.workspaceKind !== 'dialogue'
    && teammateFolderOfProjectPath(schedule.workingDir) === folder);
}

/**
 * The 「自动化」 page of a V2 teammate (2026-11-10 owner): its project's automations with their timing
 * and an on/off switch. Editing stays in the Automations page, which each row opens.
 */
export function BotAutomationsSettings({ bot, beforeLeave }: {
  bot: { id: string; name: string; homeDir?: string | null };
  /** Saves pending profile edits before leaving for the Automations page. */
  beforeLeave?: () => Promise<boolean>;
}) {
  const { t } = useBotTranslation();
  const { t: tr, i18n } = useTranslation();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const { schedules, loading, error, refresh } = useSchedules();
  const [pending, setPending] = useState<string | null>(null);
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [creatingFollowUp, setCreatingFollowUp] = useState(false);
  const [topic, setTopic] = useState('');
  const [followUpTime, setFollowUpTime] = useState('');
  const items = useMemo(() => teammateProjectSchedules(schedules, bot.id)
    .sort((a, b) => a.name.localeCompare(b.name)), [schedules, bot.id]);
  const workspace = items[0]?.workingDir ?? (bot.homeDir ? `${bot.homeDir.replace(/[\\/]+$/, '')}/workspace` : null);

  const open = async (path: string) => {
    if (beforeLeave && !(await beforeLeave())) return;
    navigate(path);
  };
  const toggle = async (schedule: Schedule, on: boolean) => {
    if (pending) return;
    setPending(schedule.id);
    try {
      if (on) {
        await window.electronAPI.maker.schedule.resume(schedule.id);
      } else {
        // Same as the Automations page: pausing stops runs in progress, so ask first.
        const inflight = await window.electronAPI.maker.schedule.getInflightCount(schedule.id).catch(() => 0);
        if (inflight > 0 && !(await confirm({
          title: tr('scheduler.confirm.pause.title', { name: schedule.name }),
          description: tr('scheduler.confirm.pause.withInflight', { count: inflight }),
          confirmText: tr('scheduler.confirm.pause.confirm'),
          cancelText: tr('scheduler.confirm.pause.cancel'),
        }))) return;
        await window.electronAPI.maker.schedule.pause(schedule.id);
      }
    } catch (e) {
      toast.error(tr('scheduler.toast.actionFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setPending(null);
    }
  };
  const createFollowUp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (creatingFollowUp || !topic.trim() || !followUpTime) return;
    setCreatingFollowUp(true);
    try {
      if (beforeLeave && !(await beforeLeave())) return;
      await window.electronAPI.maker.schedule.createCompanionFollowUp({
        botId: bot.id, topic, dueAt: Date.parse(`${followUpTime}:00+08:00`),
      });
      setShowFollowUp(false);
      setTopic('');
      setFollowUpTime('');
      void refresh();
    } catch (error) {
      toast.error(tr('scheduler.toast.actionFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setCreatingFollowUp(false);
    }
  };

  const timing = (schedule: Schedule) => {
    const frequency = schedule.manual
      ? tr(schedule.webhookTrigger ? 'scheduler.webhook.title' : 'scheduler.cell.subtitleManual')
      : schedule.recurring
        ? cronToHuman(schedule.cronExpr, tr, i18n.resolvedLanguage ?? i18n.language)
        : tr('scheduler.cell.subtitleOnce');
    const last = formatLastRun(schedule.lastFiredAt, Date.now(), tr);
    const next = schedule.status === 'active' && !schedule.manual ? formatNextRun(schedule.nextFireAt, Date.now(), tr) : null;
    const when = schedule.status === 'paused'
      ? tr(schedule.companionFollowUpAt === undefined ? 'scheduler.cell.subtitlePaused' : 'bots.automations.followUp.cancelled')
      : [last, next].filter(Boolean).join(' · ');
    return { frequency, when };
  };

  return <div className="space-y-4 py-3">
    <CompanionAutonomousSettings key={bot.id} botId={bot.id} />
    <p className="text-13 leading-6 text-[var(--text-secondary)]">{t('bots.automations.description', { name: bot.name })}</p>
    <section className="space-y-3 rounded-xl border border-[var(--border-default)] p-4">
      <Button type="button" variant="secondary" aria-expanded={showFollowUp}
        onClick={() => setShowFollowUp(open => !open)}>
        <Plus size={16} />{t('bots.automations.followUp.title')}
      </Button>
      {showFollowUp ? <form onSubmit={event => void createFollowUp(event)} className="space-y-3">
        <p className="text-13 text-[var(--text-secondary)]">{t('bots.automations.followUp.description')}</p>
        <fieldset disabled={creatingFollowUp} className="space-y-3">
          <FormField required label={t('bots.automations.followUp.topic')}>
            {control => <Input {...control} required maxLength={500} value={topic} onChange={setTopic} />}
          </FormField>
          <FormField required label={t('bots.automations.followUp.time')}>
            {control => <Input {...control} type="datetime-local" required value={followUpTime}
              onChange={setFollowUpTime} />}
          </FormField>
          <Button type="submit" disabled={!topic.trim() || !followUpTime}>{t('bots.automations.followUp.save')}</Button>
        </fieldset>
      </form> : null}
    </section>
    {error ? <div role="alert" className="flex items-center justify-between gap-3 text-13 text-[var(--text-danger)]">
      <span>{t('bots.automations.failed')}</span>
      <Button variant="secondary" compact onClick={() => void refresh()}>{t('bots.memory.useLatest')}</Button>
    </div> : null}
    {loading ? <Spinner size={18} /> : null}
    {items.length > 0 ? <ul className="divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      {items.map((schedule) => {
        const { frequency, when } = timing(schedule);
        const expired = schedule.status === 'expired';
        return <li key={schedule.id} className="flex items-center gap-1 pr-4">
          <button type="button" onClick={() => void open(`/cc-agent/scheduled?focus=${encodeURIComponent(schedule.id)}`)}
            className="flex min-h-14 min-w-0 flex-1 items-center gap-2 py-3 pl-4 text-left outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]">
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-14 ${schedule.status === 'active' ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>{schedule.companionFollowUpAt === undefined ? schedule.name : t('bots.automations.followUp.entry', { topic: schedule.prompt })}</span>
              <span className="mt-0.5 block truncate text-12 text-[var(--text-secondary)]">{frequency}</span>
              {when ? <span className="mt-0.5 block truncate text-12 tabular-nums text-[var(--text-tertiary)]">{when}</span> : null}
            </span>
            <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
          </button>
          <Switch aria-label={t('bots.automations.toggle', { name: schedule.name })} checked={schedule.status === 'active'}
            disabled={expired || pending !== null || (schedule.companionFollowUpAt !== undefined && schedule.status === 'paused')} onCheckedChange={(value) => void toggle(schedule, value === true)} />
        </li>;
      })}
    </ul> : !loading && !error ? <p className="py-3 text-13 text-[var(--text-tertiary)]">{t('bots.automations.empty', { name: bot.name })}</p> : null}
    {workspace ? <Button variant="secondary" onClick={() => void open(`/cc-agent/scheduled?workingDir=${encodeURIComponent(workspace)}`)}>
      {items.length ? null : <Plus size={16} />}{t(items.length ? 'bots.automations.manage' : 'bots.automations.create')}
    </Button> : null}
  </div>;
}
