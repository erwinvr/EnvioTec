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
  constructor(message = 'Acceso denegado', { code = 'FORBIDDEN', details } = {}) {
    super(message, { statusCode: 403, code, details });
  }
}

// A change outside the user's own area to a record the user can read
// (areas.view_all only widens reading, ADR-026). Audited as denied.
export class AreaWriteDeniedError extends AuthorizationError {
  constructor(resourceType, resourceId) {
    super('Solo puede modificar datos de su área', { code: 'AREA_WRITE_DENIED' });
    this.resourceType = resourceType;
    this.resourceId = resourceId;
  }
}

// Login failure. One message for every cause (wrong password, unknown user,
// locked, disabled or expired account) to prevent user enumeration (A5).
export class InvalidCredentialsError extends AppError {
  constructor() {
    super('Usuario o contraseña incorrectos, o la cuenta está bloqueada temporalmente',
      { statusCode: 401, code: 'INVALID_CREDENTIALS' });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Recurso no encontrado') {
    super(message, { statusCode: 404, code: 'NOT_FOUND' });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflicto con el estado actual del recurso', { details } = {}) {
    super(message, { statusCode: 409, code: 'CONFLICT', details });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Demasiadas solicitudes; intente más tarde', { retryAfterSeconds } = {}) {
    super(message, { statusCode: 429, code: 'RATE_LIMITED' });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Servicio no disponible') {
    super(message, { statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
  }
}
