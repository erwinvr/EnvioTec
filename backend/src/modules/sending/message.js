import { formatDate, isDateVariable } from '../contacts/dates.js';

// Builds the Mandrill message of a batch (ADR-005, ADR-013, ADR-024).
//
// Variables are escaped exactly once, by EnvioTec: the stored template uses
// {{name}}; here the HTML gets {{{name}}} (inserted as-is by Mandrill's
// handlebars) with the value HTML-escaped by us, and the text part gets
// {{{name__text}}} with the raw value. So the result does not depend on how
// Mandrill escapes, and a value can never inject markup.

const VARIABLE = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g;
const CONTROL = (code) => (code < 32 && code !== 9 && code !== 10) || code === 127;

export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const plain = (value) => [...String(value ?? '')].filter((char) => !CONTROL(char.codePointAt(0))).join('');

export function toMergeHtml(html) {
  return html.replace(VARIABLE, (_, name) => `{{{${name}}}}`);
}

export function toMergeText(text) {
  return text.replace(VARIABLE, (_, name) => `{{{${name}__text}}}`);
}

// Date variables (ADR-030) are stored as AAAA-MM-DD and merged as DD/MM/AAAA.
export function recipientValues(recipient, variables, types = {}) {
  const values = { email: recipient.email, first_name: recipient.first_name, last_name: recipient.last_name, ...recipient.attributes };
  for (const name of variables) if (isDateVariable(types, name) && values[name]) values[name] = formatDate(values[name]);
  return variables.flatMap((name) => [
    { name, content: escapeHtml(plain(values[name] ?? '')) },
    { name: `${name}__text`, content: plain(values[name] ?? '') },
  ]);
}

// `content`: { html, text, variables, images: [{ cid, contentType, base64 }] }
// `attachment`: { name, base64 }   `sender`: { email, display_name, reply_to }
export function buildMessage({ campaignId, batchId, subject, content, sender, attachment, recipients }) {
  const message = {
    subject,
    html: toMergeHtml(content.html),
    text: toMergeText(content.text),
    from_email: sender.email,
    from_name: sender.display_name,
    to: recipients.map((r) => ({ email: r.email, type: 'to' })),
    preserve_recipients: false,
    merge: true,
    merge_language: 'handlebars',
    merge_vars: recipients.map((r) => ({ rcpt: r.email, vars: recipientValues(r, content.variables, content.types) })),
    track_opens: true,
    track_clicks: true,
    auto_text: false,
    view_content_link: false,
    tags: ['enviotec-campaign'],
    metadata: { campaign_id: campaignId, batch_id: batchId },
    recipient_metadata: recipients.map((r) => ({ rcpt: r.email, values: { recipient_id: r.id } })),
    attachments: attachment ? [{ type: 'application/pdf', name: attachment.name, content: attachment.base64 }] : [],
    images: content.images.map((image) => ({ type: image.contentType, name: image.cid, content: image.base64 })),
  };
  if (sender.reply_to) message.headers = { 'Reply-To': sender.reply_to };
  return message;
}
