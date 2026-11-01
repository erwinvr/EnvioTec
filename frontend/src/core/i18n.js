import { en } from '../i18n/en.js';
import { es } from '../i18n/es.js';

// UI texts in Spanish (default) and English (Parte B). The choice is kept in
// a non-sensitive cookie (enviotec_lang = es | en), never in localStorage.

export const DICTIONARIES = { es, en };
export const LANGUAGES = Object.keys(DICTIONARIES);
const COOKIE = 'enviotec_lang';

let current = 'es';

export function detectLanguage(cookieHeader = '', navigatorLanguage = '') {
  const match = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  const fromCookie = match?.slice(COOKIE.length + 1);
  if (LANGUAGES.includes(fromCookie)) return fromCookie;
  return navigatorLanguage.toLowerCase().startsWith('en') ? 'en' : 'es';
}

export function setLanguage(lang, { persist = false } = {}) {
  current = LANGUAGES.includes(lang) ? lang : 'es';
  if (typeof document !== 'undefined') {
    document.documentElement.lang = current;
    if (persist) document.cookie = `${COOKIE}=${current}; Path=/; Max-Age=31536000; Secure; SameSite=Strict`;
  }
}

export function language() {
  return current;
}

// t('users.created', { name }) -> text with {name} replaced. A missing key
// shows the key itself, so it is visible in review instead of breaking.
export function t(key, vars = {}) {
  const text = DICTIONARIES[current][key] ?? DICTIONARIES.es[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined ? whole : String(vars[name])));
}

export function formatDate(value, { time = true } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  const options = time
    ? { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/La_Paz' }
    : { dateStyle: 'medium', timeZone: 'America/La_Paz' };
  return new Intl.DateTimeFormat(current === 'en' ? 'en-US' : 'es-BO', options).format(date);
}
