/**
 * 测试价值
 * - 生产入口与可观察结果：createLearningGoalsReader().snapshot() —— 学习页与「今天」页签看到的目标、
 *   知识点状态、当前位置、开着的题、复习与对话绑定。
 * - Bug／规则依据：设计简报 2026-11-12 §三（只读、容忍写了一半的文件、不跟随符号链接）与 §四/§五
 *   的五种状态；掌握判定沿用导师状态脚本的口径（procedure 0.9、学习者自述单列）。
 * - 现有覆盖缺口：新模块，无相邻覆盖。
 * - 最小失败输入：progress.json 被写成半截 JSON；开着的题带 expected_answer；已归档目标仍在
 *   sessions.json 里。
 * - tier：unit（mkdtemp 临时目录、进程内调用）。
 * - 实测耗时：本机单独运行 2.4 s（vitest Duration，用例 39 ms）。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLearningGoalsReader } from '../learningGoals';

const NOW = new Date(2026, 10, 13, 15, 0, 0);
const sec = (date: Date) => date.getTime() / 1000;

let root: string;
let goalsDir: string;

const point = (id: string, type = 'procedure', extra: Record<string, unknown> = {}) => ({
  id,
  name: `${id} 名称：细节`,
  type,
  required_visual_tasks: [],
  ...extra,
});

const progress = {
  book_id: 'topic_a',
  name: '示例目标',
  learner_profile: {
    prior_knowledge: '基础',
    target_level: '目标',
    time_budget: '每天约20分钟',
    preferences: '偏好',
  },
  modules: [
    {
      id: 'm1',
      name: '模块二',
      order: 1,
      knowledge_points: [point('k4'), point('k5', 'procedure', { assessment_limits: ['audio', 'bogus'] })],
    },
    {
      id: 'm0',
      name: '模块一',
      order: 0,
      knowledge_points: [point('k0'), point('k1'), point('k2', 'concept'), point('k3')],
    },
  ],
  mastery_levels: { k0: 1.0, k1: 0.5 },
  qualitative_mastery: {},
  learner_mastery_overrides: { k2: { knowledge_point_id: 'k2' } },
  deferred_objectives: { k4: { knowledge_point_id: 'k4' } },
  quiz_attempts: [
    { knowledge_point_id: 'k0', is_correct: true, timestamp: sec(new Date(2026, 10, 13, 9)) },
    { knowledge_point_id: 'k1', is_correct: false, timestamp: sec(new Date(2026, 10, 13, 10)) },
    { knowledge_point_id: 'k1', is_correct: true, timestamp: sec(new Date(2026, 10, 12, 10)) },
  ],
  review_queue: [
    { knowledge_point_id: 'k0', due_at: sec(new Date(2026, 10, 18)), state: { review_count: 3 } },
    { knowledge_point_id: 'k1', due_at: sec(new Date(2026, 10, 14)), state: { review_count: 1 } },
  ],
  pending_question: {
    knowledge_point_id: 'k1',
    prompt: '说说这句话的意思',
    options: [],
    expected_answer: 'SECRET-ANSWER',
    explanation: 'SECRET-EXPLANATION',
  },
  updated_at: sec(new Date(2026, 10, 13, 10)),
};

async function writeGoal(id: string, status: string, body: unknown) {
  const dir = path.join(goalsDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'topic.json'),
    JSON.stringify({ metadata: { path_id: id, goal: `我想学${id}`, status, emoji: 'X' } }),
  );
  await writeFile(path.join(dir, 'progress.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cindy-learning-'));
  goalsDir = path.join(root, 'bot_tutor', 'workspace', 'goals');
  await writeGoal('topic_a', 'active', progress);
  await writeGoal('topic_old', 'archived', { ...progress, book_id: 'topic_old', name: '旧目标', pending_question: null });
  await writeFile(
    path.join(goalsDir, 'sessions.json'),
    JSON.stringify({
      'session-a': { path_id: 'topic_a', mode: 'study', bound_at: 2 },
      'session-old': { path_id: 'topic_old', mode: 'study', bound_at: 1 },
    }),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('learning goals reader', () => {
  it('projects outline states, the current point and today without leaking answers', async () => {
    const reader = createLearningGoalsReader(() => root);
    const snapshot = await reader.snapshot(NOW);

    expect(snapshot.goals.map((goal) => [goal.id, goal.status])).toEqual([
      ['topic_a', 'active'],
      ['topic_old', 'archived'],
    ]);
    // Archived goals are listed but bind no conversation.
    expect(snapshot.bindings).toEqual({ 'session-a': { goalId: 'topic_a', botId: 'bot_tutor' } });

    const goal = snapshot.goals[0]!;
    expect(goal.modules.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(goal.modules.flatMap((m) => m.points.map((p) => [p.id, p.state]))).toEqual([
      ['k0', 'mastered'],
      ['k1', 'in-progress'],
      ['k2', 'self-reported'],
      ['k3', 'not-started'],
      ['k4', 'deferred'],
      ['k5', 'not-started'],
    ]);
    expect(goal.modules[1]!.points[1]!.checkLimits).toEqual(['audio']);
    expect([goal.masteredCount, goal.totalCount]).toEqual([2, 6]);
    expect(goal.current).toEqual({ moduleId: 'm0', pointId: 'k1' });
    expect(goal.step).toBe('practice');
    expect(goal.outlineAgreed).toBe(false);
    expect(goal.today).toEqual({ attempts: 2, correct: 1 });
    // Only cleared points have reviews; the open question carries no answer.
    expect(goal.reviews.map((r) => [r.pointId, r.pointName, r.reviewCount])).toEqual([['k0', 'k0 名称', 3]]);
    expect(goal.dailyPlan).toBeNull();
    expect(JSON.stringify(snapshot)).not.toMatch(/SECRET|emoji/);
  });

  it('keeps the last good reading while a file is half written', async () => {
    const reader = createLearningGoalsReader(() => root);
    const first = await reader.snapshot(NOW);
    await writeFile(path.join(goalsDir, 'topic_a', 'progress.json'), '{"book_id": "topic_a", "modu');
    const during = await reader.snapshot(NOW);
    expect(during.goals.map((goal) => goal.id)).toEqual(first.goals.map((goal) => goal.id));
    expect(during.goals[0]!.current).toEqual(first.goals[0]!.current);

    // A fresh reader that never saw a good copy leaves the goal out instead of failing the page.
    const fresh = await createLearningGoalsReader(() => root).snapshot(NOW);
    expect(fresh.goals.map((goal) => goal.id)).toEqual(['topic_old']);
    await writeFile(path.join(goalsDir, 'topic_a', 'progress.json'), JSON.stringify(progress));
  });
});
