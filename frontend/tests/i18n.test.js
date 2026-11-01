import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { detectLanguage, DICTIONARIES, setLanguage, t } from '../src/core/i18n.js';

const SRC = new URL('../src/', import.meta.url).pathname;

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.js') ? [path] : [];
  });
}

// Keys built at run time from known values.
const DYNAMIC = [
  ...['active', 'disabled', 'locked'].map((s) => `users.status.${s}`),
  ...['local', 'ad'].map((s) => `users.source.${s}`),
  ...['success', 'denied', 'failure'].map((s) => `audit.results.${s}`),
  ...['user', 'system', 'anonymous'].map((s) => `audit.actorTypes.${s}`),
];

describe('i18n (Parte B: español e inglés)', () => {
  it('español e inglés tienen exactamente las mismas claves y ningún texto vacío', () => {
    assert.deepEqual(Object.keys(DICTIONARIES.en).sort(), Object.keys(DICTIONARIES.es).sort());
    for (const dictionary of Object.values(DICTIONARIES)) {
      for (const [key, value] of Object.entries(dictionary)) assert.ok(value.trim().length > 0, key);
    }
  });

  it('cada clave usada en el código existe en los diccionarios', () => {
    const used = new Set(DYNAMIC);
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.add(match[1]);
      for (const match of text.matchAll(/label: '([a-z]+\.[a-zA-Z]+)'/g)) used.add(match[1]);
    }
    const missing = [...used].filter((key) => !(key in DICTIONARIES.es));
    assert.deepEqual(missing, []);
  });

  it('interpola variables y elige el idioma por cookie o navegador', () => {
    setLanguage('es');
    assert.equal(t('home.welcome', { name: 'Ana' }), 'Hola, Ana');
    setLanguage('en');
    assert.equal(t('home.welcome', { name: 'Ana' }), 'Hello, Ana');
    assert.equal(t('no.existe'), 'no.existe');
    setLanguage('xx');
    assert.equal(t('nav.home'), 'Inicio');
    assert.equal(detectLanguage('a=1; enviotec_lang=en', 'es-BO'), 'en');
    assert.equal(detectLanguage('enviotec_lang=<script>', 'es-BO'), 'es');
    assert.equal(detectLanguage('', 'en-US'), 'en');
  });
});
