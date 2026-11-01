// Hash router (A9). Each route declares its pattern, the permission needed to
// show it (UX only: the backend is the security boundary), and which session
// stages may see it. Pure matching is exported for unit tests.

export const STAGE_ROUTES = {
  mfa_verify: '/mfa/verificar',
  password_change: '/cambiar-contrasena',
  mfa_enroll: '/mfa/configurar',
};

export function parseHash(hash) {
  const raw = (hash ?? '').replace(/^#/, '') || '/';
  const [path, queryString = ''] = raw.split('?');
  return { path: path.startsWith('/') ? path : `/${path}`, query: Object.fromEntries(new URLSearchParams(queryString)) };
}

export function matchRoute(routes, path) {
  for (const route of routes) {
    const names = [];
    const parts = route.path.split('/').map((part) => {
      if (part.startsWith(':')) {
        names.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    // Built from the developer's route table, never from user input.
    const match = new RegExp(`^${parts.join('/')}$`).exec(path);
    if (match) {
      return { route, params: Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1])])) };
    }
  }
  return null;
}

// Decides what to show: { redirect } or { route, params }.
export function resolve(routes, path, session) {
  const found = matchRoute(routes, path);
  if (!found) return { notFound: true };
  const { route } = found;
  if (route.public) {
    return session?.signedIn && route.guestOnly ? { redirect: '/' } : found;
  }
  if (!session?.signedIn) return { redirect: '/ingresar', returnTo: path };
  const allowedStages = route.stages ?? ['full'];
  if (!allowedStages.includes(session.stage)) {
    return { redirect: session.stage === 'full' ? '/' : STAGE_ROUTES[session.stage] };
  }
  if (route.permission && !session.permissions.has(route.permission)) return { ...found, forbidden: true };
  return found;
}

export function navigate(path) {
  if (window.location.hash !== `#${path}`) window.location.hash = path;
  else window.dispatchEvent(new HashChangeEvent('hashchange'));
}
