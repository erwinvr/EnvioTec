import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csvCell, csvLine } from '../../src/core/http/csv.js';
import {
  assertExportLimits, createAuditLogsService, EXPORT_MAX_ROWS, MAX_OFFSET,
} from '../../src/modules/audit-logs/audit-logs.service.js';

describe('CSV de exportación', () => {
  it('escapa comillas y entrecomilla cada celda', () => {
    assert.equal(csvLine(['a', 'con "comillas"', null, 3]), '"a","con ""comillas""","","3"\r\n');
    assert.equal(csvCell({ k: 1 }), '"{""k"":1}"');
    assert.equal(csvCell(new Date('2026-01-01T00:00:00Z')), '"2026-01-01T00:00:00.000Z"');
  });

  it('neutraliza fórmulas (CSV injection)', () => {
    for (const value of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx', '\rx', '=HYPERLINK("http://x")']) {
      assert.ok(csvCell(value).startsWith(`"'`), value);
    }
    assert.equal(csvCell('normal'), '"normal"');
  });
});

describe('límites de consulta y exportación de auditoría', () => {
  const from = '2026-01-01T00:00:00Z';

  it('exportación: rango obligatorio de hasta 92 días y como máximo 100.000 filas', () => {
    assert.doesNotThrow(() => assertExportLimits({ from, to: '2026-04-02T00:00:00Z' }, 10));
    const tooLong = () => assertExportLimits({ from, to: '2026-04-04T00:00:00Z' }, 10);
    assert.throws(tooLong, (error) => error.details[0].code === 'range_too_long');
    const tooMany = () => assertExportLimits({ from, to: '2026-01-02T00:00:00Z' }, EXPORT_MAX_ROWS + 1);
    assert.throws(tooMany, (error) => error.details[0].code === 'too_many_rows');
    const reversed = () => assertExportLimits({ from: '2026-01-02T00:00:00Z', to: from }, 1);
    assert.throws(reversed, (error) => error.details[0].code === 'before_from');
  });

  it('consulta: rechaza páginas más allá del máximo sin consultar la base', async () => {
    let queried = false;
    const repository = { count: async () => { queried = true; return 0; }, findPage: async () => [] };
    const service = createAuditLogsService({ db: null, repository, audit: null });
    await assert.rejects(service.list({}, { page: MAX_OFFSET / 100 + 2, pageSize: 100 }), (error) => error.details[0].code === 'too_large');
    assert.equal(queried, false);
  });

  it('exportación: sin re-autenticación reciente responde REAUTH_REQUIRED', async () => {
    const service = createAuditLogsService({ db: null, repository: {}, audit: null });
    await assert.rejects(
      service.exportCsv({ session: { reauthAt: null } }, { from, to: '2026-01-02T00:00:00Z' }, {}),
      (error) => error.code === 'REAUTH_REQUIRED',
    );
  });
});
