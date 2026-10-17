import { describe, expect, test } from '@playwright/test';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  AgentSchedulerStore,
  describeSchedule,
  findOverdue,
  isDue,
  matches,
  nextRunAfter,
  parseCron,
  scheduleToCron,
} from '../../src/main/agentScheduler';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sched-'));
  const store = new AgentSchedulerStore(path.join(dir, 'tasks.json'));
  store.load();
  return { store, dir };
}

const d = (y, mo, da, h, mi) => new Date(y, mo - 1, da, h, mi);

describe('scheduleToCron', () => {
  test('daily/weekly/monthly/hourly mappings', () => {
    expect(scheduleToCron({ minute: [0], hour: [9] })).toBe('0 9 * * *');
    expect(scheduleToCron({ minute: [15], hour: [9], dayOfWeek: [1] })).toBe(
      '15 9 * * 1',
    );
    expect(
      scheduleToCron({ minute: [30], hour: [18], dayOfMonth: [1, 15] }),
    ).toBe('30 18 1,15 * *');
    expect(
      scheduleToCron({ minute: [45], hour: [7], month: [2], dayOfMonth: [29] }),
    ).toBe('45 7 29 2 *');
    expect(scheduleToCron({ stepHours: 2 })).toBe('0 */2 * * *');
  });

  test('omitted day/month/weekday fields default to *', () => {
    expect(
      scheduleToCron({ minute: [0], hour: [9], dayOfWeek: [1, 3, 6] }),
    ).toBe('0 9 * * 1,3,6');
    expect(scheduleToCron({ minute: [0], hour: [9], month: [1, 6] })).toBe(
      '0 9 * 1,6 *',
    );
  });

  test('rejects non-15-minute alignment', () => {
    expect(() => scheduleToCron({ minute: [17], hour: [9] })).toThrow(
      '15-min',
    );
    expect(() => scheduleToCron({ minute: [5, 0], hour: [9] })).toThrow(
      '15-min',
    );
  });

  test('rejects impossible dates but allows leap-year Feb 29', () => {
    expect(() =>
      scheduleToCron({ minute: [0], hour: [9], month: [2], dayOfMonth: [30] }),
    ).toThrow('February');
    expect(() =>
      scheduleToCron({ minute: [0], hour: [9], month: [2], dayOfMonth: [31] }),
    ).toThrow('February');
    expect(() =>
      scheduleToCron({ minute: [0], hour: [9], month: [4], dayOfMonth: [31] }),
    ).toThrow('no 31st');
    expect(() =>
      scheduleToCron({ minute: [0], hour: [9], month: [2], dayOfMonth: [29] }),
    ).not.toThrow();
  });

  test('rejects missing hour/minute (every-minute storm guard)', () => {
    expect(() => scheduleToCron({ dayOfWeek: [1] })).toThrow(
      'minute and hour are required',
    );
    expect(() => scheduleToCron({ minute: [0] })).toThrow(
      'minute and hour are required',
    );
  });

  test('rejects dayOfWeek + dayOfMonth together (pick one)', () => {
    expect(() =>
      scheduleToCron({
        minute: [0],
        hour: [9],
        dayOfWeek: [1],
        dayOfMonth: [1],
      }),
    ).toThrow('cannot both');
  });

  test('rejects bad stepHours and hour+stepHours coexistence', () => {
    expect(() => scheduleToCron({ stepHours: 0 })).toThrow('1-23');
    expect(() => scheduleToCron({ stepHours: 24 })).toThrow('1-23');
    expect(() => scheduleToCron({ stepHours: 2, hour: [9] })).toThrow(
      'mutually exclusive',
    );
  });

  test('rejects out-of-range fields', () => {
    expect(() => scheduleToCron({ minute: [0], hour: [24] })).toThrow(
      'out of range',
    );
    expect(() =>
      scheduleToCron({ minute: [0], hour: [9], dayOfWeek: [7] }),
    ).toThrow('out of range');
    expect(() =>
      scheduleToCron({ minute: [0], hour: [9], month: [13] }),
    ).toThrow('out of range');
    expect(() =>
      scheduleToCron({ minute: [0], hour: [9], dayOfMonth: [0] }),
    ).toThrow('out of range');
  });
});

