import { AppError, ConflictError, ValidationError } from '../../core/errors/errors.js';

// Quota arithmetic (ADR-011) as pure functions. A quota is
// { assigned, reserved, consumed }; available = assigned - reserved - consumed.

export const MAX_ASSIGNED = 10_000_000;

export class GlobalCapReachedError extends AppError {
  constructor() {
    super('Se alcanzó el tope global de envíos del mes', { statusCode: 409, code: 'GLOBAL_CAP_REACHED' });
  }
}

export const available = (quota) => quota.assigned - quota.reserved - quota.consumed;

// Administrator adjustment: never below what is already reserved or used.
export function adjusted(quota, delta) {
  if (!Number.isInteger(delta) || delta === 0) throw new ValidationError([{ field: 'delta', code: 'invalid_value' }]);
  const assigned = quota.assigned + delta;
  if (assigned < quota.reserved + quota.consumed) {
    throw new ValidationError([{ field: 'delta', code: 'below_committed' }],
      'El saldo no puede quedar por debajo de lo reservado y lo consumido');
  }
  if (assigned > MAX_ASSIGNED) throw new ValidationError([{ field: 'delta', code: 'too_large' }]);
  return { ...quota, assigned };
}

export function reserved(quota, amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw new ValidationError([{ field: 'amount', code: 'invalid_value' }]);
  if (available(quota) < amount) throw new ConflictError('Saldo de envíos insuficiente');
  return { ...quota, reserved: quota.reserved + amount };
}

export function released(quota, amount) {
  if (!Number.isInteger(amount) || amount <= 0 || amount > quota.reserved) throw new ConflictError('No hay tanta cuota reservada');
  return { ...quota, reserved: quota.reserved - amount };
}

// Consumes from what was reserved (campaign sends) or, with fromReserve
// false, directly from the available balance (test sends, ADR-011).
export function consumed(quota, amount, { fromReserve = true } = {}) {
  if (!Number.isInteger(amount) || amount <= 0) throw new ValidationError([{ field: 'amount', code: 'invalid_value' }]);
  if (fromReserve) {
    if (amount > quota.reserved) throw new ConflictError('No hay tanta cuota reservada');
    return { ...quota, reserved: quota.reserved - amount, consumed: quota.consumed + amount };
  }
  if (available(quota) < amount) throw new ConflictError('Saldo de envíos insuficiente');
  return { ...quota, consumed: quota.consumed + amount };
}

export function assertWithinCap(sent, amount, cap) {
  if (sent + amount > cap) throw new GlobalCapReachedError();
}
