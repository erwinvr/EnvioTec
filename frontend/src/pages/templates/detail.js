import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { formatDate, t } from '../../core/i18n.js';
import { confirmDialog } from '../../components/confirm-dialog.js';
import { openModal } from '../../components/modal.js';
import { badge, button, pageHeader, section } from '../../components/page.js';
import { toast } from '../../components/toast.js';
import { navigate } from '../../core/router.js';

const POLL_MS = 2000;
const MAX_BYTES = 10 * 1024 * 1024;
const known = (key, fallback) => (t(key) === key ? fallback : t(key));
const statusKind = (status) => ({ ready: 'ok', failed: 'warning' })[status] ?? '';

// The preview is a separate document with its own sandbox CSP (ADR-012),
// loaded in an iframe without allow-scripts or allow-same-origin.
function preview(templateId, version) {
  openModal({
    title: t('templates.previewOf', { version }),
    wide: true,
    content: el('iframe', {
      className: 'preview',
      attrs: { sandbox: '', src: `/api/v1/templates/${templateId}/versions/${version}/preview`, title: t('templates.preview'), referrerpolicy: 'no-referrer' },
    }),
  });
}

export async function render(container, { params }) {
  const result = await run(() => api.get(`/api/v1/templates/${params.id}`));
  if (!result) return;
  const template = result.data;
  const can = (code) => auth.hasPermission(code);
  const reload = () => render(container, { params });

  const fileInput = el('input', { attrs: { type: 'file', accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'aria-label': t('imports.file') } });
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
      reload();
    }
  }

  // While a version is being processed, refresh until it finishes.
  if (template.versions.some((v) => v.status === 'pending')) {
    setTimeout(() => {
      if (window.location.hash === `#/plantillas/${template.id}`) reload();
    }, POLL_MS);
  }

  const rows = template.versions.map((v) => el('tr', {}, [
    el('td', { text: `v${v.version}` }),
    el('td', { text: formatDate(v.createdAt) }),
    el('td', { text: v.originalName }),
    el('td', {}, [badge(t(`templates.status.${v.status}`), statusKind(v.status))]),
    el('td', { text: v.status === 'failed' ? known(`templates.reasons.${v.failureReason}`, v.failureReason) : v.variables.map((name) => `{{${name}}}`).join(', ') || '—' }),
    el('td', {}, [v.status === 'ready' ? button(t('templates.preview'), () => preview(template.id, v.version)) : null]),
  ]));

  replace(container, [
    pageHeader(template.name, [
      can('templates.delete') && !template.isArchived ? button(t('templates.archive'), async () => {
        if (!await confirmDialog({ title: t('templates.archive'), message: t('templates.archiveConfirm') })) return;
        if (await run(() => api.delete(`/api/v1/templates/${template.id}`))) navigate('/plantillas');
      }) : null,
    ]),
    template.description ? el('p', { text: template.description }) : null,
    template.isArchived ? el('p', {}, [badge(t('templates.archived'), 'muted')]) : null,
    can('templates.update') && !template.isArchived ? section(t('templates.upload'), [
      el('p', { className: 'hint', text: t('templates.uploadHelp') }),
      el('div', { className: 'actions' }, [fileInput, button(t('templates.uploadButton'), upload, { kind: 'primary' })]),
    ]) : null,
    section(t('templates.versions'), rows.length === 0 ? el('p', { className: 'empty', text: t('templates.noVersions') }) : el('table', { className: 'table' }, [
      el('thead', {}, [el('tr', {}, [t('templates.version'), t('audit.date'), t('imports.file'), t('users.statusLabel'), t('templates.variables'), ''].map((label) => el('th', { text: label, attrs: { scope: 'col' } })))]),
      el('tbody', {}, rows),
    ])),
  ]);
}
