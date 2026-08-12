/*
 * The schedule engine, third implementation — after Kotlin and Swift.
 *
 * Ported from android/core/schedule/.../Schedule.kt and kept deliberately literal: the same
 * rule names, the same ordering, the same edge cases. Three clients that disagree about when
 * a class ends is a bug nobody notices until two people are standing next to each other at
 * the school comparing phones.
 */

export const MINUTES_PER_DAY = 24 * 60;

/** "08:30" -> 510. Accepts the literal "24:00" as end-of-day. */
export function minuteOfDay(hhmm) {
  const parts = String(hhmm).trim().split(':');
  if (parts.length < 2) throw new Error('bad time: ' + hhmm);
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!(h >= 0 && h <= 24 && m >= 0 && m <= 59)) throw new Error('bad time: ' + hhmm);
  return h * 60 + m;
}

export function formatTime(minute, use24h = false) {
  const m = Math.min(Math.max(minute, 0), MINUTES_PER_DAY);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (use24h) return `${pad(h)}:${pad(mm)}`;
  const suffix = h < 12 || h === 24 ? 'AM' : 'PM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${pad(mm)} ${suffix}`;
}

// --------------------------------------------------------------------------
// Effective end times — PRD §4.6
// --------------------------------------------------------------------------

/*
 * 1. explicit endTime when authored
 * 2. otherwise the start of the next event whose start is STRICTLY LATER and which is not a
 *    member of the same parallel group. Strictness matters: the booklet runs Activities and
 *    Sisters' Tea both at 2:00 pm ungrouped, and without it Activities gets zero duration.
 * 3. otherwise 60 minutes after start, capped at midnight.
 */
export function effectiveEndMinute(event, day) {
  if (event.endTime) return minuteOfDay(event.endTime);

  const start = minuteOfDay(event.startTime);

  if (event.groupId) {
    const group = (day.groups || []).find((g) => g.id === event.groupId);
    if (group && group.endTime) return minuteOfDay(group.endTime);
  }

  const laterStarts = (day.events || [])
    // Exclude ONLY members of this event's own group; an ungrouped event must not be
    // excluded merely because its groupId differs (it is undefined).
    .filter((c) => !(event.groupId && c.groupId === event.groupId))
    .map((c) => minuteOfDay(c.startTime))
    .filter((s) => s > start);

  if (laterStarts.length) return Math.min(...laterStarts);
  return Math.min(start + 60, MINUTES_PER_DAY);
}

// --------------------------------------------------------------------------
// Blocks
// --------------------------------------------------------------------------

const sortOrderOf = (x) => (typeof x.sortOrder === 'number' ? x.sortOrder : 0);

