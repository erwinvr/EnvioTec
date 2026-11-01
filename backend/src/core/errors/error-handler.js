import { errorBody } from '../http/response.js';
import { AppError, NotFoundError, ValidationError } from './errors.js';

// Fastify errors that map to a specific public error. Everything else in the
// 4xx range becomes a generic BAD_REQUEST, and anything else a generic 500.
const FRAMEWORK_ERRORS = {
  FST_ERR_CTP_BODY_TOO_LARGE: { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'La solicitud es demasiado grande' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Tipo de contenido no admitido' },
};

const VALIDATION_CODES = {
  required: 'required',
  additionalProperties: 'unknown_field',
  format: 'invalid_format',
  type: 'invalid_type',
  enum: 'invalid_value',
  minLength: 'too_short',
  maxLength: 'too_long',
  minimum: 'too_small',
  maximum: 'too_large',
  pattern: 'invalid_format',
};

export function toAppError(error) {
  if (error instanceof AppError) return error;
  if (Array.isArray(error.validation)) {
    return new ValidationError(error.validation.map((item) => toValidationDetail(item, error.validationContext)));
  }
  const known = FRAMEWORK_ERRORS[error.code];
  if (known) return new AppError(known.message, known);
  if (error.statusCode >= 400 && error.statusCode < 500) {
    return new AppError('Solicitud inválida', { statusCode: 400, code: 'BAD_REQUEST' });
  }
  return new AppError();
}

function toValidationDetail(item, context) {
  const path = (item.instancePath ?? '').replace(/^\//, '').replaceAll('/', '.');
  const field = item.params?.missingProperty ?? item.params?.additionalProperty ?? path;
  const detail = { field: field || context || 'body', code: VALIDATION_CODES[item.keyword] ?? 'invalid' };
  if (context) detail.location = context;
  return detail;
}

export function errorHandler(error, request, reply) {
  const appError = toAppError(error);
  if (appError.statusCode >= 500) {
    request.log.error({ err: error }, 'request failed');
  } else {
    request.log.info({ errorCode: appError.code, statusCode: appError.statusCode }, 'request rejected');
  }
  if (appError.retryAfterSeconds) reply.header('Retry-After', String(appError.retryAfterSeconds));
  reply.code(appError.statusCode).send(errorBody(appError, request.id));
}

export function notFoundHandler(request, reply) {
  reply.code(404).send(errorBody(new NotFoundError(), request.id));
}
