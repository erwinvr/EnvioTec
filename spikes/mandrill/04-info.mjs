// Polls the status, events and rendered content of the messages from a
// 02-send-batch.mjs result (questions 3 and 5). Sends no email.
// Usage: node 04-info.mjs out/<file>-send-batch.json
import { readFile } from 'node:fs/promises';
import { callApi, isApiError, saveResult } from './lib.mjs';

const sendFile = process.argv[2];
if (!sendFile) {
  console.error('Uso: node 04-info.mjs out/<archivo>-send-batch.json');
  process.exit(1);
}

const sent = JSON.parse(await readFile(sendFile, 'utf8'));
const ids = (Array.isArray(sent.result?.body) ? sent.result.body : []).map((item) => item._id).filter(Boolean);
if (ids.length === 0) {
  console.error('El archivo no tiene IDs de mensajes.');
  process.exit(1);
}

const results = [];
for (const id of ids) {
  const info = await callApi('messages/info', { id });
  const content = await callApi('messages/content', { id });
  results.push({ id, info, content });

  if (isApiError(info)) {
    console.log(`${id}: info no disponible (${info.httpStatus}) ${info.body?.message ?? ''}`);
  } else {
    console.log(`${id}: estado=${info.body.state} aperturas=${info.body.opens} clics=${info.body.clicks} (${info.durationMs} ms)`);
  }
  if (!isApiError(content)) {
    console.log(`  HTML recibido: ${JSON.stringify(content.body.html ?? '').slice(0, 300)}`);
  }
}

await saveResult('info', { campaignId: sent.campaignId, results });
