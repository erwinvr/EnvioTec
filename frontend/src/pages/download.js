import { el } from '../core/dom.js';

// Saves a fetch Response (CSV export) as a file through a blob: URL.
export async function saveResponse(response, fileName) {
  const url = URL.createObjectURL(await response.blob());
  const link = el('a', { attrs: { href: url, download: fileName } });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
