import type { FactRoute } from '@cindy/maker-core';
/** Host-only contracts. Never accept these envelopes from model text or a plugin. */
export interface Scope { ownerId: string; botId: string }
export interface Binding extends Scope { ownerEpoch: string; sessionId: string; instanceId: string; deviceId: string }
export interface CompletedTurn extends Binding {
  logicalTurnId: string; generation: number; completedAt: number; status: 'completed'; source: 'owner-private';
  userMessageId: string; assistantMessageId: string;
}
export interface Affect {
  valence: 'positive' | 'neutral' | 'negative'; intensity: number;
  relationship: 'none' | 'respect' | 'repair' | 'boundary-violation';
}
export type ExplicitModel = FactRoute;
/** Shared host public port owns credentials, budget and transport. */
export type { ResponsesTextPort as CompanionResponsesPort } from '../maker-host/fact-analysis-responses.js';
export interface PlanItem {
  id: string; kind: 'activity' | 'wish' | 'anniversary';
  domain: 'character-fiction' | 'owner-commitment'; title: string;
  date: string; timezone: string; expiresAt: number;
  status: 'pending' | 'completed' | 'expired';
  /** Real commitments require a verified owner message, never generated provenance. */
  ownerMessageId?: string; completedAt?: number;
}
export interface Policy {
  enabled: boolean; timezone: string; quietStart: number; quietEnd: number;
  cooldownMs: number; recentInteractionMs: number; dailyBudget: number;
}
export const DEFAULT_POLICY: Policy = {
  enabled: false, timezone: 'UTC', quietStart: 22 * 60, quietEnd: 8 * 60,
  cooldownMs: 4 * 3600_000, recentInteractionMs: 30 * 60_000, dailyBudget: 1,
};
export interface OutboxItem {
  id: string; eventId: string; planId?: string; sessionId: string; deviceId: string; ownerEpoch: string; instanceId: string;
  day: string; createdAt: number; expiresAt: number; text: string;
  status: 'pending' | 'sending' | 'delivered' | 'unknown' | 'cancelled';
  attemptId?: string; receiptId?: string; deliveredAt?: number;
}
export interface State extends Scope {
  schema: 1; revision: number;
  affect: { valence: Affect['valence']; intensity: number; at: number; trust: number };
  turns: Record<string, { at: number; sessionId: string; ownerEpoch: string; instanceId: string; generation: number; logicalTurnId: string; userMessageId: string; assistantMessageId: string; before: number; after: number; affect: Affect }>;
  plans: Record<string, PlanItem>; outbox: Record<string, OutboxItem>;
  policy: Partial<Policy>; budgets: Record<string, number>;
  lastInteractionAt: number; refused: boolean;
}
export function initialState(scope: Scope): State {
  return { ...scope, schema: 1, revision: 0,
    affect: { valence: 'neutral', intensity: 0, at: 0, trust: 0 },
    turns: {}, plans: {}, outbox: {}, policy: {}, budgets: {}, lastInteractionAt: 0, refused: false };
}
export function assertId(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('COMPANION_INVALID_ID');
}
export function assertTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8.64e15) throw new Error('COMPANION_INVALID_TIME');
}
export function assertModel(route: ExplicitModel): void {
  if (!route || route.protocol !== 'openai-responses' || !route.baseUrl) throw new Error('COMPANION_EXPLICIT_MODEL_REQUIRED');
  assertId(route.model); assertId(route.providerId);
  const url = new URL(route.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('COMPANION_EXPLICIT_MODEL_REQUIRED');
}

export function assertSameModel(selected: ExplicitModel, actual: ExplicitModel): void {
  assertModel(selected); assertModel(actual);
  if (selected.providerId !== actual.providerId || selected.model !== actual.model
    || selected.protocol !== actual.protocol || selected.baseUrl !== actual.baseUrl)
    throw new Error('COMPANION_MODEL_ROUTE_CHANGED');
}
