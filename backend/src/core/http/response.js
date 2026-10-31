// Single response format (A10):
//   { success: true, data, meta? }
//   { success: false, error: { code, message, details?, requestId } }

export function ok(data, meta) {
  return meta === undefined ? { success: true, data } : { success: true, data, meta };
}

export function errorBody(error, requestId) {
  const body = { code: error.code, message: error.message, requestId };
  if (Array.isArray(error.details) && error.details.length > 0) body.details = error.details;
  return { success: false, error: body };
}

// Response schema for a successful route. Fastify serializes only the declared
// fields, so undeclared data never leaves the server.
export function successSchema(dataSchema, metaSchema) {
  const properties = { success: { type: 'boolean' }, data: dataSchema };
  if (metaSchema) properties.meta = metaSchema;
  return { type: 'object', required: ['success', 'data'], additionalProperties: false, properties };
}
