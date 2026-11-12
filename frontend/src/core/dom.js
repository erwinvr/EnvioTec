// The only way pages create DOM nodes (A9). Text always goes through
// textContent; attributes through an allowlist; event handlers as functions,
// never as strings. innerHTML and similar sinks are banned by ESLint and by
// Trusted Types in the CSP.

const BLOCKED_ATTRIBUTES = /^(on|style$|srcdoc$|formaction$)/i;
const URL_ATTRIBUTES = new Set(['href', 'src', 'action']);

// Only relative URLs, the app's own hash routes, https:, mailto: and the
// data:/blob: URLs the app itself creates (QR image, CSV download).
export function isSafeUrl(value) {
  const text = String(value).trim();
  if (text.startsWith('#') || (text.startsWith('/') && !text.startsWith('//'))) return true;
  if (text.startsWith('data:image/svg+xml;base64,') || text.startsWith('data:image/png;base64,')) return true;
  return /^(https:|mailto:|blob:)/i.test(text);
}

export function setAttribute(node, name, value) {
  if (BLOCKED_ATTRIBUTES.test(name)) throw new Error(`attribute not allowed: ${name}`);
  if (URL_ATTRIBUTES.has(name.toLowerCase()) && !isSafeUrl(value)) throw new Error(`unsafe URL in ${name}`);
  node.setAttribute(name, String(value));
}

// el('button', { text, className, attrs: { type: 'submit' }, on: { click } }, [children])
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  const { text, className, attrs, dataset, on, value, checked, disabled, hidden } = props;
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  for (const [name, attrValue] of Object.entries(attrs ?? {})) {
    if (attrValue !== undefined && attrValue !== null && attrValue !== false) setAttribute(node, name, attrValue === true ? '' : attrValue);
  }
  for (const [name, dataValue] of Object.entries(dataset ?? {})) node.dataset[name] = String(dataValue);
  for (const [event, handler] of Object.entries(on ?? {})) node.addEventListener(event, handler);
  if (value !== undefined) node.value = value;
  if (checked !== undefined) node.checked = checked;
  if (disabled !== undefined) node.disabled = disabled;
  if (hidden !== undefined) node.hidden = hidden;
  append(node, children);
  return node;
}

// SVG for charts and icons: same rules as el(), and no links at all (href,
// xlink:href), so an SVG node can never point anywhere.
const SVG_NS = 'http://www.w3.org/2000/svg';
const BLOCKED_SVG_ATTRIBUTES = /^(on|style$|href$|xlink:href$)/i;

export function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (BLOCKED_SVG_ATTRIBUTES.test(name)) throw new Error(`attribute not allowed: ${name}`);
    node.setAttribute(name, String(value));
  }
  return append(node, children);
}

export function append(parent, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function replace(node, children) {
  clear(node);
  return append(node, children);
}
