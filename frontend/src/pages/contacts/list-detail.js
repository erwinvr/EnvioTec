import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { formatDate, t } from '../../core/i18n.js';
import { confirmDialog } from '../../components/confirm-dialog.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { badge, button, pageHeader, section } from '../../components/page.js';
import { toast } from '../../components/toast.js';
import { saveResponse } from '../download.js';
import { openMapping } from './import-mapping.js';
import { variablesSection, variableTag } from './list-variables.js';

const POLL_MS = 2000;
const MAX_BYTES = 10 * 1024 * 1024;
const known = (key, fallback) => (t(key) === key ? fallback : t(key));

export async function render(container, { params }) {
  const result = await run(() => api.get(`/api/v1/lists/${params.id}`));
  if (!result) return;
  const list = result.data;
  const can = (code) => auth.hasPermission(code);
  let pollTimer = null;
  // The import just uploaded: its mapping opens as soon as the preview is ready.
  let awaitingPreview = null;
  const reload = () => render(container, { params });

  const contacts = dataTable({
    load: (query) => api.get(`/api/v1/lists/${list.id}/contacts`, query),
    filters: [{ name: 'search', label: t('common.search') }],
    columns: [
      { key: 'email', label: t('users.email'), render: (c) => el('span', {}, [c.email, c.suppressed ? badge(t('contacts.suppressed'), 'warning') : null]) },
      { key: 'firstName', label: t('contacts.firstName') },
      { key: 'lastName', label: t('contacts.lastName') },
      ...list.variables.map((v) => ({ key: `attr_${v.name}`, label: v.label, render: (c) => c.attributes[v.name] ?? '' })),
      {
        key: 'actions', label: '', render: (c) => (c.anonymized ? badge(t('contacts.anonymized')) : el('span', { className: 'actions' }, [
          can('contacts.update') ? button(t('common.edit'), () => editContact(c)) : null,
          can('contacts.delete') ? button(t('common.delete'), async () => {
            if (!await confirmDialog({ title: t('contacts.delete'), message: t('contacts.deleteConfirm'), danger: true })) return;
            if (await run(() => api.delete(`/api/v1/contacts/${c.id}`))) contacts.refresh();
          }, { kind: 'danger' }) : null,
        ])),
      },
    ],
  });

  const statusKind = (status) => ({ completed: 'ok', failed: 'warning', awaiting_mapping: 'warning' })[status] ?? '';
  function importResult(row) {
    if (row.status === 'failed') return known(`imports.reasons.${row.failureReason}`, row.failureReason);
    if (row.status === 'completed') return t('imports.summary', { inserted: row.inserted, updated: row.updated, rejected: row.rejected });
    if (row.status === 'awaiting_mapping' && row.header) {
      return can('contacts.import') ? button(t('imports.map'), () => openMapping(row, list, afterImportChange), { kind: 'primary' }) : t('imports.awaiting');
    }
    return t('imports.analyzing');
  }
  const inProgress = (row) => row.status === 'pending' || (row.status === 'awaiting_mapping' && !row.header);
  const imports = dataTable({
    load: () => api.get(`/api/v1/lists/${list.id}/imports`),
    columns: [
      { key: 'createdAt', label: t('audit.date'), render: (i) => formatDate(i.createdAt) },
      { key: 'originalName', label: t('imports.file') },
      { key: 'status', label: t('users.statusLabel'), render: (i) => badge(t(`imports.status.${i.status}`), statusKind(i.status)) },
      { key: 'result', label: t('imports.result'), render: importResult },
      {
        key: 'errors', label: '', render: (i) => (i.errors.length > 0 ? button(t('imports.errors'), () => openModal({
          title: t('imports.errors'),
          content: el('ul', {}, i.errors.map((e) => el('li', { text: t('imports.rowError', { row: e.row, field: e.field, code: known(`validation.${e.code}`, e.code) }) }))),
        })) : ''),
      },
    ],
  });

  function editContact(contact) {
    const form = createForm({
      fields: [
        // Each field shows the variable a template uses for it (ADR-028).
        { name: 'email', label: t('contacts.email'), type: 'email', required: true, maxLength: 254, value: contact?.email, hint: variableTag('email') },
        { name: 'firstName', label: t('contacts.firstName'), maxLength: 100, value: contact?.firstName ?? '', hint: variableTag('first_name') },
        { name: 'lastName', label: t('contacts.lastName'), maxLength: 100, value: contact?.lastName ?? '', hint: variableTag('last_name') },
        ...list.variables.map((v) => ({ name: `attr_${v.name}`, label: v.label, maxLength: 500, value: contact?.attributes[v.name] ?? '', hint: variableTag(v.name) })),
      ],
      submitLabel: t('common.save'),
      onSubmit: async (values) => {
        const attributes = Object.fromEntries(list.attributes.map((name) => [name, values[`attr_${name}`]]).filter(([, value]) => value !== ''));
        const body = { email: values.email, firstName: values.firstName || null, lastName: values.lastName || null, attributes };
        const response = await run(() => (contact ? api.patch(`/api/v1/contacts/${contact.id}`, body) : api.post(`/api/v1/lists/${list.id}/contacts`, body)), { form });
        if (response) {
          toast(t('common.saved'), 'success');
          modal.close();
          contacts.refresh();
        }
      },
    });
    const modal = openModal({ title: contact ? t('contacts.edit') : t('contacts.create'), content: form.element });
  }

  function afterImportChange() {
    imports.refresh();
    poll();
  }

  // Refreshes the imports while one is being analyzed or loaded; stops when
  // the page changes. Opens the mapping of the upload when its preview is ready.
  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (!window.location.hash.startsWith(`#/contactos/${list.id}`)) return;
      const latest = await api.get(`/api/v1/lists/${list.id}/imports`).catch(() => null);
      imports.refresh();
      const ready = latest?.data.find((i) => i.id === awaitingPreview && i.status === 'awaiting_mapping' && i.header);
      if (ready) {
        awaitingPreview = null;
        openMapping(ready, list, afterImportChange);
      }
      if (latest?.data.some(inProgress)) poll();
      else contacts.refresh();
    }, POLL_MS);
  }

  const fileInput = el('input', { attrs: { type: 'file', accept: '.csv,text/csv', 'aria-label': t('imports.file') } });
  async function upload() {
    const [file] = fileInput.files;
    if (!file) {
      toast(t('imports.chooseFile'), 'warning');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast(t('imports.tooLarge'), 'error');
      return;
    }
    const response = await run(() => api.upload(`/api/v1/lists/${list.id}/imports`, file));
    if (response) {
      toast(t('imports.queued'), 'success');
      fileInput.value = '';
      awaitingPreview = response.data.id;
      imports.refresh();
      poll();
    }
  }

  replace(container, [
    pageHeader(list.name, [
      can('contacts.create') ? button(t('contacts.create'), () => editContact(null), { kind: 'primary' }) : null,
      can('contacts.export') ? button(t('contacts.export'), async () => {
        const response = await run(() => api.download(`/api/v1/lists/${list.id}/export`));
        if (response) await saveResponse(response, `contactos-${list.name}.csv`);
      }) : null,
    ]),
    list.description ? el('p', { text: list.description }) : null,
    section(t('variables.title'), variablesSection(list, { canEdit: can('contacts.update'), onChange: reload })),
    section(t('nav.contacts'), contacts.element),
    can('contacts.import') ? section(t('imports.title'), [
      el('p', { className: 'hint', text: t('imports.help') }),
      el('div', { className: 'actions' }, [fileInput, button(t('imports.upload'), upload, { kind: 'primary' })]),
      imports.element,
    ]) : null,
  ]);
  // An import may already be in progress when the page opens.
  poll();
}