describe('matches (cron semantics)', () => {
  test('AND across dimensions', () => {
    const cron = parseCron('0 9 1 1 *');
    expect(matches(cron, d(2026, 1, 1, 9, 0))).toBe(true);
    expect(matches(cron, d(2026, 1, 2, 9, 0))).toBe(false); // wrong day
    expect(matches(cron, d(2026, 1, 1, 10, 0))).toBe(false); // wrong hour
    expect(matches(cron, d(2026, 2, 1, 9, 0))).toBe(false); // wrong month
  });

  test('dom+dow both restricted = OR', () => {
    // scheduleToCron refuses to build this; parse a hand-written cron instead.
    const cron = parseCron('0 9 1 * 1');
    expect(matches(cron, d(2026, 1, 1, 9, 0))).toBe(true); // 1st of month
    expect(matches(cron, d(2026, 1, 5, 9, 0))).toBe(true); // Monday Jan 5
    expect(matches(cron, d(2026, 1, 3, 9, 0))).toBe(false); // Saturday Jan 3
  });

  test('leap-year Feb 29 matches', () => {
    const cron = parseCron('0 9 29 2 *');
    expect(matches(cron, d(2024, 2, 29, 9, 0))).toBe(true);
    expect(matches(cron, d(2026, 2, 28, 9, 0))).toBe(false);
  });
});

describe('nextRunAfter', () => {
  test('daily: later today', () => {
    const from = d(2026, 10, 17, 8, 30).getTime();
    const next = nextRunAfter('0 9 * * *', from);
    expect(next).toBe(d(2026, 10, 17, 9, 0).getTime());
  });

  test('daily: already passed → tomorrow', () => {
    const from = d(2026, 10, 17, 10, 0).getTime();
    const next = nextRunAfter('0 9 * * *', from);
    expect(next).toBe(d(2026, 10, 18, 9, 0).getTime());
  });

  test('15-minute alignment', () => {
    const from = d(2026, 10, 17, 9, 20).getTime();
    const next = nextRunAfter('15 9 * * *', from);
    // 09:15 already passed at 09:20 → tomorrow 09:15
    expect(next).toBe(d(2026, 10, 18, 9, 15).getTime());
  });

  test('weekly: next weekday (Sat → Mon)', () => {
    // 2026-10-17 is a Saturday
    const from = d(2026, 10, 17, 8, 0).getTime();
    const next = nextRunAfter('0 9 * * 1', from);
    expect(next).toBe(d(2026, 10, 19, 9, 0).getTime());
  });

  test('hourly */N boundary', () => {
    const from = d(2026, 10, 17, 10, 30).getTime();
    const next = nextRunAfter('0 */2 * * *', from);
    expect(next).toBe(d(2026, 10, 17, 12, 0).getTime());
  });

  test('monthly: cross-year to Jan 1', () => {
    const from = d(2026, 12, 31, 12, 0).getTime();
    const next = nextRunAfter('0 9 1 * *', from);
    expect(next).toBe(d(2027, 1, 1, 9, 0).getTime());
  });
});

describe('describeSchedule', () => {
  test('common cases', () => {
    expect(describeSchedule('0 9 * * *')).toBe('09:00');
    expect(describeSchedule('0 9 * * 1')).toBe('09:00 on Monday');
    expect(describeSchedule('30 18 1,15 * *')).toBe(
      '18:30 on the 1st, the 15th',
    );
    expect(describeSchedule('0 */2 * * *')).toBe('every 2 hours');
    expect(describeSchedule('0 9 * * 1,3,6')).toBe(
      '09:00 on Monday, Wednesday, Saturday',
    );
  });

  test('dom+dow both set renders explicit OR', () => {
    expect(describeSchedule('0 9 1 * 1')).toBe('09:00 on the 1st or Monday');
  });
});

describe('isDue / findOverdue', () => {
  test('isDue respects enabled and nextRunAt', () => {
    const now = Date.now();
    expect(isDue({ enabled: true, nextRunAt: now - 1 }, now)).toBe(true);
    expect(isDue({ enabled: true, nextRunAt: now + 1 }, now)).toBe(false);
    expect(isDue({ enabled: false, nextRunAt: now - 1 }, now)).toBe(false);
  });

  test('findOverdue only returns enabled tasks past the threshold', () => {
    const now = Date.now();
    const base = {
      id: 'x',
      name: 'x',
      prompt: 'p',
      schedule: { cron: '0 9 * * *' },
      locationId: 'l',
      createdAt: now,
      nextRunAt: now,
      lastResults: [],
    };
    const tasks = [
      { ...base, id: 'a', enabled: true, nextRunAt: now - 13 * 3600e3 },
      { ...base, id: 'b', enabled: false, nextRunAt: now - 13 * 3600e3 },
      { ...base, id: 'c', enabled: true, nextRunAt: now - 3600e3 },
    ];
    const overdue = findOverdue(tasks, now);
    expect(overdue.map((t) => t.id)).toEqual(['a']);
  });
});

