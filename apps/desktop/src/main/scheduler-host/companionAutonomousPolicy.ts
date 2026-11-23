const HOUR = 3_600_000;
const MINUTE = 60_000;
export const AUTONOMOUS_TIMEZONE = 'Asia/Shanghai';
export const AUTONOMOUS_WINDOWS = [12 * 60 + 30, 19 * 60] as const;

export interface AutonomousSettings {
  greeting: boolean;
  sharing: boolean;
  paused: boolean;
  resumedAt: number;
  eligibleAt: number;
  home: string;
}

export function shanghaiDay(at: number) {
  return new Date(at + 8 * HOUR).toISOString().slice(0, 10);
}

export function autonomousWindow(now: number) {
  const local = new Date(now + 8 * HOUR);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const start = AUTONOMOUS_WINDOWS.find(value => value <= minutes && minutes < value + 30);
  if (start === undefined) return null;
  const day = shanghaiDay(now);
  return { day, startsAt: Date.parse(day + 'T00:00:00+08:00') + start * MINUTE };
}

export function autonomousPause(settings: AutonomousSettings, published: readonly number[], lastContact: number) {
  const unanswered = published.filter(at => at > Math.max(lastContact, settings.resumedAt));
  const latest = Math.max(0, ...unanswered);
  return { paused: settings.paused || unanswered.length >= 2, retryAt: latest ? latest + 48 * HOUR : 0 };
}

export function autonomousEligible(input: {
  settings: AutonomousSettings; published: readonly number[]; lastContact: number; now: number;
}) {
  const { settings, published, lastContact, now } = input;
  const follow = autonomousPause(settings, published, lastContact);
  return (settings.greeting || settings.sharing) && now >= settings.eligibleAt &&
    !follow.paused && now >= follow.retryAt && now - lastContact >= 12 * HOUR &&
    !published.some(at => shanghaiDay(at) === shanghaiDay(now));
}

/** Plans may come from the workspace. Only neutral activities can become a share candidate. */
export function shareableActivity(activity: string) {
  return /^[\p{L}\p{N} ，、。]{1,32}$/u.test(activity) &&
    /^(泡(一)?杯茶|泡茶|喝茶|读书|看书|阅读|翻[几两]页书|散步|画画|听音乐|整理书桌)[。]?$/u.test(activity);
}
