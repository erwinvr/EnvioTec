import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkScheduleByDate, excludedOf, scheduleByDateOf } from '../../src/modules/campaigns/date-schedule.js';
import { validateRow } from '../../src/modules/contacts/csv-rows.js';
import { formatDate, parseDate } from '../../src/modules/contacts/dates.js';
import { recipientValues } from '../../src/modules/sending/message.js';

describe('variables de fecha y envío según fecha del contacto (ADR-030)', () => {
  it('fechas DD/MM/AAAA (también D/M/AAAA y AAAA-MM-DD); se rechazan fechas imposibles', () => {
    assert.equal(parseDate('05/03/2027'), '2027-03-05');
    assert.equal(parseDate(' 5/3/2027 '), '2027-03-05');
    assert.equal(parseDate('2027-03-05'), '2027-03-05');
    assert.equal(parseDate('29/02/2028'), '2028-02-29');
    for (const bad of ['31/02/2027', '29/02/2027', '00/01/2027', '12/13/2027', '2027/03/05', '05-03-2027', '', 'mañana', '1/1/1800']) {
      assert.equal(parseDate(bad), null, bad);
    }
    assert.equal(formatDate('2027-03-05'), '05/03/2027');
    assert.equal(formatDate('texto'), 'texto');
  });

  it('CSV: la fecha inválida rechaza la fila; la válida se guarda como AAAA-MM-DD', () => {
    const columns = ['email', 'vence'];
    assert.deepEqual(validateRow(['a@b.test', '05/03/2027'], columns, { vence: 'date' }).contact.attributes, { vence: '2027-03-05' });
    assert.equal(validateRow(['a@b.test', '31/02/2027'], columns, { vence: 'date' }).problems[0].code, 'invalid_date');
    assert.deepEqual(validateRow(['a@b.test', '31/02/2027'], columns, {}).contact.attributes, { vence: '31/02/2027' }, 'variable de texto: sin validar');
  });

  it('programación: variable de fecha de la lista, desfase y hora válidos', () => {
    const list = { attributes: ['vence', 'plan'], attribute_types: { vence: 'date' } };
    assert.deepEqual(checkScheduleByDate({ variable: 'vence' }, list), { variable: 'vence', offsetDays: 0, time: '09:00' });
    assert.deepEqual(checkScheduleByDate({ variable: 'vence', offsetDays: -3, time: '18:30' }, list), { variable: 'vence', offsetDays: -3, time: '18:30' });
    assert.equal(checkScheduleByDate(null, list), null);
    const code = (schedule) => { try { checkScheduleByDate(schedule, list); return null; } catch (e) { return e.details.map((d) => d.code); } };
    assert.deepEqual(code({ variable: 'plan' }), ['invalid_schedule_variable']);
    assert.deepEqual(code({ variable: 'vence', offsetDays: 400, time: '25:00' }), ['invalid_offset', 'invalid_time']);
    assert.deepEqual(scheduleByDateOf({ schedule_variable: 'vence', schedule_offset_days: -3, schedule_time: '09:00:00' }), { variable: 'vence', offsetDays: -3, time: '09:00' });
    assert.equal(scheduleByDateOf({ schedule_variable: null }), null);
    assert.deepEqual(excludedOf({ excluded_no_date: 1, excluded_past: 2, excluded_too_far: 0 }), { noDate: 1, past: 2, tooFar: 0 });
    assert.equal(excludedOf({ excluded_no_date: null }), null);
  });

  it('en el correo la fecha va como DD/MM/AAAA', () => {
    const values = recipientValues({ email: 'a@b.test', attributes: { vence: '2027-03-05' } }, ['vence'], { vence: 'date' });
    assert.deepEqual(values, [{ name: 'vence', content: '05/03/2027' }, { name: 'vence__text', content: '05/03/2027' }]);
  });
});
