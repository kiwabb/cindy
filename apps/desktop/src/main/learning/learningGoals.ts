/**
 * Read-only access to learning goals kept by tutor teammates on this computer.
 *
 * The tutor's state script owns `<teammate home>/workspace/goals/` (`sessions.json` binds
 * conversations to goals; one folder per goal holds `topic.json`, `progress.json` and, once the
 * outline is agreed, `agreement.json`). Cindy never writes there. The files are untrusted input
 * that a running task may be rewriting at this moment, so every read refuses symbolic links and
 * oversized files, and a file that fails to parse (half written) keeps the goal's last good
 * reading instead of making the goal disappear.
 */
import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LearningSessionBinding, LearningSnapshot } from '../../shared/learning.js';
import { projectLearningGoal } from './learningProjection.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const GOAL_FILES = ['topic.json', 'progress.json', 'agreement.json'] as const;

class SkipFile extends Error {}

/** Parsed JSON of a regular file (never a link); null when it does not exist. */
async function readJson(file: string): Promise<{ value: unknown } | null> {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new SkipFile();
  const text = await fs.readFile(file, 'utf8');
  return { value: JSON.parse(text) as unknown };
}

async function plainDir(dir: string): Promise<boolean> {
  try {
    return (await fs.lstat(dir)).isDirectory();
  } catch {
    return false;
  }
}

interface GoalReading {
  topic: unknown;
  progress: unknown;
  agreement: unknown;
}

export interface LearningGoalsReader {
  /** Every goal of every teammate under `botsRoot()`, projected for the renderer. */
  snapshot(now?: Date): Promise<LearningSnapshot>;
  /** The goal folders found by the last snapshot (for watching). */
  goalRoots(): string[];
}

export function createLearningGoalsReader(botsRoot: () => string): LearningGoalsReader {
  const lastGood = new Map<string, GoalReading>();
  let roots: string[] = [];

  async function readGoal(dir: string): Promise<GoalReading | null> {
    const previous = lastGood.get(dir);
    try {
      const [topic, progress, agreement] = await Promise.all(
        GOAL_FILES.map((name) => readJson(path.join(dir, name))),
      );
      if (!topic || !progress) return previous ?? null;
      const reading = {
        topic: topic.value,
        progress: progress.value,
        agreement: agreement?.value ?? null,
      };
      lastGood.set(dir, reading);
      return reading;
    } catch {
      // Half-written JSON, a symbolic link or an oversized file: keep what we last saw.
      return previous ?? null;
    }
  }

  async function readBindings(goalsDir: string): Promise<Map<string, Array<{ sessionId: string; at: number }>>> {
    const byGoal = new Map<string, Array<{ sessionId: string; at: number }>>();
    let file;
    try {
      file = await readJson(path.join(goalsDir, 'sessions.json'));
    } catch {
      return byGoal;
    }
    const raw = file?.value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return byGoal;
    for (const [sessionId, entry] of Object.entries(raw as Record<string, unknown>)) {
      const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
      const goalId = record.path_id;
      if (!ID.test(sessionId) || typeof goalId !== 'string' || !ID.test(goalId)) continue;
      const at = typeof record.bound_at === 'number' ? record.bound_at : 0;
      byGoal.set(goalId, [...(byGoal.get(goalId) ?? []), { sessionId, at }]);
    }
    return byGoal;
  }

  return {
    goalRoots: () => roots,
    async snapshot(now = new Date()) {
      const root = botsRoot();
      const goals: LearningSnapshot['goals'] = [];
      const bindings: Record<string, LearningSessionBinding> = {};
      const seen = new Set<string>();
      const found: string[] = [];
      let bots: string[] = [];
      try {
        bots = (await fs.readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && ID.test(entry.name))
          .map((entry) => entry.name);
      } catch {
        bots = [];
      }
      for (const botId of bots) {
        const workspace = path.join(root, botId, 'workspace');
        const goalsDir = path.join(workspace, 'goals');
        if (!(await plainDir(workspace)) || !(await plainDir(goalsDir))) continue;
        found.push(goalsDir);
        const bound = await readBindings(goalsDir);
        let entries;
        try {
          entries = await fs.readdir(goalsDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || !ID.test(entry.name)) continue;
          const dir = path.join(goalsDir, entry.name);
          seen.add(dir);
          const reading = await readGoal(dir);
          if (!reading) continue;
          const sessions = (bound.get(entry.name) ?? []).sort((a, b) => b.at - a.at);
          const goal = projectLearningGoal(
            { botId, ...reading, sessionIds: sessions.map((s) => s.sessionId) },
            now,
          );
          // A folder only counts under the id it is stored as; a mismatching file is not trusted.
          if (!goal || goal.id !== entry.name) continue;
          goals.push(goal);
          if (goal.status === 'active')
            for (const { sessionId } of sessions) bindings[sessionId] ??= { goalId: goal.id, botId };
        }
      }
      for (const dir of lastGood.keys()) if (!seen.has(dir)) lastGood.delete(dir);
      roots = found;
      goals.sort(
        (a, b) =>
          Number(a.status === 'archived') - Number(b.status === 'archived') ||
          (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
      );
      return { goals, bindings, readAt: now.getTime() };
    },
  };
}

/**
 * Watches the goal folders found so far and calls `onChange` (debounced) after any file in them
 * changes. `sync` is called after each snapshot so new teammates' folders are picked up.
 */
export function createLearningGoalsWatcher(onChange: () => void, debounceMs = 400) {
  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };
  return {
    sync(dirs: readonly string[]) {
      for (const [dir, watcher] of watchers)
        if (!dirs.includes(dir)) {
          watcher.close();
          watchers.delete(dir);
        }
      for (const dir of dirs) {
        if (watchers.has(dir)) continue;
        try {
          const watcher = watch(dir, { recursive: true, persistent: false }, fire);
          watcher.on('error', () => {
            watcher.close();
            watchers.delete(dir);
          });
          watchers.set(dir, watcher);
        } catch {
          // Without a watcher the page still refreshes when it is opened or refocused.
        }
      }
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
