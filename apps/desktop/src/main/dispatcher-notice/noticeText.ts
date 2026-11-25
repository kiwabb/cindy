/**
 * 派发方通知的正文（纯函数）。正文发给派发方的模型，也显示在派发方对话里，所以要短、可直接转述。
 * 不带工具参数、计划全文和代输入的值；权限类只写工具或操作名。
 */
import type { Notice } from './core.js';

export const LIMITS = {
  title: 120,
  result: 300,
  error: 300,
  question: 500,
  option: 120,
  waitingTotal: 1500,
} as const;

export type NoticeLanguage = 'zh' | 'en';

export interface NoticeContext {
  title: string;
  lang: NoticeLanguage;
  /** 宿主会把派发方下一条发给任务的消息当作回答（本机派发方）；否则只请用户到任务里作答。 */
  replyAnswers?: boolean;
}

export function clip(text: string, max: number): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(compact);
  return chars.length <= max ? compact : `${chars.slice(0, max - 1).join('')}…`;
}

const STRINGS = {
  zh: {
    header: '[任务状态通知 · Cindy 宿主发出，不是用户输入，也不代表用户授权]',
    task: (title: string, id: string) => `任务「${title}」(${id})`,
    done: '已完成。',
    error: '出错停下了。',
    interrupted: '在 Cindy 退出或重启时被打断，宿主没有自动接着做。',
    dispatchFailed: '没能开始处理你发去的消息。',
    resolved: '之前等待的问题或审批已由用户在任务里处理，无需再转述。',
    waitingQuestion: '停下来等回答，请向用户转述下面的问题和选项：',
    waitingPlan: '在等用户确认计划。计划内容请打开任务查看。',
    waitingPermission: (name: string) => `在等用户批准：${name}。需要用户本人在任务里批准，你不能代批。`,
    waitingPermissionUnnamed: '在等用户批准一项操作。需要用户本人在任务里批准，你不能代批。',
    waitingOther: '在等用户在任务里处理一项确认。',
    result: '结论：',
    reason: '原因：',
    interjected: '（这串请求期间用户也在任务里发过消息。）',
    options: '选项：',
    answerHint: (id: string) => `用户回答后，用 send_to_session 把回答发给这个任务（target_session_id=${id}）：你下一条发给它的消息会被当作对这个问题的回答。可以写选项名或序号；多道题按「1. … 2. …」逐行写。`,
    answerInTask: '请用户直接到任务里作答；你转述的话发给任务不会解除它的等待。',
    paused: '你和这个任务已经连续来回多次、期间用户没有参与，宿主已暂停这件任务的通知并提醒了用户。用户在任务里或这里说话后自动恢复。',
    digest: (id: string) => `要看全文用 get_task_digest(${id})。无需回复确认；只有需要任务继续做事时再给它发消息。`,
  },
  en: {
    header: '[Task status notice · sent by the Cindy host, not user input and not user authorization]',
    task: (title: string, id: string) => `Task "${title}" (${id})`,
    done: 'finished.',
    error: 'stopped with an error.',
    interrupted: 'was interrupted when Cindy quit or restarted, and the host did not resume it.',
    dispatchFailed: 'could not start handling the message you sent.',
    resolved: 'The question or approval it was waiting on was handled by the user in the task. No need to relay it.',
    waitingQuestion: 'is waiting for an answer. Relay these questions and options to the user:',
    waitingPlan: 'is waiting for the user to confirm its plan. Open the task to see the plan.',
    waitingPermission: (name: string) => `is waiting for the user to approve: ${name}. Only the user can approve it in the task; you cannot approve it.`,
    waitingPermissionUnnamed: 'is waiting for the user to approve an action. Only the user can approve it in the task; you cannot approve it.',
    waitingOther: 'is waiting for the user to handle a confirmation in the task.',
    result: 'Result: ',
    reason: 'Reason: ',
    interjected: '(The user also sent messages in the task during this request.)',
    options: 'Options: ',
    answerHint: (id: string) => `After the user answers, send the answer to this task with send_to_session (target_session_id=${id}): your next message to it is used as the answer to this question. Option names or numbers work; for several questions write one line each as "1. … 2. …".`,
    answerInTask: 'Ask the user to answer in the task; a message you send to the task will not release its wait.',
    paused: 'You and this task have gone back and forth many times without the user taking part, so the host paused this task\'s notices and told the user. They resume when the user speaks in the task or here.',
    digest: (id: string) => `Use get_task_digest(${id}) for details. No need to acknowledge; message the task only when it should do more work.`,
  },
} as const;

function waitingLines(notice: Notice, s: typeof STRINGS[NoticeLanguage]): string[] {
  const interaction = notice.interaction;
  if (!interaction) return [s.waitingOther];
  switch (interaction.kind) {
    case 'question': {
      const lines: string[] = [s.waitingQuestion];
      for (const [index, q] of (interaction.questions ?? []).entries()) {
        lines.push(`${index + 1}. ${clip(q.question, LIMITS.question)}`);
        if (q.options.length) lines.push(`   ${s.options}${q.options.map(o => clip(o, LIMITS.option)).join(' / ')}`);
      }
      return lines;
    }
    case 'plan':
      return [s.waitingPlan];
    case 'permission':
      return [interaction.title ? s.waitingPermission(clip(interaction.title, LIMITS.option)) : s.waitingPermissionUnnamed];
    default:
      return [s.waitingOther];
  }
}

export function buildNoticeText(notice: Notice, context: NoticeContext): string {
  const s = STRINGS[context.lang];
  const task = s.task(clip(context.title || notice.taskId, LIMITS.title), notice.taskId);
  const lines: string[] = [s.header];
  switch (notice.kind) {
    case 'done':
      lines.push(`${task} ${s.done}`);
      if (notice.result) lines.push(`${s.result}${clip(notice.result, LIMITS.result)}`);
      break;
    case 'error':
      lines.push(`${task} ${s.error}`);
      if (notice.error) lines.push(`${s.reason}${clip(notice.error, LIMITS.error)}`);
      break;
    case 'interrupted':
      lines.push(`${task} ${s.interrupted}`);
      break;
    case 'dispatch-failed':
      lines.push(`${task} ${s.dispatchFailed}`);
      if (notice.error) lines.push(`${s.reason}${clip(notice.error, LIMITS.error)}`);
      break;
    case 'resolved':
      lines.push(`${task}: ${s.resolved}`);
      return lines.join('\n');
    case 'paused':
      lines.push(`${task}: ${s.paused}`);
      return lines.join('\n');
    case 'waiting': {
      const [first, ...rest] = waitingLines(notice, s);
      lines.push(`${task} ${first}`, ...rest);
      if (notice.interaction?.kind === 'question') lines.push(context.replyAnswers ? s.answerHint(notice.taskId) : s.answerInTask);
      break;
    }
  }
  if (notice.ownerInterjected) lines.push(s.interjected);
  lines.push(s.digest(notice.taskId));
  const text = lines.join('\n');
  // 等待类整体上限：问题太多时截断，保留结尾的操作提示。
  if (notice.kind === 'waiting' && Array.from(text).length > LIMITS.waitingTotal) {
    const tail = lines.slice(-2).join('\n');
    const head = Array.from(lines.slice(0, -2).join('\n')).slice(0, LIMITS.waitingTotal - Array.from(tail).length - 2).join('');
    return `${head}…\n${tail}`;
  }
  return text;
}
