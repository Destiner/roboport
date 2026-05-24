import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test';

import { cron, type CronEvent } from '@/triggers/sources/cron';

interface CapturedTimer {
  cb: () => void;
  delay: number;
}

let captured: CapturedTimer[];
let cleared: number;
let setTimeoutSpy: ReturnType<typeof spyOn>;
let clearTimeoutSpy: ReturnType<typeof spyOn>;

beforeEach((): void => {
  captured = [];
  cleared = 0;
  setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    cb: () => void,
    delay: number,
  ): number => {
    captured.push({ cb, delay });
    return captured.length;
  }) as never);
  clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(
    ((): void => {
      cleared += 1;
    }) as never,
  );
});

afterEach((): void => {
  setTimeoutSpy.mockRestore();
  clearTimeoutSpy.mockRestore();
  setSystemTime();
});

function startAt(
  date: string,
  schedule: Parameters<typeof cron>[0]['schedule'],
): {
  events: CronEvent[];
  unsub: () => void | Promise<void>;
} {
  setSystemTime(new Date(date));
  const events: CronEvent[] = [];
  const trigger = cron({ schedule });
  const unsub = trigger.start((event): void => {
    events.push(event);
  }) as () => void | Promise<void>;
  return { events, unsub };
}

describe('cron schedules', () => {
  test('every minute fires at the next minute boundary', (): void => {
    startAt('2026-01-01T12:30:15Z', { every: 'minute' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.delay).toBe(45_000);
  });

  test('every hour defaults to the top of the next hour', (): void => {
    startAt('2026-01-01T12:30:15Z', { every: 'hour' });
    expect(captured[0]?.delay).toBe(29 * 60_000 + 45_000);
  });

  test('every hour respects a future minute in the current hour', (): void => {
    startAt('2026-01-01T12:30:15Z', { every: 'hour', minute: 45 });
    expect(captured[0]?.delay).toBe(14 * 60_000 + 45_000);
  });

  test('every hour rolls over when the target minute already passed', (): void => {
    startAt('2026-01-01T12:30:15Z', { every: 'hour', minute: 15 });
    expect(captured[0]?.delay).toBe(44 * 60_000 + 45_000);
  });

  test('every day fires later today if the time is upcoming', (): void => {
    startAt('2026-01-01T12:30:15Z', {
      every: 'day',
      at: { hour: 18, minute: 30 },
    });
    expect(captured[0]?.delay).toBe(6 * 3_600_000 - 15_000);
  });

  test('every day rolls to tomorrow if the time has already passed', (): void => {
    startAt('2026-01-01T12:30:15Z', { every: 'day', at: { hour: 9 } });
    expect(captured[0]?.delay).toBe(20 * 3_600_000 + 29 * 60_000 + 45_000);
  });

  test('every week selects the next matching weekday', (): void => {
    // 2026-01-01 is a Thursday.
    startAt('2026-01-01T12:30:15Z', {
      every: 'week',
      on: 'mon',
      at: { hour: 9 },
    });
    expect(captured[0]?.delay).toBe(
      3 * 86_400_000 + 20 * 3_600_000 + 29 * 60_000 + 45_000,
    );
  });

  test('every week fires later today if today matches and the time is upcoming', (): void => {
    startAt('2026-01-01T12:30:15Z', {
      every: 'week',
      on: 'thu',
      at: { hour: 18 },
    });
    expect(captured[0]?.delay).toBe(5 * 3_600_000 + 29 * 60_000 + 45_000);
  });

  test('every week skips to next week when today matches but the time has passed', (): void => {
    startAt('2026-01-01T12:30:15Z', {
      every: 'week',
      on: 'thu',
      at: { hour: 9 },
    });
    expect(captured[0]?.delay).toBe(
      7 * 86_400_000 - (3 * 3_600_000 + 30 * 60_000 + 15_000),
    );
  });

  test('every week accepts an array of weekdays', (): void => {
    startAt('2026-01-01T12:30:15Z', {
      every: 'week',
      on: ['sun', 'tue'],
      at: { hour: 9 },
    });
    // Closest match is Sunday (offset 3).
    expect(captured[0]?.delay).toBe(
      3 * 86_400_000 - (3 * 3_600_000 + 30 * 60_000 + 15_000),
    );
  });
});

describe('cron lifecycle', () => {
  test('reschedules after the timer fires and emits an event', (): void => {
    const { events } = startAt('2026-01-01T12:30:15Z', { every: 'minute' });
    expect(captured).toHaveLength(1);

    // Advance to the boundary and fire the timer manually.
    setSystemTime(new Date('2026-01-01T12:31:00Z'));
    captured[0]?.cb();

    expect(events).toHaveLength(1);
    expect(events[0]?.firedAt.toISOString()).toBe('2026-01-01T12:31:00.000Z');
    expect(captured).toHaveLength(2);
    expect(captured[1]?.delay).toBe(60_000);
  });

  test('unsub clears the pending timer and suppresses further emissions', (): void => {
    const { events, unsub } = startAt('2026-01-01T12:30:15Z', {
      every: 'minute',
    });
    expect(captured).toHaveLength(1);

    void unsub();
    expect(cleared).toBe(1);

    // Firing the captured callback after unsub must be a no-op.
    captured[0]?.cb();
    expect(events).toHaveLength(0);
    expect(captured).toHaveLength(1);
  });
});
