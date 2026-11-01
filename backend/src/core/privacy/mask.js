// Email masking for listings shown to profiles without contacts.view
// (Parte B): "ana.perez@empresa.com" -> "a*******z@e******.com".
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '***';
  const [local, domain] = [email.slice(0, email.lastIndexOf('@')), email.slice(email.lastIndexOf('@') + 1)];
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const hide = (text) => (text.length <= 2 ? `${text[0] ?? ''}*` : `${text[0]}${'*'.repeat(text.length - 2)}${text.at(-1)}`);
  return `${hide(local)}@${hide(host)}${tld}`;
}
