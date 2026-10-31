// Verifies the key and reads account limits and sending domains.
// Sends no email.
import { callApi, isApiError, saveResult } from './lib.mjs';

const ping = await callApi('users/ping2');
if (isApiError(ping)) {
  console.error('La API key no es válida o no hay conexión:', ping.httpStatus, ping.body);
  process.exit(1);
}

const info = await callApi('users/info');
const domains = await callApi('senders/domains');

console.log('Ping:', ping.body);
console.log('Reputación:', info.body?.reputation, '| Cuota por hora:', info.body?.hourly_quota, '| Backlog:', info.body?.backlog);
for (const domain of Array.isArray(domains.body) ? domains.body : []) {
  console.log(`Dominio ${domain.domain}: DKIM válido=${domain.dkim?.valid} SPF válido=${domain.spf?.valid} verificado=${Boolean(domain.verified_at)}`);
}

await saveResult('ping', { ping, info, domains });
