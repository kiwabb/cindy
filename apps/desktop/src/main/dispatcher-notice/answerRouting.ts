/**
 * 派发方的回复 → 对任务挂起提问的回答（纯函数）。
 * 回答的格式与主人在卡片里作答一致：单选题是选项名或手打文字；多选题是 JSON 数组（选中的选项名 + 可选的手打文字）；
 * 键用 answerKey（题目 id，旧题用题干）。题目限定只能从固定选项里选（answerConstraints.choices）而回复对不上时不作答，
 * 由调用方改走普通排队并告诉派发方原因，不硬塞一个不合法的答案。
 */
import { answerKey, encodeMultiSelectAnswer, type AskQuestion } from '@cindy/maker-shared/interaction';

export type ReplyMapping =
  | { ok: true; answers: Record<string, string> }
  | { ok: false; reason: 'empty' | 'choice-required'; choices?: string[] };

function normalize(text: string): string {
  return text.trim().replace(/[。.!！]+$/u, '').trim().toLowerCase();
}

/** 回复对上了哪个选项：选项名（忽略大小写和句末标点），或 1 起的序号。 */
function matchOption(question: AskQuestion, part: string): string | null {
  const options = question.options ?? [];
  const value = normalize(part);
  if (!value) return null;
  const byLabel = options.find(option => normalize(option.label) === value);
  if (byLabel) return byLabel.label;
  const index = /^\(?(\d{1,2})[).、]?$/u.exec(value);
  if (index) {
    const option = options[Number(index[1]) - 1];
    if (option) return option.label;
  }
  return null;
}

function answerOne(question: AskQuestion, reply: string): { ok: true; answer: string } | { ok: false; choices: string[] } {
  const choices = question.answerConstraints?.choices;
  if (question.multiSelect) {
    const parts = reply.split(/[,，、;；\n]+/u).map(part => part.trim()).filter(Boolean);
    const matched = parts.map(part => matchOption(question, part));
    const labels = new Set(matched.filter((label): label is string => label !== null));
    const leftover = parts.filter((_part, index) => matched[index] === null).join('，');
    if (leftover && choices) return { ok: false, choices };
    // 全都对上选项就只交选项；否则整段回复作为「其他」文字（与卡片里手打一致）。
    return { ok: true, answer: encodeMultiSelectAnswer(question.options ?? [], labels, leftover ? reply.trim() : '') };
  }
  const label = matchOption(question, reply);
  if (label) return { ok: true, answer: label };
  if (choices) return { ok: false, choices };
  return { ok: true, answer: reply.trim() };
}

/** 多道题且回复按「1. … 2. …」逐行写、行数与题数一致时逐题作答；否则每道题都交整段回复，由任务自己理解。 */
function splitNumbered(reply: string, count: number): string[] | null {
  if (count < 2) return null;
  const parts = reply.split(/\n(?=\s*\d{1,2}[.)、]\s*)/u).map(part => part.replace(/^\s*\d{1,2}[.)、]\s*/u, '').trim());
  return parts.length === count && parts.every(Boolean) ? parts : null;
}

export function mapReplyToAnswers(questions: readonly AskQuestion[], reply: string): ReplyMapping {
  const text = reply.trim();
  if (!text || !questions.length) return { ok: false, reason: 'empty' };
  const perQuestion = splitNumbered(text, questions.length);
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const result = answerOne(question, perQuestion?.[index] ?? text);
    if (!result.ok) return { ok: false, reason: 'choice-required', choices: result.choices };
    answers[answerKey(question)] = result.answer;
  }
  return { ok: true, answers };
}
