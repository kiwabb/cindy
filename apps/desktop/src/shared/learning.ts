/**
 * Learning goals as the desktop shows them (Learning page, the Today tab beside a tutor
 * conversation). Main reads the tutor teammate's goal files read-only and projects them to this
 * shape; answers, explanations, source file paths and the goal emoji never leave main.
 */

/** 未开始 / 进行中 / 已掌握 / 已暂缓 / 自述掌握. */
export type LearningPointState =
  | 'not-started'
  | 'in-progress'
  | 'mastered'
  | 'deferred'
  | 'self-reported';

export type LearningPointType = 'memory' | 'concept' | 'procedure' | 'design' | 'other';

/** Why the tutor cannot check a point yet (written by the tutor as `assessment_limits`). */
export type LearningCheckLimit = 'audio' | 'speech';

export interface LearningPoint {
  id: string;
  name: string;
  type: LearningPointType;
  state: LearningPointState;
  checkLimits: LearningCheckLimit[];
}

export interface LearningModule {
  id: string;
  name: string;
  points: LearningPoint[];
}

export interface LearningReview {
  pointId: string;
  pointName: string;
  /** Epoch ms. */
  dueAt: number;
  reviewCount: number;
}

/** The question waiting for the learner's answer: the prompt and choices only, never the answer. */
export interface LearningOpenQuestion {
  pointId: string;
  prompt: string;
  options: Array<{ label: string; body: string }>;
}

export type LearningPlanSegmentKind = 'recap' | 'explain' | 'practice' | 'wrap-up';

/** The day's time split, present only when the tutor writes `daily_plan`. */
export interface LearningDailyPlan {
  minutes: number;
  segments: Array<{ kind: LearningPlanSegmentKind; minutes: number }>;
}

export interface LearningProfile {
  priorKnowledge: string;
  targetLevel: string;
  timeBudget: string;
  preferences: string;
}

export interface LearningGoal {
  /** The tutor's path id (`topic_…`). */
  id: string;
  /** The teammate whose project holds the goal. */
  botId: string;
  name: string;
  /** The learner's own words when the goal was set. */
  quote: string;
  status: 'active' | 'archived';
  /** The outline was agreed with the learner (`agreement.json`). */
  outlineAgreed: boolean;
  modules: LearningModule[];
  masteredCount: number;
  totalCount: number;
  /** The point being learned now: the open question's point, else the first one not yet cleared. */
  current: { moduleId: string; pointId: string } | null;
  /** How far the current point has got: practising while a question is open, otherwise explaining. */
  step: 'practice' | 'explain' | null;
  openQuestion: LearningOpenQuestion | null;
  profile: LearningProfile;
  /** Scheduled reviews of cleared points, earliest first. */
  reviews: LearningReview[];
  dailyPlan: LearningDailyPlan | null;
  /** Epoch ms of the last recorded change. */
  lastActivityAt: number | null;
  /** Answers recorded today (local day of the reading computer), and how many were right. */
  today: { attempts: number; correct: number };
  /** Conversations (Session ids) bound to this goal, most recently bound first. */
  sessionIds: string[];
}

export interface LearningSessionBinding {
  goalId: string;
  botId: string;
}

export interface LearningSnapshot {
  goals: LearningGoal[];
  /** Session id → the active goal it is bound to. Archived goals bind nothing. */
  bindings: Record<string, LearningSessionBinding>;
  /** Epoch ms. */
  readAt: number;
}

export const LEARNING_SNAPSHOT_CHANNEL = 'learning:snapshot';
export const LEARNING_CHANGED_CHANNEL = 'learning:changed';
