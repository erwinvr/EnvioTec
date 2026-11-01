// Validation of a distinguished name (RFC 4514) without regular expressions
// over the whole string: splits on unescaped commas and checks each RDN.

const ATTRIBUTE = /^[A-Za-z][A-Za-z0-9-]*$/;
export const MAX_DN_LENGTH = 500;

export function isValidDn(dn) {
  if (typeof dn !== 'string' || dn.length < 3 || dn.length > MAX_DN_LENGTH) return false;
  const rdns = [];
  let current = '';
  for (let i = 0; i < dn.length; i += 1) {
    const char = dn[i];
    if (char === '\\') {
      if (i + 1 >= dn.length) return false;
      current += char + dn[i + 1];
      i += 1;
    } else if (char === ',') {
      rdns.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  rdns.push(current);
  return rdns.every((rdn) => {
    const separator = rdn.indexOf('=');
    if (separator <= 0) return false;
    const attribute = rdn.slice(0, separator).trim();
    const value = rdn.slice(separator + 1).trim();
    return ATTRIBUTE.test(attribute) && value.length > 0;
  });
}
