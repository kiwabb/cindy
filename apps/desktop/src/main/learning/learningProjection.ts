/**
 * Pure projection of the tutor's goal files (written by its state script, treated as untrusted
 * input) into the whitelisted `LearningGoal` the renderer sees. Mastery follows the tutor's own
 * policy: memory / procedure points clear at a mastery level of 0.9, concept / design points on a
 * recorded qualitative pass, required visual tasks must be verified, and a learner's own claim
 * counts but is shown apart. Nothing here guesses data the tutor did not write.
 */
import type {
  LearningCheckLimit,
  LearningDailyPlan,
  LearningGoal,
  LearningModule,
  LearningOpenQuestion,
  LearningPlanSegmentKind,
  LearningPoint,
  LearningPointType,
  LearningReview,
} from '../../shared/learning.js';

type Json = Record<string, unknown>;

const QUANTITATIVE_GATE = 0.9;
const QUALITATIVE_TYPES = new Set(['concept', 'design']);
const POINT_TYPES = new Set<LearningPointType>(['memory', 'concept', 'procedure', 'design']);
const CHECK_LIMITS = new Set<LearningCheckLimit>(['audio', 'speech']);
const PLAN_KINDS: Record<string, LearningPlanSegmentKind> = {
  recap: 'recap',
  review: 'recap',
  explain: 'explain',
  practice: 'practice',
  'wrap-up': 'wrap-up',
  wrap_up: 'wrap-up',
  summary: 'wrap-up',
};
const MAX_TEXT = 4000;

const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown, max = MAX_TEXT): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
/** The tutor writes Python `time.time()` seconds. */
const ms = (seconds: unknown): number | null => {
  const value = num(seconds);
  return value === null || value <= 0 ? null : Math.round(value * 1000);
};

function localDayBounds(now: Date): { start: number; end: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return { start, end };
}

function visualAchievements(progress: Json, pointId: string): Set<string> {
  const done = new Set<string>();
  for (const raw of arr(progress.learning_evidence)) {
    const event = obj(raw);
    const visual = obj(event.visual_context);
    if (
      event.knowledge_point_id === pointId &&
      event.result === 'correct' &&
      !num(event.hints_used) &&
      visual.key_status === 'verified' &&
      typeof visual.task === 'string'
    )
      done.add(visual.task);
  }
  return done;
}

function assessedMastered(progress: Json, point: Json, type: string): boolean {
  const id = str(point.id);
  const required = arr(point.required_visual_tasks).filter((t): t is string => typeof t === 'string');
  if (required.length) {
    const achieved = visualAchievements(progress, id);
    if (!required.every((task) => achieved.has(task))) return false;
  }
  if (QUALITATIVE_TYPES.has(type)) return obj(progress.qualitative_mastery)[id] === true;
  return (num(obj(progress.mastery_levels)[id]) ?? 0) >= QUANTITATIVE_GATE;
}

function dailyPlan(progress: Json): LearningDailyPlan | null {
  const plan = obj(progress.daily_plan);
  const minutes = num(plan.minutes);
  if (minutes === null || minutes <= 0 || minutes > 24 * 60) return null;
  const segments = arr(plan.segments).flatMap((raw) => {
    const segment = obj(raw);
    const kind = PLAN_KINDS[str(segment.kind, 32)];
    const length = num(segment.minutes);
    return kind && length !== null && length > 0 && length <= minutes ? [{ kind, minutes: length }] : [];
  });
  return { minutes, segments };
}

/** A point's name up to its first full-width colon: the tutor writes "short name：details". */
export function shortPointName(name: string): string {
  const cut = name.search(/[：:]/);
  return cut > 0 ? name.slice(0, cut) : name;
}

export interface LearningGoalFiles {
  botId: string;
  topic: unknown;
  progress: unknown;
  /** Parsed `agreement.json`, or null when the outline has not been agreed. */
  agreement: unknown;
  /** Bound conversations, most recent first. */
  sessionIds: string[];
}

