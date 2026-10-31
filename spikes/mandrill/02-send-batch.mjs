// Sends ONE batch to up to 5 test mailboxes with per-recipient merge vars,
// a PDF attachment, metadata, tracking and an unsubscribe link.
// Answers questions 1, 2, 3, 6 and 7 of docs/spikes/0.5-mandrill.md.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { callApi, isApiError, requireEnv, saveResult } from './lib.mjs';

const MAX_RECIPIENTS = 5;
const MAX_PDF_BYTES = 5 * 1024 * 1024;

// Values that must arrive escaped (as visible text) in the received email.
const ESCAPE_PROBES = {
  probe_html: '<b>negrita</b>',
  probe_attr: '"><img src=x onerror=alert(1)>',
  probe_entity: 'A &amp; B &lt; C',
};

if (requireEnv('SPIKE_CONFIRM_SEND') !== 'si') {
  console.error('SPIKE_CONFIRM_SEND debe ser "si" para enviar.');
  process.exit(1);
}

const fromEmail = requireEnv('SPIKE_FROM_EMAIL');
const recipients = requireEnv('SPIKE_TO').split(',').map((email) => email.trim()).filter(Boolean);
const pdfPath = requireEnv('SPIKE_PDF');
const mergeLanguage = process.env.SPIKE_MERGE_LANGUAGE ?? 'mailchimp';
const unsubRedirect = process.env.SPIKE_UNSUB_REDIRECT ?? 'https://www.example.com/';

if (recipients.length === 0 || recipients.length > MAX_RECIPIENTS) {
  console.error(`SPIKE_TO debe tener entre 1 y ${MAX_RECIPIENTS} direcciones.`);
  process.exit(1);
}
if (!['mailchimp', 'handlebars'].includes(mergeLanguage)) {
  console.error('SPIKE_MERGE_LANGUAGE debe ser "mailchimp" o "handlebars".');
  process.exit(1);
}

const pdf = await readFile(pdfPath);
if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-' || pdf.length > MAX_PDF_BYTES) {
  console.error('SPIKE_PDF no es un PDF o supera 5 MB.');
  process.exit(1);
}

const tag = (name) => (mergeLanguage === 'mailchimp' ? `*|${name.toUpperCase()}|*` : `{{${name}}}`);
const unsubTag = mergeLanguage === 'mailchimp'
  ? `*|UNSUB:${unsubRedirect}|*`
  : `{{unsub "${unsubRedirect}"}}`;

const html = [
  `<p>Hola ${tag('first_name')},</p>`,
  `<p>HTML: ${tag('probe_html')}</p>`,
  `<p title="${tag('probe_attr')}">Atributo: ${tag('probe_attr')}</p>`,
  `<p>Entidad: ${tag('probe_entity')}</p>`,
  '<p><a href="https://www.example.com/clic">Enlace para probar clics</a></p>',
  // Single quotes: the handlebars unsub helper uses double quotes inside.
  `<p><a href='${unsubTag}'>Darse de baja</a></p>`,
].join('\n');

const campaignId = randomUUID();
const recipientIds = new Map(recipients.map((email) => [email, randomUUID()]));

const message = {
  html,
  subject: `Spike EnvioTec ${tag('first_name')}`,
  from_email: fromEmail,
  from_name: 'EnvioTec spike',
  to: recipients.map((email) => ({ email, type: 'to' })),
  preserve_recipients: false,
  merge: true,
  merge_language: mergeLanguage,
  merge_vars: recipients.map((email, index) => ({
    rcpt: email,
    vars: [
      { name: 'first_name', content: `Destinatario ${index + 1}` },
      ...Object.entries(ESCAPE_PROBES).map(([name, content]) => ({ name, content })),
    ],
  })),
  metadata: { campaign_id: campaignId },
  recipient_metadata: recipients.map((email) => ({
    rcpt: email,
    values: { recipient_id: recipientIds.get(email) },
  })),
  attachments: [{ type: 'application/pdf', name: 'spike.pdf', content: pdf.toString('base64') }],
  track_opens: true,
  track_clicks: true,
};

const requestBytes = Buffer.byteLength(JSON.stringify({ message }));
console.log(`Campaña ${campaignId}: ${recipients.length} destinatarios, ${requestBytes} bytes en la petición, lenguaje ${mergeLanguage}`);

const result = await callApi('messages/send', { message });
if (isApiError(result)) {
  console.error('Mandrill rechazó el lote:', result.httpStatus, result.body);
} else {
  for (const item of result.body) {
    console.log(`${item.email}: estado=${item.status} _id=${item._id} motivo=${item.reject_reason ?? '-'}`);
  }
}

const { attachments, ...messageWithoutPdf } = message;
await saveResult('send-batch', {
  campaignId,
  recipientIds: Object.fromEntries(recipientIds),
  requestBytes,
  message: { ...messageWithoutPdf, attachments: [{ name: attachments[0].name, bytes: pdf.length }] },
  result,
});
