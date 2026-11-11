// Helpers for parameterized SQL (A8). Values always travel as parameters;
// these only prepare a value for a given operator.

// A search term for ILIKE, matched literally: %, _ and \ lose their meaning.
export const escapeLike = (text) => text.replace(/[\\%_]/g, (char) => `\\${char}`);
