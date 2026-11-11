import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { formatDate, t } from '../../core/i18n.js';
import { confirmDialog } from '../../components/confirm-dialog.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { badge, button, definitionList, pageHeader, section } from '../../components/page.js';
import { toast } from '../../components/toast.js';
import { campaignForm, statusBadge } from './list.js';

const POLL_MS = 2000;
const MAX_BYTES = 5 * 1024 * 1024;
const known = (key, fallback) => (t(key) === key ? fallback : t(key));

export async function render(container, { params }) {
  const result = await run(() => api.get(`/api/v1/campaigns/${params.id}`));
  if (!result) return;
  const c = result.data;
  const can = (code) => auth.hasPermission(code);
  const reload = () => render(container, { params });
  const draft = c.status === 'draft';

  async function act(path, { confirm, body, success, method = 'post' }) {
    if (confirm && !await confirmDialog({ title: confirm.title, message: confirm.message, danger: confirm.danger })) return;
    const call = method === 'delete' ? () => api.delete(`/api/v1/campaigns/${c.id}/${path}`) : () => api.post(`/api/v1/campaigns/${c.id}/${path}`, body);
    if (await run(call)) {
      toast(success, 'success');
      reload();
    }
  }

  function withReason(path, title, success) {
    const form = createForm({
      fields: [{ name: 'reason', label: t('campaigns.reason'), type: 'textarea', required: true, minLength: 5, maxLength: 500 }],
      submitLabel: title,
      onSubmit: async (values) => {
        if (await run(() => api.post(`/api/v1/campaigns/${c.id}/${path}`, values), { form })) {
          modal.close();
          toast(success, 'success');
          reload();
        }
      },
    });
    const modal = openModal({ title, content: form.element });
  }

  function testSend() {
    const form = createForm({
      fields: [{ name: 'email', label: t('users.email'), type: 'email', required: true, value: auth.currentUser().email, hint: t('campaigns.testHint') }],
      submitLabel: t('campaigns.testSend'),
      onSubmit: async (values) => {
        if (await run(() => api.post(`/api/v1/campaigns/${c.id}/test-send`, values), { form })) {
          modal.close();
          toast(t('campaigns.testQueued'), 'success');
        }
      },
    });
    const modal = openModal({ title: t('campaigns.testSend'), content: form.element });
  }

  async function edit() {
    if (!draft && !await confirmDialog({ title: t('common.edit'), message: t('campaigns.editBackToDraft') })) return;
    const form = await campaignForm({
      campaign: c,
      onSaved: () => {
        modal.close();
        reload();
      },
    });
    const modal = openModal({ title: t('common.edit'), content: form.element, wide: true });
  }

  const fileInput = el('input', { attrs: { type: 'file', accept: '.pdf,application/pdf', 'aria-label': t('campaigns.attachment') } });
  async function upload() {
    const [file] = fileInput.files;
    if (!file) return toast(t('campaigns.choosePdf'), 'warning');
    if (file.size > MAX_BYTES) return toast(t('campaigns.pdfTooLarge'), 'error');
    if (await run(() => api.upload(`/api/v1/campaigns/${c.id}/attachment`, file))) {
      toast(t('templates.queued'), 'success');
      reload();
    }
    return undefined;
  }
  if (c.attachment?.status === 'pending') {
    setTimeout(() => { if (window.location.hash === `#/campanias/${c.id}`) reload(); }, POLL_MS);
  }

  const mine = c.submittedBy === auth.currentUser().username;
  const actions = [
    can('campaigns.update') && ['draft', 'submitted', 'approved', 'scheduled'].includes(c.status) ? button(t('common.edit'), edit) : null,
    can('campaigns.send_test') && ['draft', 'submitted', 'approved', 'scheduled', 'paused'].includes(c.status) ? button(t('campaigns.testSend'), testSend) : null,
    can('campaigns.submit') && draft ? button(t('campaigns.submit'), () => act('submit', { success: t('campaigns.submitted') }), { kind: 'primary' }) : null,
    can('campaigns.approve') && c.status === 'submitted' && !mine ? button(t('campaigns.approve'), () => act('approve', {
      confirm: { title: t('campaigns.approve'), message: t('campaigns.approveConfirm') }, success: t('campaigns.approved'),
    }), { kind: 'primary' }) : null,
    can('campaigns.approve') && c.status === 'submitted' && !mine ? button(t('campaigns.reject'), () => withReason('reject', t('campaigns.reject'), t('campaigns.rejected'))) : null,
    can('campaigns.pause') && ['approved', 'scheduled', 'sending'].includes(c.status) ? button(t('campaigns.pause'), () => act('pause', { success: t('campaigns.paused') })) : null,
    can('campaigns.pause') && c.status === 'paused' ? button(t('campaigns.resume'), () => act('resume', { success: t('campaigns.resumed') })) : null,
    can('campaigns.cancel') && ['submitted', 'approved', 'scheduled', 'sending', 'paused'].includes(c.status)
      ? button(t('campaigns.cancel'), () => withReason('cancel', t('campaigns.cancel'), t('campaigns.cancelled')), { kind: 'danger' }) : null,
  ];

  const recipients = c.recipientCount !== null ? dataTable({
    load: (query) => api.get(`/api/v1/campaigns/${c.id}/recipients`, query),
    columns: [
      { key: 'email', label: t('users.email') },
      { key: 'status', label: t('users.statusLabel'), render: (r) => t(`campaigns.recipientStatus.${r.status}`) },
      { key: 'sentAt', label: t('campaigns.sentAt'), render: (r) => formatDate(r.sentAt) },
      ...(c.scheduleByDate ? [{ key: 'sendAt', label: t('campaigns.sendAt'), render: (r) => formatDate(r.sendAt) }] : []),
    ],
  }) : null;

  replace(container, [
    pageHeader(c.name, actions),
    mine && c.status === 'submitted' ? el('p', { className: 'hint', text: t('campaigns.waitingApprover') }) : null,
    section(t('campaigns.detail'), definitionList([
      [t('users.statusLabel'), statusBadge(c.status)],
      [t('campaigns.subject'), c.subject],
      [t('nav.templates'), `${c.template.name} (v${c.template.version})`],
      [t('lists.name'), c.list.name],
      [t('campaigns.sender'), `${c.sender.name} <${c.sender.email}>`],
      // Sending by each contact's date (ADR-030), or a fixed moment.
      c.scheduleByDate
        ? [t('campaigns.scheduleMode'), t('campaigns.byDateSummary', {
          variable: `{{${c.scheduleByDate.variable}}}`, offset: c.scheduleByDate.offsetDays, time: c.scheduleByDate.time,
        })]
        : [t('campaigns.scheduledAt'), c.scheduledAt ? formatDate(c.scheduledAt) : t('campaigns.asSoonAsApproved')],
      ...(c.scheduleByDate && c.scheduledAt ? [[t('campaigns.firstSend'), formatDate(c.scheduledAt)]] : []),
      ...(c.excluded ? [[t('campaigns.excluded'), t('campaigns.excludedSummary', c.excluded)]] : []),
      [t('campaigns.attachment'), c.attachment ? el('span', {}, [c.attachment.name, badge(t(`templates.status.${c.attachment.status}`), c.attachment.status === 'ready' ? 'ok' : 'warning'),
        c.attachment.failureReason ? ` ${known(`campaigns.pdfReasons.${c.attachment.failureReason}`, c.attachment.failureReason)}` : null]) : '—'],
      [t('campaigns.createdBy'), c.createdBy],
      [t('campaigns.submittedBy'), c.submittedBy ? `${c.submittedBy} · ${formatDate(c.submittedAt)}` : '—'],
      [t('campaigns.approvedBy'), c.approvedBy ? `${c.approvedBy} · ${formatDate(c.approvedAt)}` : '—'],
      [t('campaigns.recipients'), c.recipientCount ?? '—'],
      ...(c.rejectionReason ? [[t('campaigns.rejectionReason'), c.rejectionReason]] : []),
      ...(c.cancelReason ? [[t('campaigns.cancelReason'), c.cancelReason]] : []),
    ])),
    can('campaigns.update') && draft ? section(t('campaigns.attachment'), [
      el('p', { className: 'hint', text: t('campaigns.attachmentHelp') }),
      el('div', { className: 'actions' }, [
        fileInput, button(t('campaigns.uploadPdf'), upload, { kind: 'primary' }),
        c.attachment ? button(t('campaigns.removePdf'), () => act('attachment', {
          method: 'delete', confirm: { title: t('campaigns.removePdf'), message: t('campaigns.removePdfConfirm') }, success: t('campaigns.pdfRemoved'),
        })) : null,
      ]),
    ]) : null,
    recipients ? section(t('campaigns.recipients'), recipients.element) : null,
  ]);
}
