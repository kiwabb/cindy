// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotAutomationsSettings } from '../BotAutomationsSettings';

const { useSchedules, refresh, create, t } = vi.hoisted(() => ({
  useSchedules: vi.fn(),
  refresh: vi.fn(),
  create: vi.fn(),
  t: (key: string, vars?: { topic?: string }) => vars?.topic ? `${key} ${vars.topic}` : key,
}));
vi.mock('../../scheduler/hooks/useSchedules', () => ({ useSchedules }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'zh-CN' } }) }));
vi.mock('../botPronounContext', () => ({ useBotTranslation: () => ({ t }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('creates exactly one Shanghai-time follow-up from the native settings, then refreshes the list', async () => {
  const bot = { id: 'bot-fixture', name: 'Companion', homeDir: '/data/owners/owner-fixture/bots/bot-fixture' };
  useSchedules.mockReturnValue({ schedules: [], loading: false, error: null, refresh });
  vi.stubGlobal('electronAPI', { maker: { schedule: { createCompanionFollowUp: create } } });
  create.mockResolvedValue(undefined);
  const view = render(<BotAutomationsSettings bot={bot} />);
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.automations.followUp.title' }));
  fireEvent.change(screen.getByLabelText('bots.automations.followUp.topic'), { target: { value: 'Check in on the reading plan' } });
  fireEvent.change(screen.getByLabelText('bots.automations.followUp.time'), { target: { value: '2026-11-21T15:30' } });
  fireEvent.click(screen.getByRole('button', { name: 'bots.automations.followUp.save' }));
  const dueAt = Date.parse('2026-11-21T07:30:00Z');
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledExactlyOnceWith({ botId: bot.id, topic: 'Check in on the reading plan', dueAt });

  useSchedules.mockReturnValue({ loading: false, error: null, refresh, schedules: [{
    id: 'follow-up-fixture', name: 'Chat follow-up', prompt: 'Check in on the reading plan',
    workingDir: `${bot.homeDir}/workspace`, workspaceKind: 'project', status: 'active',
    companionFollowUpAt: dueAt, nextFireAt: dueAt, recurring: false,
  }] });
  view.rerender(<BotAutomationsSettings bot={bot} />);
  expect(screen.getByText('bots.automations.followUp.entry Check in on the reading plan')).toBeTruthy();
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
});

it('saves greeting and sharing independently from an initially disabled state', async () => {
  useSchedules.mockReturnValue({ schedules: [], loading: false, error: null, refresh });
  const settings = {
    greeting: false, sharing: false, paused: false, homeChanged: false, canEdit: true,
  };
  const companionAutonomous = vi.fn(async (input: { update?: Partial<typeof settings> }) =>
    ({ ...Object.assign(settings, input.update) }));
  vi.stubGlobal('electronAPI', { maker: { schedule: { companionAutonomous } } });
  render(<BotAutomationsSettings bot={{ id: 'bot-fixture', name: 'Companion' }} />);

  const greeting = await screen.findByRole('switch', { name: 'bots.automations.autonomous.greeting' });
  const sharing = screen.getByRole('switch', { name: 'bots.automations.autonomous.sharing' });
  expect(greeting.getAttribute('aria-checked')).toBe('false');
  expect(sharing.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(greeting);
  await waitFor(() => expect(greeting.getAttribute('aria-checked')).toBe('true'));
  expect(companionAutonomous).toHaveBeenLastCalledWith({ botId: 'bot-fixture', update: { greeting: true } });
  expect(sharing.getAttribute('aria-checked')).toBe('false');
});
