import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { formatDate, t } from '../../core/i18n.js';
import { navigate } from '../../core/router.js';
import { confirmDialog } from '../../components/confirm-dialog.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { badge, button, pageHeader, section } from '../../components/page.js';
import { toast } from '../../components/toast.js';

const POLL_MS = 2000;
const MAX_BYTES = 10 * 1024 * 1024;
const known = (key, fallback) => (t(key) === key ? fallback : t(key));
const statusKind = (status) => ({ ready: 'ok', failed: 'warning' })[status] ?? '';

// Isolated preview (ADR-012): an iframe with an empty sandbox (no scripts, no
// same origin) loading the backend route that sends its own CSP.
function preview(template, version) {
  openModal({
    title: t('templates.previewOf', { name: template.name, version: version.version }),
    wide: true,
    content: el('iframe', {
      className: 'preview',
      attrs: { sandbox: '', src: `/api/v1/templates/${template.id}/versions/${version.version}/preview`, title: t('templates.preview'), referrerpolicy: 'no-referrer' },
    }),
  });
}

async function showText(template, version) {
  const result = await run(() => api.get(`/api/v1/templates/${template.id}/versions/${version.version}`));
  if (result) openModal({ title: t('templates.textVersion'), wide: true, content: el('pre', { className: 'text-body', text: result.data.text ?? '' }) });
}

export async function render(container, { params }) {
  const result = await run(() => api.get(`/api/v1/templates/${params.id}`));
  if (!result) return;
  const template = result.data;
  const canUpdate = auth.hasPermission('templates.update') && !template.isArchived;
  let pollTimer = null;

  const versions = dataTable({
    load: async () => ({ data: (await api.get(`/api/v1/templates/${template.id}`)).data.versions }),
    columns: [
      { key: 'version', label: t('templates.version'), render: (v) => `v${v.version}` },
      { key: 'status', label: t('users.statusLabel'), render: (v) => badge(t(`templates.status.${v.status}`), statusKind(v.status)) },
      { key: 'originalName', label: t('imports.file') },
      { key: 'variables', label: t('templates.variables'), render: (v) => (v.variables.length ? v.variables.map((name) => `{{${name}}}`).join(' ') : '—') },
      { key: 'failureReason', label: t('imports.result'), render: (v) => (v.failureReason ? known(`templates.reasons.${v.failureReason}`, v.failureReason) : '') },
      { key: 'createdAt', label: t('audit.date'), render: (v) => formatDate(v.createdAt) },
      {
        key: 'actions', label: '', render: (v) => (v.status === 'ready' ? el('span', { className: 'actions' }, [
          button(t('templates.preview'), () => preview(template, v)),
          button(t('templates.textVersion'), () => showText(template, v)),
        ]) : ''),
      },
    ],
  });

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (!window.location.hash.startsWith(`#/plantillas/${template.id}`)) return;
      const latest = await api.get(`/api/v1/templates/${template.id}`).catch(() => null);
      versions.refresh();
      if (latest?.data.versions.some((v) => v.status === 'pending')) poll();
    }, POLL_MS);
  }

  const fileInput = el('input', {
    attrs: { type: 'file', accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'aria-label': t('imports.file') },
  });
  async function upload() {
    const [file] = fileInput.files;
    if (!file) {
      toast(t('templates.chooseFile'), 'warning');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast(t('imports.tooLarge'), 'error');
      return;
    }
    if (await run(() => api.upload(`/api/v1/templates/${template.id}/versions`, file))) {
      toast(t('templates.queued'), 'success');
      fileInput.value = '';
      versions.refresh();
      poll();
    }
  }

  replace(container, [
    pageHeader(template.name, [
      template.isArchived ? badge(t('templates.archived')) : null,
      auth.hasPermission('templates.delete') && !template.isArchived ? button(t('templates.archive'), async () => {
        if (!await confirmDialog({ title: t('templates.archive'), message: t('templates.archiveConfirm'), danger: true })) return;
        if (await run(() => api.delete(`/api/v1/templates/${template.id}`))) navigate('/plantillas');
      }, { kind: 'danger' }) : null,
    ]),
    template.description ? el('p', { text: template.description }) : null,
    canUpdate ? section(t('templates.upload'), [
      el('p', { className: 'hint', text: t('templates.uploadHelp') }),
      el('div', { className: 'actions' }, [fileInput, button(t('templates.uploadButton'), upload, { kind: 'primary' })]),
    ]) : null,
    section(t('templates.versions'), versions.element),
  ]);
}
