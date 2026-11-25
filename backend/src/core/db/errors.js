// SQL Server errors expressed with the SQLSTATE codes the rest of the
// application already understands (A10): the error handler turns 23505 and
// 23503 into 409 without exposing SQL, constraint names or values.
//   51000  THROW from a guard trigger: a rule of the data model (check)
//   51001  THROW from a guard trigger: a forbidden change (append-only, privilege)

const BY_NUMBER = {
  2627: '23505', 2601: '23505',
  515: '23502',
  229: '42501', 230: '42501', 262: '42501', 297: '42501', 300: '42501', 1088: '42501', 3704: '42501', 4902: '42501',
  51000: '23514', 51001: '42501',
  1205: '40P01',
  245: '22P02', 8169: '22P02', 241: '22P02', 8114: '22P02',
  8152: '22001', 2628: '22001',
};

function sqlState(error) {
  const number = error.number ?? error.originalError?.info?.number;
  if (number === 547) return /CHECK constraint/i.test(error.message) ? '23514' : '23503';
  if (BY_NUMBER[number]) return BY_NUMBER[number];
  if (error.code === 'ETIMEOUT') return '57014';
  return null;
}

export function normalizeError(error) {
  // SQL Server reports the cause first and a generic summary last
  // ("Could not create constraint or index. See previous errors.").
  const preceding = error.precedingErrors?.map((item) => item.message).filter(Boolean) ?? [];
  if (preceding.length > 0 && !error.message.includes(preceding[0])) error.message = `${preceding.join(' | ')} | ${error.message}`;
  const code = sqlState(error);
  if (code) {
    error.sqlNumber = error.number;
    error.code = code;
    error.severity = 'ERROR';
  }
  return error;
}
