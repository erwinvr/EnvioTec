// Phase 1 placeholder: shows whether the backend is ready. The real frontend
// core (API client, auth, router, components) arrives in phase 7.
const STATUS_TEXT = {
  ready: 'Servicio disponible',
  unavailable: 'Servicio no disponible',
};

async function showServiceStatus() {
  const status = document.getElementById('service-status');
  let state = 'unavailable';
  try {
    const response = await fetch('/health/ready', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) state = 'ready';
  } catch {
    state = 'unavailable';
  }
  status.textContent = STATUS_TEXT[state];
  status.dataset.state = state;
}

showServiceStatus();
