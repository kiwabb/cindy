import { createHash } from 'node:crypto';

export const AUTONOMOUS_TICK_MS = 5 * 60_000;
export const AUTONOMOUS_DAILY_LIMIT = 6;

export interface AutonomousSettings {
  greeting: boolean;
  sharing: boolean;
  paused: boolean;
}

export function autonomousTickStart(now: number) {
  return Math.floor(now / AUTONOMOUS_TICK_MS) * AUTONOMOUS_TICK_MS;
}

export function autonomousRoll(roll: number, thresholdDraw: number) {
  return roll <= (2 + 3 * thresholdDraw) / 288;
}

/** Independent uniform draws per host-owned bot and tick. A restart does not reroll. */
export function autonomousTickHit(ownerRoot: string, botId: string, tick: number) {
  const seed = createHash('sha256').update(JSON.stringify([ownerRoot, botId, tick])).digest();
  return autonomousRoll(seed.readUInt32BE(0) / 2 ** 32, seed.readUInt32BE(4) / 2 ** 32);
}