describe('AgentSchedulerStore', () => {
  test('create computes nextRunAt and persists to list', () => {
    const { store } = makeStore();
    const task = store.create({
      name: 'inbox',
      prompt: '整理收件箱',
      fields: { minute: [0], hour: [9] },
      locationId: 'loc-1',
    });
    expect(task.id).toBeTruthy();
    expect(task.schedule.cron).toBe('0 9 * * *');
    expect(task.enabled).toBe(true);
    expect(task.nextRunAt).toBeGreaterThan(Date.now());
    expect(store.list()).toHaveLength(1);
  });

  test('create rejects invalid fields', () => {
    const { store } = makeStore();
    expect(() =>
      store.create({
        name: 'x',
        prompt: 'p',
        fields: { minute: [0], hour: [9], dayOfWeek: [1], dayOfMonth: [1] },
        locationId: 'l',
      }),
    ).toThrow('cannot both');
    expect(() =>
      store.create({
        name: 'x',
        prompt: 'p',
        fields: { minute: [17], hour: [9] },
        locationId: 'l',
      }),
    ).toThrow('15-min');
  });

  test('create rejects missing name/prompt/locationId', () => {
    const { store } = makeStore();
    expect(() =>
      store.create({
        name: '',
        prompt: 'p',
        fields: { minute: [0], hour: [9] },
        locationId: 'l',
      }),
    ).toThrow('name is required');
    expect(() =>
      store.create({
        name: 'x',
        prompt: '',
        fields: { minute: [0], hour: [9] },
        locationId: 'l',
      }),
    ).toThrow('prompt is required');
    expect(() =>
      store.create({
        name: 'x',
        prompt: 'p',
        fields: { minute: [0], hour: [9] },
        locationId: '',
      }),
    ).toThrow('locationId is required');
  });

  test('task cap of 20', () => {
    const { store } = makeStore();
    for (let i = 0; i < 20; i += 1) {
      store.create({
        name: 't' + i,
        prompt: 'p',
        fields: { minute: [0], hour: [9] },
        locationId: 'l',
      });
    }
    expect(() =>
      store.create({
        name: 'overflow',
        prompt: 'p',
        fields: { minute: [0], hour: [9] },
        locationId: 'l',
      }),
    ).toThrow('max 20');
  });

  test('update changes schedule and recomputes nextRunAt; enables/disables', () => {
    const { store } = makeStore();
    const task = store.create({
      name: 't',
      prompt: 'p',
      fields: { minute: [0], hour: [9] },
      locationId: 'l',
    });
    const before = task.nextRunAt;
    const updated = store.update(task.id, {
      fields: { minute: [0], hour: [10] },
    });
    expect(updated.schedule.cron).toBe('0 10 * * *');
    expect(updated.nextRunAt).not.toBe(before);
    const disabled = store.update(task.id, { enabled: false });
    expect(disabled.enabled).toBe(false);
  });

  test('reportResult appends history (ring ≤20) and advances nextRunAt', () => {
    const { store } = makeStore();
    const task = store.create({
      name: 't',
      prompt: 'p',
      fields: { minute: [0], hour: [9] },
      locationId: 'l',
    });
    const ranAt = Date.now();
    const after = store.reportResult(task.id, { status: 'success', ranAt });
    expect(after.lastRunAt).toBe(ranAt);
    expect(after.lastResults).toHaveLength(1);
    expect(after.lastResults[0].status).toBe('success');
    expect(after.nextRunAt).toBeGreaterThan(ranAt);
    for (let i = 0; i < 25; i += 1) {
      store.reportResult(task.id, {
        status: 'skipped',
        detail: 'busy',
        ranAt: ranAt + i,
      });
    }
    expect(store.list()[0].lastResults).toHaveLength(20);
  });

  test('delete removes task', () => {
    const { store } = makeStore();
    const task = store.create({
      name: 't',
      prompt: 'p',
      fields: { minute: [0], hour: [9] },
      locationId: 'l',
    });
    expect(store.remove(task.id)).toBe(1);
    expect(store.list()).toHaveLength(0);
  });

  test('corrupt file rolls back to backup', () => {
    const { store } = makeStore();
    const task = store.create({
      name: 't',
      prompt: 'p',
      fields: { minute: [0], hour: [9] },
      locationId: 'l',
    });
    const file = store.getPath();
    fs.copyFileSync(file, file + '.bak.0');
    fs.writeFileSync(file, '{corrupt json', 'utf8');
    const fresh = new AgentSchedulerStore(file);
    const res = fresh.load();
    expect(res.recoveredFromBackup).toBe(true);
    expect(fresh.list()).toHaveLength(1);
    expect(fresh.list()[0].id).toBe(task.id);
  });
});
