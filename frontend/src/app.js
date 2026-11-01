// Application entry point (A9): ES modules only, no globals, no inline code.
import { auth, loadSession } from './core/auth.js';
import { el, replace } from './core/dom.js';
import { detectLanguage, setLanguage, t } from './core/i18n.js';
import { navigate, parseHash, resolve } from './core/router.js';
import { loader } from './components/loader.js';
import { renderNavigation } from './components/navigation.js';
import { toast } from './components/toast.js';
import { rememberReturnTo } from './pages/auth/session-flow.js';
import { ROUTES } from './routes.js';

const main = document.getElementById('app');
const header = document.getElementById('nav');
let renderId = 0;

function sessionView() {
  return auth.isSignedIn()
    ? { signedIn: true, stage: auth.stage(), permissions: { has: auth.hasPermission } }
    : { signedIn: false };
}

function message(title, text) {
  return el('div', { className: 'card' }, [el('h1', { text: title }), el('p', { text })]);
}

async function render() {
  const id = ++renderId;
  const { path, query } = parseHash(window.location.hash);
  const outcome = resolve(ROUTES, path, sessionView());
  renderNavigation(header, path, render);
  main.dataset.state = 'loading';
  if (outcome.redirect) {
    if (outcome.returnTo) rememberReturnTo(outcome.returnTo);
    navigate(outcome.redirect);
    return;
  }
  if (outcome.notFound) {
    replace(main, message(t('errors.notFoundTitle'), t('errors.notFound')));
  } else if (outcome.forbidden) {
    replace(main, message(t('errors.forbiddenTitle'), t('errors.forbidden')));
  } else {
    replace(main, loader());
    try {
      const module = await outcome.route.load();
      if (id !== renderId) return;
      await module.render(main, { params: outcome.params, query });
    } catch {
      replace(main, message(t('errors.genericTitle'), t('errors.unexpected')));
    }
  }
  if (id === renderId) {
    main.dataset.state = 'ready';
    main.focus({ preventScroll: true });
  }
}

async function start() {
  setLanguage(detectLanguage(document.cookie, navigator.language));
  try {
    await loadSession();
  } catch {
    toast(t('errors.network'), 'error');
  }
  window.addEventListener('hashchange', async () => {
    // A session can end in the backend at any time (timeout, revocation):
    // the next navigation reloads its state.
    if (auth.isSignedIn()) await loadSession().catch(() => {});
    render();
  });
  render();
}

start();
