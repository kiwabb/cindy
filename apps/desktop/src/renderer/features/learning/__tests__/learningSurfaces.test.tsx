// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：学习页 LearningView（/bots/learning）与导师对话右侧「今天」页签的正文
 *   LearningTodayTabBody。主人看到今天学什么、开着的题、大纲与已归档；点「去学习」进入绑定的对话；
 *   页签只在本机且绑定了进行中目标的对话里显示，快捷话只写进这场对话的输入框。
 * - Bug／规则依据：设计简报 2026-11-12 §四/§五 与定稿原型（「换一道题」没有题时置灰；远程或归属未定的
 *   对话不显示；页面不出题作答、不发消息）。
 * - 现有覆盖缺口：主进程投影有 learningGoals.test.ts；界面如何按绑定、归属与题目状态呈现没有覆盖。
 * - 最小失败输入：一个进行中目标（有题开着）与一个已归档目标；同一会话分别以本机、远程、未绑定打开。
 * - tier：unit（jsdom，IPC 与路由解析用内存 fake）。
 * - 实测耗时：本机单独运行 6.2 s（vitest Duration，其中 jsdom 环境与全局 setup 约 4 s，收集 0.9 s，用例 0.4 s）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { LearningGoal, LearningSnapshot } from '../../../../shared/learning';

const h = vi.hoisted(() => ({ insert: vi.fn(() => true) }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).map(String).join('|')}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalDataOwnerGeneration: () => 1 }));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => [{ id: 'bot_tutor', name: '导师' }] }));
vi.mock('@/lib/orcaSessionIdentity', () => ({
  resolveSessionRoute: async (sessionId: string) => `/bots/bot_tutor/session/${sessionId}`,
}));
vi.mock('@/lib/composerActionsBus', () => ({ insertPromptIntoComposer: h.insert }));

const { LearningView } = await import('../LearningView');
const { LearningTodayTabBody } = await import('../LearningTodayTab');

const goal = (patch: Partial<LearningGoal>): LearningGoal => ({
  id: 'topic_en',
  botId: 'bot_tutor',
  name: '英语',
  quote: '我想学英语',
  status: 'active',
  outlineAgreed: false,
  modules: [
    {
      id: 'm0',
      name: '读懂技术解释',
      points: [
        { id: 'k0', name: '关键词块', type: 'procedure', state: 'mastered', checkLimits: [] },
        { id: 'k1', name: '拆句子', type: 'procedure', state: 'in-progress', checkLimits: [] },
      ],
    },
    {
      id: 'm1',
      name: '听懂讲解',
      points: [{ id: 'k2', name: '听辨', type: 'procedure', state: 'not-started', checkLimits: ['audio'] }],
    },
  ],
  masteredCount: 1,
  totalCount: 3,
  current: { moduleId: 'm0', pointId: 'k1' },
  step: 'practice',
  openQuestion: { pointId: 'k1', prompt: 'The model does not use new data.', options: [] },
  profile: { priorKnowledge: '基础弱', targetLevel: '', timeBudget: '每天20分钟', preferences: '' },
  reviews: [{ pointId: 'k0', pointName: '关键词块', dueAt: Date.now() + 5 * 86_400_000, reviewCount: 3 }],
  dailyPlan: null,
  lastActivityAt: Date.now(),
  today: { attempts: 3, correct: 2 },
  sessionIds: ['session-en'],
  ...patch,
});

let snapshot: LearningSnapshot;

function Location() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

const tabCtx = (sessionId: string, deviceLinkDeviceId: string | null | undefined) => ({
  tabId: 't1',
  sessionId,
  workdir: '',
  remoteHostId: null,
  deviceLinkDeviceId,
  patchState: () => undefined,
  onVisibilityChange: () => undefined,
  setCloseInterceptor: () => () => undefined,
});

beforeEach(() => {
  setDataOwnerGeneration('test-owner', 1);
  h.insert.mockClear();
  snapshot = {
    goals: [goal({}), goal({ id: 'topic_old', name: '旧目标', status: 'archived', sessionIds: [] })],
    bindings: { 'session-en': { goalId: 'topic_en', botId: 'bot_tutor' } },
    readAt: Date.now(),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: { learning: { snapshot: vi.fn(async () => snapshot), onChanged: () => () => undefined } },
  };
});
afterEach(() => cleanup());

describe('Learning page', () => {
  it('shows today, the goal outline and archived goals, and opens the bound conversation', async () => {
    render(
      <MemoryRouter initialEntries={['/bots/learning']}>
        <Routes>
          <Route path="/bots/learning" element={<LearningView />} />
          <Route path="*" element={<Location />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('learning.stepAt:learning.step.practice')).toBeTruthy();
    expect(screen.getByText('learning.outlineDraft')).toBeTruthy();
    expect(screen.getByText('learning.checkLimit.audio')).toBeTruthy();
    expect(screen.queryByText('旧目标')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /learning\.archived/ }));
    expect(screen.getByText('旧目标')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'learning.goStudy' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/bots/bot_tutor/session/session-en'),
    );
  });
});

describe('Today tab', () => {
  it('shows the bound goal here and only prefills this conversation', async () => {
    render(<LearningTodayTabBody state={{}} ctx={tabCtx('session-en', null)} />);
    expect(await screen.findByText('The model does not use new data.')).toBeTruthy();
    expect(screen.getAllByText('拆句子')).toHaveLength(2); // current point and outline
    fireEvent.click(screen.getByRole('button', { name: 'learning.tab.continue' }));
    expect(h.insert).toHaveBeenCalledWith({ targetSessionId: 'session-en', text: 'learning.tab.say.continue' });
    expect(screen.getByRole('button', { name: 'learning.tab.anotherQuestion' }).hasAttribute('disabled')).toBe(false);
  });

  it('disables another question without an open one, and shows nothing for remote or unbound conversations', async () => {
    snapshot.goals[0] = goal({ openQuestion: null, step: 'explain' });
    const view = render(<LearningTodayTabBody state={{}} ctx={tabCtx('session-en', null)} />);
    expect((await screen.findByRole('button', { name: 'learning.tab.anotherQuestion' })).hasAttribute('disabled')).toBe(true);
    view.rerender(<LearningTodayTabBody state={{}} ctx={tabCtx('session-en', 'device-2')} />);
    expect(screen.getByText('learning.tab.localOnly')).toBeTruthy();
    view.rerender(<LearningTodayTabBody state={{}} ctx={tabCtx('session-en', undefined)} />);
    expect(screen.queryByText('拆句子')).toBeNull();
    await act(async () => view.rerender(<LearningTodayTabBody state={{}} ctx={tabCtx('session-other', null)} />));
    expect(screen.getByText('learning.tab.unbound')).toBeTruthy();
  });
});