/** Null when the files do not describe a goal (no path id). */
export function projectLearningGoal(files: LearningGoalFiles, now = new Date()): LearningGoal | null {
  const topic = obj(files.topic);
  const meta = obj(topic.metadata);
  const progress = obj(files.progress);
  const id = str(meta.path_id, 128) || str(progress.book_id, 128);
  if (!id) return null;

  const overrides = obj(progress.learner_mastery_overrides);
  const deferred = obj(progress.deferred_objectives);
  const explained = obj(progress.explained_objectives);
  const qualitative = obj(progress.qualitative_mastery);
  const attempted = new Set(
    arr(progress.quiz_attempts).map((raw) => str(obj(raw).knowledge_point_id, 256)),
  );
  const pending = obj(progress.pending_question);
  const pendingPoint = str(pending.knowledge_point_id, 256);

  const modules: LearningModule[] = arr(progress.modules)
    .map(obj)
    .sort((a, b) => (num(a.order) ?? 0) - (num(b.order) ?? 0))
    .map((module) => ({
      id: str(module.id, 256),
      name: str(module.name, 300),
      points: arr(module.knowledge_points)
        .map(obj)
        .filter((point) => str(point.id, 256))
        .map((point): LearningPoint => {
          const pointId = str(point.id, 256);
          const rawType = str(point.type, 32);
          const type = POINT_TYPES.has(rawType as LearningPointType)
            ? (rawType as LearningPointType)
            : 'other';
          const state = assessedMastered(progress, point, rawType)
            ? 'mastered'
            : pointId in overrides
              ? 'self-reported'
              : pointId in deferred
                ? 'deferred'
                : pointId === pendingPoint ||
                    attempted.has(pointId) ||
                    pointId in qualitative ||
                    pointId in explained
                  ? 'in-progress'
                  : 'not-started';
          const checkLimits = [
            ...new Set(
              arr(point.assessment_limits).filter((limit): limit is LearningCheckLimit =>
                CHECK_LIMITS.has(limit as LearningCheckLimit),
              ),
            ),
          ];
          return { id: pointId, name: str(point.name, 600), type, state, checkLimits };
        }),
    }))
    .filter((module) => module.id);

  const points = modules.flatMap((module) =>
    module.points.map((point) => ({ module, point })),
  );
  const cleared = (point: LearningPoint) =>
    point.state === 'mastered' || point.state === 'self-reported';
  const currentEntry =
    (pendingPoint && points.find(({ point }) => point.id === pendingPoint)) ||
    points.find(({ point }) => !cleared(point) && point.state !== 'deferred') ||
    null;
  const pointNames = new Map(points.map(({ point }) => [point.id, point.name]));

  const openQuestion: LearningOpenQuestion | null =
    pendingPoint && str(pending.prompt)
      ? {
          pointId: pendingPoint,
          prompt: str(pending.prompt),
          options: arr(pending.options)
            .map(obj)
            .map((option) => ({ label: str(option.label, 16), body: str(option.body, 600) }))
            .filter((option) => option.body),
        }
      : null;

  const clearedIds = new Set(points.filter(({ point }) => cleared(point)).map(({ point }) => point.id));
  const reviews: LearningReview[] = arr(progress.review_queue)
    .map(obj)
    .flatMap((task) => {
      const pointId = str(task.knowledge_point_id, 256);
      const dueAt = ms(task.due_at);
      if (!clearedIds.has(pointId) || dueAt === null) return [];
      return [
        {
          pointId,
          pointName: shortPointName(pointNames.get(pointId) ?? ''),
          dueAt,
          reviewCount: Math.max(0, Math.floor(num(obj(task.state).review_count) ?? 0)),
        },
      ];
    })
    .sort((a, b) => a.dueAt - b.dueAt);

  const { start, end } = localDayBounds(now);
  let attempts = 0;
  let correct = 0;
  for (const raw of arr(progress.quiz_attempts)) {
    const attempt = obj(raw);
    const at = ms(attempt.timestamp);
    if (attempt.voided === true || at === null || at < start || at >= end) continue;
    attempts += 1;
    if (attempt.is_correct === true) correct += 1;
  }

  const profile = obj(progress.learner_profile);
  const activity = [ms(progress.updated_at), ms(meta.updated_at)].filter(
    (value): value is number => value !== null,
  );
  return {
    id,
    botId: files.botId,
    name: str(progress.name, 300) || modules[0]?.name || str(meta.goal, 300) || id,
    quote: str(meta.goal, 2000),
    status: meta.status === 'archived' ? 'archived' : 'active',
    outlineAgreed: files.agreement !== null && typeof files.agreement === 'object',
    modules,
    masteredCount: clearedIds.size,
    totalCount: points.length,
    current: currentEntry ? { moduleId: currentEntry.module.id, pointId: currentEntry.point.id } : null,
    step: currentEntry ? (openQuestion ? 'practice' : 'explain') : null,
    openQuestion,
    profile: {
      priorKnowledge: str(profile.prior_knowledge),
      targetLevel: str(profile.target_level),
      timeBudget: str(profile.time_budget),
      preferences: str(profile.preferences),
    },
    reviews,
    dailyPlan: dailyPlan(progress),
    lastActivityAt: activity.length ? Math.max(...activity) : null,
    today: { attempts, correct },
    sessionIds: files.sessionIds,
  };
}
