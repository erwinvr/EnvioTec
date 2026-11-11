import { readFile } from 'node:fs/promises';

// What the parts of the campaign sender share (ADR-005, ADR-024): the system
// actor, Mandrill's accepted statuses, audit events of the worker, and the
// content of a campaign ready to build messages.

export const SYSTEM = { type: 'system' };
export const ACCEPTED = new Set(['sent', 'queued', 'scheduled']);

export function createSenderContext({ repository, store, audit }) {
  // Stays within the 64 characters of audit_logs.request_id.
  const context = (kind, id) => ({ requestId: `job:${kind.replace(/^campaign\./, '')}:${id}`.slice(0, 64) });
  const event = (client, action, resourceType, id, result, metadata) => audit.record(client, {
    actor: SYSTEM, action, resourceType, resourceId: id, result, context: context(action, id), metadata,
  });

  async function readBase64(id) {
    return (await readFile(store.pathOf('stored', id))).toString('base64');
  }

  // Template, sender and PDF of a campaign (or of a test send's campaign);
  // null when something needed is no longer usable.
  async function contentOf(client, campaign) {
    const row = await repository.content(client, campaign);
    // The PDF is optional (ADR-027); if the campaign has one, it must be the inspected one.
    if (!row || !row.sender_active || (campaign.attachment_id && row.attachment_status !== 'ready')) return null;
    const images = [];
    for (const image of row.images) images.push({ cid: image.cid, contentType: image.contentType, base64: await readBase64(image.fileId) });
    return {
      content: { html: row.html, text: row.text_body, variables: row.variables, types: row.types ?? {}, images },
      sender: { email: row.sender_email, display_name: row.display_name, reply_to: row.reply_to },
      attachment: row.attachment_file ? { name: row.attachment_name, base64: await readBase64(row.attachment_file) } : null,
    };
  }

  return { context, event, contentOf };
}
