import { describe, expect, it } from 'vitest';
import { evaluateManualRelaunchGuard, type ManualRelaunchGuardDeps } from '../manualRelaunchGuard';
import { formatManualRelaunchBlock, normalizeManualRelaunchBlock } from '../../shared/manualRelaunchBlock';

// 2026-11-26 (personal Mac): the clicked update restart reused the unattended probe and silently refused
// whenever another device was viewing this one. These cases pin the narrower click guard and the
// fixed categories the banner shows. Tier: unit (pure functions, no Electron).

const idle: ManualRelaunchGuardDeps = {
  readLocalActivity: async () => ({ busy: false, reasons: [] }),
  describeTurns: async () => null,
  hasInFlightRemoteOperations: () => false,
};

describe('manual personal restart guard', () => {
  it('allows the click when nothing local runs and no remote call operates on this computer', async () => {
    await expect(evaluateManualRelaunchGuard(idle)).resolves.toEqual({ blocked: false, reasons: [], categories: [] });
  });

  it('re-samples remote calls after the asynchronous local read', async () => {
    let reads = 0;
    const result = await evaluateManualRelaunchGuard({ ...idle, hasInFlightRemoteOperations: () => ++reads > 1 });
    expect(result).toMatchObject({ blocked: true, categories: ['remote-operation'] });
  });

  it.each([
    ['the remote probe throws', { hasInFlightRemoteOperations: () => { throw new Error('x'); } }],
    ['a mid-turn session cannot be described', {
      readLocalActivity: async () => ({ busy: true, reasons: ['session-in-turn'] }),
      describeTurns: async () => { throw new Error('db closed'); },
    }],
    ['a local source label has no category', { readLocalActivity: async () => ({ busy: true, reasons: ['future-source'] }) }],
  ] as Array<[string, Partial<ManualRelaunchGuardDeps>]>)('fails closed as unknown when %s', async (_label, deps) => {
    const result = await evaluateManualRelaunchGuard({ ...idle, ...deps });
    expect(result.blocked).toBe(true);
    expect(result.categories).toContain('unknown');
  });

  it('lists local and remote categories together in a fixed order', async () => {
    const result = await evaluateManualRelaunchGuard({
      readLocalActivity: async () => ({ busy: true, reasons: ['session-in-turn', 'background-bash'] }),
      describeTurns: async () => ({ companions: [{ name: 'Ada' }], conversation: false }),
      hasInFlightRemoteOperations: () => true,
    });
    expect(result.categories).toEqual(['companion', 'background-command', 'remote-operation']);
    // Log labels are fixed strings; companion names never enter the result.
    expect(JSON.stringify(result)).not.toContain('Ada');
  });
});

describe('manual restart refusal shown in the banner', () => {
  const translate = (key: string, vars?: Record<string, string>) =>
    vars?.activities !== undefined ? `${key}(${vars.activities})` : key.replace('update.banner.', '');

  it('joins the categories with the localized joiners', () => {
    expect(formatManualRelaunchBlock(translate, { id: 1, categories: ['scheduled-task', 'remote-operation'] }))
      .toBe('update.banner.relaunchBlocked(activity.scheduledTaskactivityJoinerPairactivity.remoteOperation)');
  });

  it('never renders an empty refusal', () => {
    expect(formatManualRelaunchBlock(translate, { id: 1, categories: [] }))
      .toBe('update.banner.relaunchBlocked(activity.unknown)');
  });

  it('turns an unexpected pushed category into unknown and rejects a malformed payload', () => {
    expect(normalizeManualRelaunchBlock({ id: 3, categories: ['conversation', 'session-123'] }))
      .toEqual({ id: 3, categories: ['conversation', 'unknown'] });
    expect(normalizeManualRelaunchBlock({ id: 'x', categories: [] })).toBeNull();
    expect(normalizeManualRelaunchBlock(undefined)).toBeNull();
  });
});
