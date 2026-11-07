// Device, operating system and mail client of an open or click, derived from
// the user agent Mandrill reports (ADR-029). Pattern lists, no dependency:
// the goal is a readable report, not an exhaustive classification. Image
// proxies (Gmail, Yahoo, Apple) fetch the tracking pixel on behalf of the
// reader, so they are reported as such; Gmail's proxy sends no user agent
// and comes from Google addresses.

const PROXIES = [
  [/GoogleImageProxy|ggpht\.com/i, 'Gmail (proxy de imágenes)'],
  [/YahooMailProxy/i, 'Yahoo (proxy de imágenes)'],
];
const OS = [
  [/iPhone|iPad|iPod/, 'iOS'], [/Android/, 'Android'], [/Windows/, 'Windows'], [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'], [/Linux/, 'Linux'],
];
const CLIENTS = [
  [/Outlook|Microsoft Office/i, 'Outlook'], [/Thunderbird/i, 'Thunderbird'], [/Edg\//, 'Edge'], [/OPR\//, 'Opera'],
  [/Firefox\//, 'Firefox'], [/Chrome\//, 'Chrome'], [/AppleWebKit/, 'Apple Mail / Safari'],
];

const first = (table, text) => table.find(([pattern]) => pattern.test(text))?.[1] ?? null;
// Google's ranges used by its image proxy (66.249/16, 74.125/16, 66.102/16).
const isGoogleProxyIp = (ip) => typeof ip === 'string' && /^(66\.249|74\.125|66\.102)\./.test(ip);

export function describeAgent({ ua, ip }) {
  const agent = typeof ua === 'string' ? ua.slice(0, 500) : '';
  const proxy = first(PROXIES, agent) ?? (agent === '' && isGoogleProxyIp(ip) ? 'Gmail (proxy de imágenes)' : null);
  if (proxy) return { device: 'proxy', os: null, client: proxy };
  if (agent === '') return { device: null, os: null, client: null };
  const os = first(OS, agent);
  const device = /iPad|Tablet/i.test(agent) ? 'tablet' : (/Mobi|iPhone|Android/i.test(agent) ? 'mobile' : 'desktop');
  return { device, os, client: first(CLIENTS, agent) };
}
