// Lists the rejection list (unsubscribes, hard bounces, complaints) to check
// how Mandrill records them (question 7). Sends no email.
import { callApi, isApiError, saveResult } from './lib.mjs';

const params = { include_expired: true };
if (process.env.SPIKE_EMAIL) params.email = process.env.SPIKE_EMAIL.trim();

const result = await callApi('rejects/list', params);
if (isApiError(result)) {
  console.error('Error al leer la lista de rechazos:', result.httpStatus, result.body);
} else {
  console.log(`${result.body.length} entradas`);
  for (const item of result.body) {
    console.log(`${item.email}: motivo=${item.reason} creado=${item.created_at} expira=${item.expires_at ?? '-'} expirado=${item.expired}`);
  }
}

await saveResult('rejects', { params, result });
