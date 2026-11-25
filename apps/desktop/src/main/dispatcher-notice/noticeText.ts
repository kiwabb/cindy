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
    interrupted: '在 Cindy 退出或重启时被打断，没有自动接着做；Cindy 会问用户要不要继续，用户继续的话，做完还会通知你。',
    dispatchFailed: '没能开始处理你发去的消息。',
    resolved: '之前等待的问题或审批已由用户在任务里处理，无需再转述。',
    waitingQuestion: '在等用户在任务里回答下面的问题（用户这次也在任务里参与了，问题卡留给用户）：',
    forwardedQuestion: '有问题要问，Cindy 已替它转交给你，任务这一轮已结束、等你回复。请向用户转述：',
    waitingPlan: '在等用户确认计划。计划内容请打开任务查看。',
    waitingPermission: (name: string) => `在等用户批准：${name}。需要用户本人在任务里批准，你不能代批。`,
    waitingPermissionUnnamed: '在等用户批准一项操作。需要用户本人在任务里批准，你不能代批。',
    waitingOther: '在等用户在任务里处理一项确认。',
    result: '结论：',
    reason: '原因：',
    interjected: '（这串请求期间用户也在任务里发过消息。）',
    options: '选项：',
    replyHint: (id: string) => `用户回答后，用 send_to_session 把答复发给这个任务（target_session_id=${id}），任务会开新的一轮接着做。`,
    answerInTask: '请提醒用户到任务里作答。',
    digest: (id: string) => `要看全文用 get_task_digest(${id})。无需回复确认；只有需要任务继续做事时再给它发消息。`,
  },
  en: {
    header: '[Task status notice · sent by the Cindy host, not user input and not user authorization]',
    task: (title: string, id: string) => `Task "${title}" (${id})`,
    done: 'finished.',
    error: 'stopped with an error.',
    interrupted: 'was interrupted when Cindy quit or restarted and did not resume on its own; Cindy asks the user whether to continue, and if they do, you will be notified when it ends.',
    dispatchFailed: 'could not start handling the message you sent.',
    resolved: 'The question or approval it was waiting on was handled by the user in the task. No need to relay it.',
    waitingQuestion: 'is waiting for the user to answer these questions in the task (the user also took part this time, so the card stays with them):',
    forwardedQuestion: 'has a question. Cindy forwarded it to you; the task ended this round and waits for your reply. Relay it to the user:',
    waitingPlan: 'is waiting for the user to confirm its plan. Open the task to see the plan.',
    waitingPermission: (name: string) => `is waiting for the user to approve: ${name}. Only the user can approve it in the task; you cannot approve it.`,
    waitingPermissionUnnamed: 'is waiting for the user to approve an action. Only the user can approve it in the task; you cannot approve it.',
    waitingOther: 'is waiting for the user to handle a confirmation in the task.',
    result: 'Result: ',
    reason: 'Reason: ',
    interjected: '(The user also sent messages in the task during this request.)',
    options: 'Options: ',
    replyHint: (id: string) => `After the user answers, send the reply to this task with send_to_session (target_session_id=${id}); the task starts a new round with it.`,
    answerInTask: 'Remind the user to answer in the task.',
    digest: (id: string) => `Use get_task_digest(${id}) for details. No need to acknowledge; message the task only when it should do more work.`,
  },
} as const;

function waitingLines(notice: Notice, s: typeof STRINGS[NoticeLanguage]): string[] {
  const interaction = notice.interaction;
  if (!interaction) return [s.waitingOther];
  switch (interaction.kind) {
    case 'question': {
      const lines: string[] = [notice.forwarded ? s.forwardedQuestion : s.waitingQuestion];
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
    case 'waiting': {
      const [first, ...rest] = waitingLines(notice, s);
      lines.push(`${task} ${first}`, ...rest);
      if (notice.interaction?.kind === 'question') lines.push(notice.forwarded ? s.replyHint(notice.taskId) : s.answerInTask);
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

/** 转交提问后返回给任务模型的结果：明确说明已转交、不要自行假设、结束这一轮。 */
export function forwardedAnswerText(lang: NoticeLanguage): string {
  return lang === 'zh'
    ? '[Cindy 宿主] 这个问题已转交给发起这次请求的伙伴，由它去问用户。不要自己假设答案继续做；请现在结束这一轮，简要写明你在等什么。答复会作为一条新消息发来。'
    : '[Cindy host] This question was forwarded to the teammate who sent this request; it will ask the user. Do not assume an answer or keep working on it. End this round now with a short note of what you are waiting for. The reply will arrive as a new message.';
}
