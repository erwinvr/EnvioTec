// Values as they leave the API: timestamps as ISO 8601 in UTC, or null.
export const iso = (value) => (value ? value.toISOString() : null);
