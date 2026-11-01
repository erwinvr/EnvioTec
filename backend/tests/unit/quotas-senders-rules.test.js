import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  adjusted, assertWithinCap, available, consumed, GlobalCapReachedError, MAX_ASSIGNED, released, reserved,
} from '../../src/modules/quotas/quotas.rules.js';
import { assertSenderDomains, domainOf } from '../../src/modules/senders/senders.rules.js';

const q = (assigned, reservedAmount = 0, consumedAmount = 0) => ({ assigned, reserved: reservedAmount, consumed: consumedAmount });
const code = (expected) => (error) => error.code === expected || error.statusCode === expected || error.details?.[0]?.code === expected;

describe('aritmética de cuotas (ADR-011)', () => {
  it('disponible = asignado - reservado - consumido', () => {
    assert.equal(available(q(100, 30, 20)), 50);
  });

  it('ajuste: suma o resta, nunca por debajo de lo comprometido ni sobre el máximo', () => {
    assert.deepEqual(adjusted(q(100, 30, 20), 50), q(150, 30, 20));
    assert.deepEqual(adjusted(q(100, 30, 20), -50), q(50, 30, 20));
    assert.throws(() => adjusted(q(100, 30, 20), -51), code('below_committed'));
    assert.throws(() => adjusted(q(MAX_ASSIGNED), 1), code('too_large'));
    assert.throws(() => adjusted(q(1), 0), code('invalid_value'));
    assert.throws(() => adjusted(q(1), 1.5), code('invalid_value'));
  });

  it('reserva solo con saldo disponible; liberación solo de lo reservado', () => {
    assert.deepEqual(reserved(q(100, 30, 20), 50), q(100, 80, 20));
    assert.throws(() => reserved(q(100, 30, 20), 51), code(409));
    assert.throws(() => reserved(q(100), 0), code('invalid_value'));
    assert.deepEqual(released(q(100, 30), 30), q(100, 0));
    assert.throws(() => released(q(100, 30), 31), code(409));
    assert.throws(() => released(q(100, 30), 0), code(409));
  });

  it('consumo desde la reserva (campañas) o directo del saldo (pruebas)', () => {
    assert.deepEqual(consumed(q(100, 30), 10), q(100, 20, 10));
    assert.throws(() => consumed(q(100, 5), 6), code(409));
    assert.deepEqual(consumed(q(10, 5), 5, { fromReserve: false }), q(10, 5, 5));
    assert.throws(() => consumed(q(10, 5, 5), 1, { fromReserve: false }), code(409));
    assert.throws(() => consumed(q(10), -1), code('invalid_value'));
  });

  it('tope global mensual', () => {
    assert.doesNotThrow(() => assertWithinCap(99999, 1, 100000));
    assert.throws(() => assertWithinCap(99999, 2, 100000), (error) => error instanceof GlobalCapReachedError && error.code === 'GLOBAL_CAP_REACHED');
  });
});

describe('dominios de remitentes', () => {
  const domains = { senderDomains: ['envios.empresa.test'], replyToDomains: ['empresa.test'] };

  it('From del subdominio de envío y Reply-To de un dominio con buzones', () => {
    assert.equal(domainOf('Ana@Envios.Empresa.TEST'), 'envios.empresa.test');
    assert.doesNotThrow(() => assertSenderDomains({ email: 'ventas@envios.empresa.test', replyTo: 'ventas@empresa.test' }, domains));
    assert.doesNotThrow(() => assertSenderDomains({ email: 'ventas@envios.empresa.test', replyTo: null }, domains));
    assert.throws(() => assertSenderDomains({ email: 'ventas@empresa.test' }, domains), code('domain_not_allowed'));
    assert.throws(() => assertSenderDomains({ email: 'x@otro.envios.empresa.test' }, domains), code('domain_not_allowed'));
    assert.throws(() => assertSenderDomains({ replyTo: 'x@envios.empresa.test' }, domains), code('domain_not_allowed'));
  });

  it('sin dominios configurados no se crean remitentes', () => {
    assert.throws(() => assertSenderDomains({ email: 'a@b.test' }, { senderDomains: [], replyToDomains: [] }), code('sender_domains_not_configured'));
  });
});
