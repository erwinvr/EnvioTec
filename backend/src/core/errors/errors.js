// Application errors. The message is safe to show to the client; anything
// internal goes to the logs through `cause`.

export class AppError extends Error {
  constructor(message = 'Error interno', { statusCode = 500, code = 'INTERNAL_ERROR', details, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(details = [], message = 'Datos inválidos') {
    super(message, { statusCode: 422, code: 'VALIDATION_ERROR', details });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Autenticación requerida') {
    super(message, { statusCode: 401, code: 'AUTHENTICATION_REQUIRED' });
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Acceso denegado') {
    super(message, { statusCode: 403, code: 'FORBIDDEN' });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Recurso no encontrado') {
    super(message, { statusCode: 404, code: 'NOT_FOUND' });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflicto con el estado actual del recurso') {
    super(message, { statusCode: 409, code: 'CONFLICT' });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Demasiadas solicitudes; intente más tarde') {
    super(message, { statusCode: 429, code: 'RATE_LIMITED' });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Servicio no disponible') {
    super(message, { statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
  }
}
