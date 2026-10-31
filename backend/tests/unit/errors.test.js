import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toAppError } from '../../src/core/errors/error-handler.js';
import {
  AppError, AuthenticationError, AuthorizationError, ConflictError, NotFoundError,
  RateLimitError, ServiceUnavailableError, ValidationError,
} from '../../src/core/errors/errors.js';
import { errorBody, ok, successSchema } from '../../src/core/http/response.js';

describe('clases de error', () => {
  it('asignan el código HTTP y el código público esperados', () => {
    const cases = [
      [new ValidationError(), 422, 'VALIDATION_ERROR'],
      [new AuthenticationError(), 401, 'AUTHENTICATION_REQUIRED'],
      [new AuthorizationError(), 403, 'FORBIDDEN'],
      [new NotFoundError(), 404, 'NOT_FOUND'],
      [new ConflictError(), 409, 'CONFLICT'],
      [new RateLimitError(), 429, 'RATE_LIMITED'],
      [new ServiceUnavailableError(), 503, 'SERVICE_UNAVAILABLE'],
      [new AppError(), 500, 'INTERNAL_ERROR'],
    ];
    for (const [error, statusCode, code] of cases) {
      assert.equal(error.statusCode, statusCode);
      assert.equal(error.code, code);
      assert.ok(error instanceof AppError);
    }
  });
});

describe('toAppError', () => {
  it('convierte errores desconocidos en un 500 genérico sin el mensaje original', () => {
    const result = toAppError(new Error('relation "users" does not exist at /app/src/x.js'));
    assert.equal(result.statusCode, 500);
    assert.equal(result.message, 'Error interno');
  });

  it('traduce errores de validación de Fastify a detalles por campo', () => {
    const error = Object.assign(new Error('validation'), {
      validationContext: 'body',
      validation: [
        { keyword: 'required', instancePath: '', params: { missingProperty: 'email' } },
        { keyword: 'additionalProperties', instancePath: '', params: { additionalProperty: 'status' } },
        { keyword: 'format', instancePath: '/contact/email', params: {} },
        { keyword: 'custom', instancePath: '', params: {} },
      ],
    });
    const result = toAppError(error);
    assert.equal(result.statusCode, 422);
    assert.deepEqual(result.details, [
      { field: 'email', code: 'required', location: 'body' },
      { field: 'status', code: 'unknown_field', location: 'body' },
      { field: 'contact.email', code: 'invalid_format', location: 'body' },
      { field: 'body', code: 'invalid', location: 'body' },
    ]);
  });

  it('traduce errores conocidos del framework y los 4xx genéricos', () => {
    assert.equal(toAppError(Object.assign(new Error(), { code: 'FST_ERR_CTP_BODY_TOO_LARGE' })).statusCode, 413);
    assert.equal(toAppError(Object.assign(new Error(), { code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' })).statusCode, 415);
    const generic = toAppError(Object.assign(new Error('Unexpected token } in JSON'), { statusCode: 400 }));
    assert.equal(generic.code, 'BAD_REQUEST');
    assert.equal(generic.message, 'Solicitud inválida');
  });
});

describe('formato de respuesta', () => {
  it('construye respuestas de éxito y de error', () => {
    assert.deepEqual(ok({ a: 1 }), { success: true, data: { a: 1 } });
    assert.deepEqual(ok([], { total: 0 }), { success: true, data: [], meta: { total: 0 } });
    assert.deepEqual(errorBody(new NotFoundError(), 'req-1'), {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Recurso no encontrado', requestId: 'req-1' },
    });
    const withDetails = errorBody(new ValidationError([{ field: 'x', code: 'required' }]), 'req-2');
    assert.deepEqual(withDetails.error.details, [{ field: 'x', code: 'required' }]);
  });

  it('el schema de éxito rechaza propiedades no declaradas', () => {
    const schema = successSchema({ type: 'object' }, { type: 'object' });
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.properties.meta);
  });
});
