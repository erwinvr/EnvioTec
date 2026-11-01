import { actorFrom } from '../../core/audit/audit.service.js';
import { areaScopeFor, } from '../../core/authorization/area-scope.js';
import { hasPermission } from '../../core/authorization/authorization.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError, NotFoundError, ValidationError } from '../../core/errors/errors.js';
import { FileTooLargeError } from '../../core/files/storage.js';
import { maskEmail } from '../../core/privacy/mask.js';
import { safeFileName } from '../contacts/contacts.service.js';
import { assertStatus, cleanSubject, editOutcome } from './campaign-rules.js';
import { MAX_BYTES } from './pdf-rules.js';

// Campaign data (Parte B): template version + list + PDF + sender +
// schedule, all of the campaign's own area. Editing a submitted, approved
// or scheduled campaign returns it to draft and releases its reservation.

const iso = (value) => value?.toISOString() ?? null;

export function toCampaign(row) {
  return {
    id: row.id, areaId: row.area_id, areaName: row.area_name, name: row.name, status: row.status, subject: row.subject,
    scheduledAt: iso(row.scheduled_at),
    template: { id: row.template_id, name: row.template_name, version: row.template_version, versionId: row.template_version_id },
    list: { id: row.list_id, name: row.list_name },
    sender: { id: row.sender_id, email: row.sender_email, name: row.sender_name },
    attachment: row.attachment_id ? { id: row.attachment_id, name: row.attachment_name, status: row.attachment_status, failureReason: row.attachment_failure } : null,
    createdBy: row.created_by_username, submittedBy: row.submitted_by_username, submittedAt: iso(row.submitted_at),
    approvedBy: row.approved_by_username, approvedAt: iso(row.approved_at), rejectionReason: row.rejection_reason,
    cancelReason: row.cancel_reason, cancelledAt: iso(row.cancelled_at), startedAt: iso(row.started_at), finishedAt: iso(row.finished_at),
    recipientCount: row.recipient_count, reserved: row.reserved, createdAt: iso(row.created_at),
  };
}

