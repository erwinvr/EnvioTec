import { setSession } from '../../core/auth.js';
import { navigate, STAGE_ROUTES } from '../../core/router.js';

// After any response that describes the session (login, MFA, password
// change), go to the pending step or to where the user was going.
let returnTo = null;

export function rememberReturnTo(path) {
  if (path && !path.startsWith('/ingresar')) returnTo = path;
}

export function continueSession(session) {
  setSession(session);
  if (session.stage !== 'full') {
    navigate(STAGE_ROUTES[session.stage]);
    return;
  }
  const target = returnTo ?? '/';
  returnTo = null;
  navigate(target);
}
