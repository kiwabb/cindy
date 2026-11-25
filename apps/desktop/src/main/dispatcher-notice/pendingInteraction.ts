/**
 * 挂起交互 → 通知需要的最小内容（纯函数）。只取问题原文、选项标签、权限的工具或操作名；
 * 不带工具参数、计划正文与代输入的值。
 */
import type { PendingInteraction } from './core.js';

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** 挂起交互 → 通知需要的最小内容。不带工具参数、计划正文与代输入的值。 */
export function toPendingInteraction(raw: unknown): PendingInteraction | null {
  const request = record(record(raw)?.request ?? raw);
  const id = text(request?.requestId);
  if (!request || !id) return null;
  switch (request.kind) {
    case 'ask_user_question': {
      const questions = (Array.isArray(request.questions) ? request.questions : []).flatMap(item => {
        const q = record(item);
        const question = text(q?.question) ?? text(q?.header);
        if (!question) return [];
        const options = (Array.isArray(q?.options) ? q!.options as unknown[] : [])
          .flatMap(option => { const label = text(record(option)?.label); return label ? [label] : []; });
        const id = text(q?.id);
        const choices = record(q?.answerConstraints)?.choices;
        return [{ question, options,
          ...(id ? { id } : {}),
          ...(q?.multiSelect === true ? { multiSelect: true } : {}),
          ...(Array.isArray(choices) && choices.every(c => typeof c === 'string') ? { choices: choices as string[] } : {}) }];
      });
      return { id, kind: 'question', questions };
    }
    case 'plan_review':
      return { id, kind: 'plan' };
    case 'permission': {
      const title = text(request.title) ?? text(request.displayName) ?? text(request.toolName);
      return title ? { id, kind: 'permission', title } : { id, kind: 'permission' };
    }
    default:
      return { id, kind: 'other' };
  }
}