export function createCampaignsService({ db, repository, audit, quotas, store, fileQueue }) {
  const record = (client, auth, context, action, id, metadata) => audit.record(client, {
    actor: actorFrom(auth), action, resourceType: 'campaign', resourceId: id, result: 'success', context, metadata,
  });

  async function inScope(client, auth, id, options) {
    const row = await repository.find(client, areaScopeFor(auth), id, options);
    if (!row) throw new NotFoundError();
    return row;
  }

  // Every referenced object must exist in the campaign's area.
  async function resolveReferences(client, areaId, input) {
    const templateVersionId = input.templateVersionId ?? await repository.latestReadyVersion(client, input.templateId, areaId);
    const refs = await repository.references(client, areaId, { templateVersionId, listId: input.listId, senderId: input.senderId });
    const problems = [];
    if (!refs.version || refs.version.is_archived) problems.push({ field: 'templateId', code: 'invalid_template' });
    if (!refs.list) problems.push({ field: 'listId', code: 'invalid_list' });
    if (!refs.sender || !refs.sender.is_active) problems.push({ field: 'senderId', code: 'invalid_sender' });
    if (problems.length > 0) throw new ValidationError(problems);
    return templateVersionId;
  }

  function scheduleOf(value) {
    if (!value) return null;
    if (new Date(value) <= new Date()) throw new ValidationError([{ field: 'scheduledAt', code: 'in_the_past' }]);
    return value;
  }

  return {
    inScope,

    async list(auth, { status, page, pageSize }) {
      const { rows, total } = await repository.list(db, areaScopeFor(auth), { status, limit: pageSize, offset: (page - 1) * pageSize });
      return { items: rows.map(toCampaign), total };
    },

    async get(auth, id) {
      return toCampaign(await inScope(db, auth, id));
    },

    // The campaign belongs to the area of its list, which must be within the
    // creator's scope; template and sender must be of that same area.
    async create(auth, input, context) {
      const areaId = await repository.listArea(db, areaScopeFor(auth), input.listId);
      if (!areaId) throw new ValidationError([{ field: 'listId', code: 'invalid_list' }]);
      return withTransaction(db, async (client) => {
        const templateVersionId = await resolveReferences(client, areaId, input);
        const id = await repository.create(client, {
          ...input, areaId, templateVersionId, subject: cleanSubject(input.subject), scheduledAt: scheduleOf(input.scheduledAt), actorId: auth.user.id,
        });
        await record(client, auth, context, 'campaign.create', id, { name: input.name, listId: input.listId, templateVersionId });
        return toCampaign(await repository.find(client, { all: true }, id));
      });
    },

    async update(auth, id, changes, context) {
      return withTransaction(db, async (client) => {
        const before = await inScope(client, auth, id, { forUpdate: true });
        const outcome = editOutcome(before);
        const merged = {
          name: changes.name ?? before.name,
          subject: cleanSubject(changes.subject ?? before.subject),
          templateId: changes.templateId ?? before.template_id,
          templateVersionId: changes.templateId ? undefined : (changes.templateVersionId ?? before.template_version_id),
          listId: changes.listId ?? before.list_id,
          senderId: changes.senderId ?? before.sender_id,
          scheduledAt: 'scheduledAt' in changes ? scheduleOf(changes.scheduledAt) : before.scheduled_at,
        };
        merged.templateVersionId = await resolveReferences(client, before.area_id, merged);
        if (outcome.releaseReservation && before.reserved > 0) {
          await quotas.release(client, { userId: before.created_by, amount: before.reserved, campaignId: id, actor: actorFrom(auth), context });
        }
        if (outcome.backToDraft) await repository.resetToDraft(client, id);
        await repository.update(client, id, merged, auth.user.id);
        await record(client, auth, context, 'campaign.update', id, {
          fields: Object.keys(changes), previousStatus: before.status, backToDraft: outcome.backToDraft, released: outcome.releaseReservation ? before.reserved : 0,
        });
        return toCampaign(await repository.find(client, { all: true }, id));
      });
    },

    async remove(auth, id, context) {
      await withTransaction(db, async (client) => {
        const campaign = await inScope(client, auth, id, { forUpdate: true });
        assertStatus(campaign, ['draft'], 'Solo se borran borradores');
        await repository.delete(client, id);
        await record(client, auth, context, 'campaign.delete', id, { name: campaign.name });
      });
    },

    // The single PDF of the campaign (Parte B): inspected in the
    // file-processor; only while the campaign is a draft.
    async uploadAttachment(auth, id, file, context) {
      const campaign = await inScope(db, auth, id);
      assertStatus(campaign, ['draft'], 'El PDF solo se cambia en borrador');
      if (!file) throw new ValidationError([{ field: 'file', code: 'required' }]);
      const originalName = safeFileName(file.filename);
      if (!originalName.toLowerCase().endsWith('.pdf')) {
        file.file.resume();
        throw new ValidationError([{ field: 'file', code: 'not_pdf' }], 'Solo se acepta un archivo .pdf');
      }
      let saved;
      try {
        saved = await store.saveIncoming(file.file, { maxBytes: MAX_BYTES });
      } catch (error) {
        if (error instanceof FileTooLargeError) throw new AppError('El PDF supera 5 MB', { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
        throw error;
      }
      const attachmentId = await withTransaction(db, async (client) => {
        const locked = await inScope(client, auth, id, { forUpdate: true });
        assertStatus(locked, ['draft'], 'El PDF solo se cambia en borrador');
        const created = await repository.createAttachment(client, { areaId: locked.area_id, file: saved, originalName, actorId: auth.user.id });
        await repository.setAttachment(client, id, created);
        await record(client, auth, context, 'campaign.attachment_upload', id, { originalName, sizeBytes: saved.size, sha256: saved.sha256 });
        return created;
      });
      try {
        await fileQueue.add('campaign_pdf', { kind: 'campaign_pdf', fileId: saved.id, attachmentId }, { jobId: saved.id });
      } catch (error) {
        await repository.finishAttachment(db, attachmentId, { status: 'failed', failureReason: 'queue_unavailable' });
        await store.remove('incoming', saved.id);
        throw error;
      }
      return toCampaign(await repository.find(db, { all: true }, id));
    },

    // Snapshot of recipients; emails masked without contacts.view (Parte B).
    async recipients(request, id, { page, pageSize }) {
      await inScope(db, request.auth, id);
      const unmasked = hasPermission(request, 'contacts.view');
      const { rows, total } = await repository.recipients(db, id, { limit: pageSize, offset: (page - 1) * pageSize });
      return {
        total,
        items: rows.map((row) => ({
          id: row.id, email: unmasked ? row.email : maskEmail(row.email), firstName: unmasked ? row.first_name : null,
          lastName: unmasked ? row.last_name : null, status: row.status, sentAt: iso(row.sent_at), error: row.error,
        })),
      };
    },
  };
}
