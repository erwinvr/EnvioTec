import { ConflictError, ValidationError } from '../../core/errors/errors.js';
import { FIXED_VARIABLES } from '../templates/template-rules.js';

// Campaign rules (Parte B, ADR-011) as pure functions.
//   draft -> submitted -> approved | scheduled -> sending <-> paused -> completed
//   any state before completion -> cancelled; submitted -> draft (rejected)
//   approved / scheduled without sends started -> draft when edited

export const STATUSES = Object.freeze(['draft', 'submitted', 'approved', 'scheduled', 'sending', 'paused', 'completed', 'cancelled']);
const EDITABLE = new Set(['draft', 'submitted', 'approved', 'scheduled']);
const CANCELLABLE = new Set(['submitted', 'approved', 'scheduled', 'sending', 'paused']);

export function assertStatus(campaign, allowed, message = 'La acción no es posible en el estado actual de la campaña') {
  if (!allowed.includes(campaign.status)) throw new ConflictError(message);
}

// Editing a submitted, approved or scheduled campaign returns it to draft
// (and the caller releases the reservation); while sending, never.
export function editOutcome(campaign) {
  if (!EDITABLE.has(campaign.status) || campaign.started_at) {
    throw new ConflictError('Una campaña que ya empezó a enviarse no se edita; solo se puede cancelar');
  }
  return { backToDraft: campaign.status !== 'draft', releaseReservation: campaign.status === 'approved' || campaign.status === 'scheduled' };
}

export function assertCancellable(campaign) {
  if (!CANCELLABLE.has(campaign.status)) throw new ConflictError('La campaña no se puede cancelar en su estado actual');
}

// Parte B: nobody approves a campaign they submitted.
export function assertApprover(campaign, approverId) {
  if (campaign.submitted_by === approverId) throw new ConflictError('Nadie aprueba una campaña que envió a aprobación');
}

// ADR-013: every template variable must exist in the chosen list.
export function missingVariables(templateVariables, listAttributes) {
  const available = new Set([...FIXED_VARIABLES, ...listAttributes]);
  return templateVariables.filter((name) => !available.has(name));
}

export function assertReadyToSubmit({ campaign, version, list, sender, attachment, recipientsInList }) {
  const problems = [];
  if (!version || version.status !== 'ready') problems.push({ field: 'templateVersionId', code: 'template_not_ready' });
  if (!sender || !sender.is_active) problems.push({ field: 'senderId', code: 'sender_inactive' });
  if (!attachment || attachment.status !== 'ready') problems.push({ field: 'attachment', code: 'attachment_missing' });
  if (!campaign.subject) problems.push({ field: 'subject', code: 'required' });
  if (campaign.scheduled_at && new Date(campaign.scheduled_at) <= new Date()) problems.push({ field: 'scheduledAt', code: 'in_the_past' });
  if (recipientsInList === 0) problems.push({ field: 'listId', code: 'empty_list' });
  if (version && list) {
    for (const name of missingVariables(version.variables, list.attributes)) problems.push({ field: 'templateVersionId', code: 'missing_variable', variable: name });
  }
  if (problems.length > 0) throw new ValidationError(problems.map(({ field, code }) => ({ field, code })), 'La campaña no está lista para aprobación');
}

// Test sends (Parte B): to the user's own email or to an allowed internal
// domain only, and at most N per user per day.
export function assertTestRecipient(email, { userEmail, allowedDomains }) {
  const address = email.toLowerCase();
  const domain = address.slice(address.lastIndexOf('@') + 1);
  if (address !== userEmail.toLowerCase() && !allowedDomains.includes(domain)) {
    throw new ValidationError([{ field: 'email', code: 'test_recipient_not_allowed' }],
      'Las pruebas solo van a su propio correo o a los dominios internos permitidos');
  }
}

export function assertTestSendsLeft(sentToday, dailyMax) {
  if (sentToday >= dailyMax) throw new ConflictError(`Alcanzó el máximo de ${dailyMax} envíos de prueba por día`);
}

// The subject is plain text (ADR-013): no line breaks or control characters,
// and no "{{" or "}}", which Mandrill's merge language would interpret.
export function cleanSubject(subject) {
  const text = String(subject ?? '').trim();
  if ([...text].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127) || /\{\{|\}\}/.test(text)) {
    throw new ValidationError([{ field: 'subject', code: 'invalid_characters' }]);
  }
  return text;
}
