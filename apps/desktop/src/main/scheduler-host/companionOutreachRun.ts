import type { CompanionOutreachLedger } from './companionOutreachLedger.js';
import { decideCompanionOutreach, type CompanionOutreachEvent } from './companionOutreachPolicy.js';

type Admission = Omit<Parameters<typeof decideCompanionOutreach>[0], 'event' | 'eventAlreadyClaimed'> & {
  conversationEpoch: string;
  alreadyPublished?: boolean;
};

type Dependencies = {
  ledger: CompanionOutreachLedger;
  // Serialize claims and publications with changes to the companion's
  // settings, home ownership and canonical session.
  withPublicationLock<T>(action: () => Promise<T>): Promise<T>;
  readAdmission(): Promise<Admission>;
  generate(event: CompanionOutreachEvent): Promise<string | null>;
  // Return a receipt only for a committed message (or an idempotent readback).
  publish(input: { clientId: string; text: string; conversationEpoch: string }): Promise<{ messageId: string }>;
};

export async function runCompanionOutreach(deps: Dependencies, event: CompanionOutreachEvent) {
  const admitted = await deps.withPublicationLock(async () => {
    const admission = await deps.readAdmission();
    const decision = decideCompanionOutreach({ ...admission, event, eventAlreadyClaimed: admission.alreadyPublished ?? false });
    if (decision !== 'allow') return { decision } as const;
    if (!await deps.ledger.claim(event.key)) return { decision: 'duplicate' } as const;
    return { decision, conversationEpoch: admission.conversationEpoch } as const;
  });
  if (admitted.decision !== 'allow') return { status: 'skipped', reason: admitted.decision } as const;

  const text = await deps.generate(event);
  if (!text?.trim()) return { status: 'silent' } as const;

  return deps.withPublicationLock(async () => {
    const admission = await deps.readAdmission();
    if (admission.conversationEpoch !== admitted.conversationEpoch) {
      return { status: 'suppressed', reason: 'conversation-changed' } as const;
    }
    const decision = decideCompanionOutreach({ ...admission, event, eventAlreadyClaimed: admission.alreadyPublished ?? false });
    if (decision !== 'allow') return { status: 'suppressed', reason: decision } as const;
    const receipt = await deps.publish({
      clientId: deps.ledger.clientId(event.key),
      text,
      conversationEpoch: admission.conversationEpoch,
    });
    return { status: 'published', messageId: receipt.messageId } as const;
  });
}