export function buildBlocks(day) {
  const blocks = [];

  for (const event of (day.events || []).filter((e) => !e.groupId)) {
    blocks.push({
      kind: 'single',
      key: 'e:' + event.id,
      event,
      events: [event],
      startMinute: minuteOfDay(event.startTime),
      endMinute: effectiveEndMinute(event, day),
      sortOrder: sortOrderOf(event),
    });
  }

  const order = [];
  const byGroup = new Map();
  for (const event of day.events || []) {
    if (!event.groupId) continue;
    if (!byGroup.has(event.groupId)) {
      order.push(event.groupId);
      byGroup.set(event.groupId, []);
    }
    byGroup.get(event.groupId).push(event);
  }

  for (const gid of order) {
    const members = byGroup.get(gid);
    const group = (day.groups || []).find((g) => g.id === gid) || { id: gid };
    const ordered = members.slice().sort((a, b) => {
      const sa = minuteOfDay(a.startTime);
      const sb = minuteOfDay(b.startTime);
      if (sa !== sb) return sa - sb;
      const oa = sortOrderOf(a);
      const ob = sortOrderOf(b);
      if (oa !== ob) return oa - ob;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const start = group.startTime
      ? minuteOfDay(group.startTime)
      : Math.min(...ordered.map((e) => minuteOfDay(e.startTime)));
    const end = Math.max(...ordered.map((e) => effectiveEndMinute(e, day)));
    blocks.push({
      kind: 'group',
      key: 'g:' + group.id,
      group,
      members: ordered,
      events: ordered,
      startMinute: start,
      endMinute: end,
      sortOrder: sortOrderOf(group),
    });
  }

  // Total ordering: start time, then sortOrder, then key. The key tiebreak keeps all three
  // implementations identical regardless of sort stability.
  blocks.sort((a, b) => {
    if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return blocks;
}

/** Header credit blocks are returned separately; anchored ones are interleaved. */
export function buildSections(day) {
  const credits = day.creditBlocks || [];
  const header = credits
    .filter((c) => !c.anchorBeforeEventId)
    .slice()
    .sort((a, b) => sortOrderOf(a) - sortOrderOf(b));
  const anchored = credits.filter((c) => c.anchorBeforeEventId);

  const sections = [];
  if (day.note && day.note.trim()) sections.push({ type: 'note', text: day.note });

  for (const block of buildBlocks(day)) {
    anchored
      .filter((cb) => block.events.some((e) => e.id === cb.anchorBeforeEventId))
      .sort((a, b) => sortOrderOf(a) - sortOrderOf(b))
      .forEach((cb) => sections.push({ type: 'credits', block: cb }));
    sections.push({ type: 'block', block });
  }
  return { header, sections };
}

// --------------------------------------------------------------------------
// Live state — FR-10
// --------------------------------------------------------------------------

export const EMPTY_LIVE = { inProgress: new Set(), upNextKey: null, minutesUntilUpNext: null, dayIsOver: false };

/*
 * In progress and Up next are INDEPENDENT and shown together. The school runs 7:00 am to
 * 10:30 pm with no gaps, so an Up next that only appeared when nothing was running would
 * never appear at all.
 */
export function computeLiveState(day, nowMinute) {
  const blocks = buildBlocks(day);
  if (!blocks.length) return EMPTY_LIVE;

  const inProgress = new Set(
    blocks
      .filter((b) =>
        b.events.some((e) => {
          const s = minuteOfDay(e.startTime);
          const end = effectiveEndMinute(e, day);
          return nowMinute >= s && nowMinute < end;
        })
      )
      .map((b) => b.key)
  );

  const next = blocks.find((b) => b.startMinute > nowMinute) || null;
  return {
    inProgress,
    upNextKey: next ? next.key : null,
    minutesUntilUpNext: next ? next.startMinute - nowMinute : null,
    dayIsOver: inProgress.size === 0 && !next,
  };
}

export function statusOf(live, block, nowMinute) {
  if (live.inProgress.has(block.key)) return 'inProgress';
  if (block.key === live.upNextKey) return 'upNext';
  if (block.startMinute <= nowMinute) return 'past';
  return 'future';
}

export function humanCountdown(minutes) {
  if (minutes < 1) return 'now';
  if (minutes === 1) return 'in 1 min';
  if (minutes < 60) return `in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0 && h === 1) return 'in 1 hr';
  if (m === 0) return `in ${h} hr`;
  if (h === 1) return `in 1 hr ${m} min`;
  return `in ${h} hr ${m} min`;
}

// --------------------------------------------------------------------------
// Time in the school's zone
// --------------------------------------------------------------------------

/** The wall-clock parts as they read AT THE SCHOOL, whatever the device is set to. */
export function schoolParts(school, at = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: school.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(at)) p[part.type] = part.value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour % 24, minute: +p.minute, second: +p.second,
  };
}

export function isoDateOrdinal(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? +m[1] * 10000 + +m[2] * 100 + +m[3] : 0;
}

export function todayOrdinal(school, at = new Date()) {
  const p = schoolParts(school, at);
  return p.year * 10000 + p.month * 100 + p.day;
}

export function minuteOfDayNow(school, at = new Date()) {
  const p = schoolParts(school, at);
  return p.hour * 60 + p.minute;
}

export function lifecycleOf(school, at = new Date()) {
  const today = todayOrdinal(school, at);
  const opens = isoDateOrdinal(school.previewOpensAt || school.startDate);
  const ends = isoDateOrdinal(school.endDate);
  if (today < opens) return 'preSchool';
  if (today > ends) return 'archived';
  return 'live';
}

/** Today's day, or the nearest following one, or the last day if the school is over. */
export function defaultDay(school, at = new Date()) {
  const days = school.days || [];
  if (!days.length) return null;
  const today = todayOrdinal(school, at);
  const exact = days.find((d) => isoDateOrdinal(d.date) === today);
  if (exact) return exact;
  const upcoming = days
    .slice()
    .sort((a, b) => isoDateOrdinal(a.date) - isoDateOrdinal(b.date))
    .find((d) => isoDateOrdinal(d.date) > today);
  if (upcoming) return upcoming;
  return days.reduce((best, d) => (isoDateOrdinal(d.date) > isoDateOrdinal(best.date) ? d : best), days[0]);
}

function zoneOffsetMinutes(timeZone, at) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(at)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUTC - at.getTime()) / 60000);
}

/** True when the device's offset differs from the school's right now (FR-13). */
export function deviceZoneDiffers(school, at = new Date()) {
  try {
    return zoneOffsetMinutes(school.timeZone, at) !== -at.getTimezoneOffset();
  } catch {
    return false;
  }
}

const FRIENDLY_ZONES = {
  'America/Vancouver': 'Pacific',
  'America/Los_Angeles': 'Pacific',
  'America/Tijuana': 'Pacific',
  'America/Edmonton': 'Mountain',
  'America/Denver': 'Mountain',
  'America/Phoenix': 'Mountain',
  'America/Winnipeg': 'Central',
  'America/Chicago': 'Central',
  'America/Regina': 'Central',
  'America/Toronto': 'Eastern',
  'America/New_York': 'Eastern',
  'America/Halifax': 'Atlantic',
  'America/St_Johns': 'Newfoundland',
};

export function zoneLabel(school) {
  return (
    FRIENDLY_ZONES[school.timeZone] ||
    String(school.timeZone).split('/').pop().replace(/_/g, ' ')
  );
}

// --------------------------------------------------------------------------
// Rendering helpers — FR-37: join only what is present, never a stray separator
// --------------------------------------------------------------------------

export function joinPresent(parts, separator = ' · ') {
  return parts.filter((p) => p != null && String(p).trim() !== '').join(separator);
}

export function eventHeadline(event) {
  return event.label && event.label.trim()
    ? `${event.label} — ${event.title}`
    : event.title;
}

export function eventSubtitle(event) {
  return joinPresent([event.speaker, event.location, event.audience ? `For ${event.audience}` : null]);
}

export function itemLine(label, detail, person) {
  const head = joinPresent([label, detail], ' ');
  return joinPresent([head || null, person]);
}
