import { ValidationError } from '../../core/errors/errors.js';

// Sending by each contact's date (ADR-030): a date variable of the list, an
// offset in days (-3 = three days before) and a time of day in
// America/La_Paz. At approval each recipient gets its send_at; contacts
// without a date, whose moment has already passed or that fall beyond the
// window are left out and counted.

export const WINDOW_DAYS = 365;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Checks the schedule against the chosen list; returns it normalized.
export function checkScheduleByDate(schedule, list) {
  if (!schedule) return null;
  const problems = [];
  const { variable, offsetDays = 0, time = '09:00' } = schedule;
  if (!list?.attributes?.includes(variable) || list.attribute_types?.[variable] !== 'date') {
    problems.push({ field: 'scheduleByDate.variable', code: 'invalid_schedule_variable' });
  }
  if (!Number.isInteger(offsetDays) || offsetDays < -WINDOW_DAYS || offsetDays > WINDOW_DAYS) {
    problems.push({ field: 'scheduleByDate.offsetDays', code: 'invalid_offset' });
  }
  if (!TIME.test(time)) problems.push({ field: 'scheduleByDate.time', code: 'invalid_time' });
  if (problems.length > 0) throw new ValidationError(problems);
  return { variable, offsetDays, time };
}

export const scheduleByDateOf = (row) => (row.schedule_variable
  ? { variable: row.schedule_variable, offsetDays: row.schedule_offset_days, time: String(row.schedule_time).slice(0, 5) }
  : null);

export const excludedOf = (row) => (row.excluded_no_date === null || row.excluded_no_date === undefined
  ? null
  : { noDate: row.excluded_no_date, past: row.excluded_past, tooFar: row.excluded_too_far });
