// Building blocks of the route JSON Schemas (A8): every object closed with
// additionalProperties: false, so unknown fields are rejected in input and
// never serialized in output; and the paging shared by every listing (A10).

export const object = (properties, required = [], extra = {}) => ({ type: 'object', additionalProperties: false, required, properties, ...extra });
export const int = { type: 'integer' };
export const uuid = { type: 'string', format: 'uuid' };
export const nullable = { type: ['string', 'null'] };
export const idParams = object({ id: uuid }, ['id']);
// Page size capped at 100 (A10).
export const paging = { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 } };
export const pageMeta = object({ total: int, page: int, pageSize: int }, ['total', 'page', 'pageSize']);
