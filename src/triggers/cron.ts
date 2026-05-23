import type { Trigger, Unsub } from './core';

type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

type Schedule =
  | { every: 'minute' }
  | { every: 'hour'; minute?: number }
  | { every: 'day'; at?: { hour: number; minute?: number } }
  | {
      every: 'week';
      on: Weekday | Weekday[];
      at?: { hour: number; minute?: number };
    };

interface CronOptions {
  schedule: Schedule;
}

interface CronEvent {
  firedAt: Date;
}

const WEEKDAY_INDEX: Record<Weekday, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function utcDate(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): Date {
  return new Date(
    Date.UTC(
      parts.year,
      parts.month,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0,
    ),
  );
}

function nextRun(schedule: Schedule, from: Date): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();
  const hour = from.getUTCHours();
  const minute = from.getUTCMinutes();

  if (schedule.every === 'minute') {
    return utcDate({ year, month, day, hour, minute: minute + 1 });
  }

  if (schedule.every === 'hour') {
    const targetMinute = schedule.minute ?? 0;
    if (minute < targetMinute) {
      return utcDate({ year, month, day, hour, minute: targetMinute });
    }
    return utcDate({ year, month, day, hour: hour + 1, minute: targetMinute });
  }

  if (schedule.every === 'day') {
    const targetHour = schedule.at?.hour ?? 0;
    const targetMinute = schedule.at?.minute ?? 0;
    if (hour < targetHour || (hour === targetHour && minute < targetMinute)) {
      return utcDate({
        year,
        month,
        day,
        hour: targetHour,
        minute: targetMinute,
      });
    }
    return utcDate({
      year,
      month,
      day: day + 1,
      hour: targetHour,
      minute: targetMinute,
    });
  }

  const weekdays = (Array.isArray(schedule.on) ? schedule.on : [schedule.on])
    .map((w) => WEEKDAY_INDEX[w])
    .sort((a, b) => a - b);
  const targetHour = schedule.at?.hour ?? 0;
  const targetMinute = schedule.at?.minute ?? 0;
  const currentWeekday = from.getUTCDay();

  for (let offset = 0; offset < 8; offset++) {
    const candidateWeekday = (currentWeekday + offset) % 7;
    if (!weekdays.includes(candidateWeekday)) continue;
    const candidate = utcDate({
      year,
      month,
      day: day + offset,
      hour: targetHour,
      minute: targetMinute,
    });
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  throw new Error('cron: failed to compute next run');
}

function cron(opts: CronOptions): Trigger<CronEvent> {
  return {
    name: 'cron',
    start: (emit): Unsub => {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const schedule = (): void => {
        if (stopped) return;
        const now = new Date();
        const next = nextRun(opts.schedule, now);
        const delay = Math.max(0, next.getTime() - now.getTime());
        timer = setTimeout(() => {
          if (stopped) return;
          emit({ firedAt: new Date() });
          schedule();
        }, delay);
      };

      schedule();

      return (): void => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    },
  };
}

export { cron, type CronEvent, type CronOptions, type Schedule, type Weekday };
