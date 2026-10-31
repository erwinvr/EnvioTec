// Searches messages by metadata, as needed to reconcile an ambiguous batch
// (ADR-005, question 4). Sends no email.
import { callApi, isApiError, requireEnv, saveResult } from './lib.mjs';

const campaignId = requireEnv('SPIKE_CAMPAIGN_ID');
const query = process.env.SPIKE_QUERY ?? `u_campaign_id:${campaignId}`;
const dateFrom = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const result = await callApi('messages/search', { query, date_from: dateFrom, limit: 100 });
if (isApiError(result)) {
  console.error('Error en la búsqueda:', result.httpStatus, result.body);
} else {
  console.log(`Consulta "${query}": ${result.body.length} mensajes`);
  for (const item of result.body) {
    console.log(`${item._id}: estado=${item.state} aperturas=${item.opens} clics=${item.clicks} metadata=${JSON.stringify(item.metadata)}`);
  }
}

await saveResult('search', { query, dateFrom, result });
