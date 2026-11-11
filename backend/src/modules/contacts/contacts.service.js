import { basename } from 'node:path';
import { actorFrom } from '../../core/audit/audit.service.js';
import { areaScopeFor, findForWrite } from '../../core/authorization/area-scope.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError, NotFoundError, ValidationError } from '../../core/errors/errors.js';
import { cleanValue, LIMITS } from './csv-rows.js';
import { isDateVariable, parseDate } from './dates.js';
import { newVariable } from './variables.service.js';

// Contact lists and contacts (Parte B, ADR-008). Lists belong to an area and
// declare their variables (variables.service.js, ADR-028); contacts are
// unique per list by email. CSV imports live in imports.service.js.

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const toList = (row) => ({
  id: row.id, areaId: row.area_id, areaName: row.area_name, name: row.name, description: row.description,
  attributes: row.attributes, contactCount: row.contact_count,
  // ADR-028: each variable with the label people read.
  variables: row.attributes.map((name) => ({ name, label: row.attribute_labels?.[name] ?? name, type: row.attribute_types?.[name] ?? 'text' })),
});
export const toContact = (row) => ({
  id: row.id, listId: row.list_id, email: row.email, firstName: row.first_name, lastName: row.last_name,
  attributes: row.attributes, anonymized: row.anonymized_at !== null, suppressed: row.suppressed ?? false,
});

// Manual contact: same rules as a CSV row; attributes only those of the
// list; date variables as DD/MM/AAAA or AAAA-MM-DD, stored as AAAA-MM-DD.
export function normalizeContact({ email, firstName, lastName, attributes = {} }, listAttributes, listTypes = {}) {
  const problems = [];
  const contact = {
    email: cleanValue(email).toLowerCase(),
    first_name: cleanValue(firstName) || null,
    last_name: cleanValue(lastName) || null,
    attributes: {},
  };
  if (!EMAIL.test(contact.email) || contact.email.length > 254) problems.push({ field: 'email', code: 'invalid_email' });
  for (const [name, value] of Object.entries(attributes)) {
    if (!listAttributes.includes(name)) problems.push({ field: `attributes.${name}`, code: 'unknown_attribute' });
    else if (cleanValue(value).length > LIMITS.maxValue) problems.push({ field: `attributes.${name}`, code: 'too_long' });
    else if (cleanValue(value) !== '' && isDateVariable(listTypes, name)) {
      const date = parseDate(cleanValue(value));
      if (date) contact.attributes[name] = date;
      else problems.push({ field: `attributes.${name}`, code: 'invalid_date' });
    } else if (cleanValue(value) !== '') contact.attributes[name] = cleanValue(value);
  }
  if (problems.length > 0) throw new ValidationError(problems);
  return contact;
}

export function safeFileName(name) {
  const clean = [...basename(String(name ?? ''))].filter((char) => char.codePointAt(0) >= 32 && char !== '\u007f').join('').trim();
  return (clean || 'archivo').slice(0, 255);
}

export function createContactsService({ db, repository, audit }) {
  const record = (client, auth, context, action, resourceType, id, metadata) => audit.record(client, {
    actor: actorFrom(auth), action, resourceType, resourceId: id, result: 'success', context, metadata,
  });

  async function listInScope(client, auth, id, options) {
    const row = await repository.list(client, areaScopeFor(auth), id, options);
    if (!row) throw new NotFoundError();
    return row;
  }

  // Changes only in the user's own area (ADR-026).
  const listForWrite = (client, auth, id, { forUpdate = false } = {}) => findForWrite(auth, {
    resourceType: 'contact_list', id, find: (scope, { lock = true } = {}) => repository.list(client, scope, id, { forUpdate: forUpdate && lock }),
  });
  const contactForWrite = (client, auth, id) => findForWrite(auth, {
    resourceType: 'contact', id, find: (scope, { lock = true } = {}) => repository.contactInScope(client, scope, id, { forUpdate: lock }),
  });

  return {
    listInScope,

    async lists(auth) {
      return (await repository.lists(db, areaScopeFor(auth))).map(toList);
    },

    // Variables may come with the list (ADR-028): [{ label, name? }], or as
    // plain names (`attributes`, labelled after the name).
    async createList(auth, input, context) {
      const variables = [];
      for (const variable of input.variables ?? (input.attributes ?? []).map((name) => ({ name, label: name }))) {
        variables.push(newVariable(variable, variables.map((v) => v.name)));
      }
      // Always the user's own area: areas.view_all does not allow creating elsewhere (ADR-026).
      const areaId = auth.user.areaId;
      return withTransaction(db, async (client) => {
        const area = areaId ? await repository.findArea(client, areaId) : null;
        if (!area || !area.is_active || (input.areaId !== undefined && input.areaId !== areaId)) {
          throw new ValidationError([{ field: 'areaId', code: 'invalid_area' }]);
        }
        const id = await repository.createList(client, { name: input.name, description: input.description, variables, areaId, actorId: auth.user.id });
        await record(client, auth, context, 'list.create', 'contact_list', id, { name: input.name, variables });
        return toList(await repository.list(client, { all: true }, id));
      });
    },

    // Name and description; variables have their own actions (ADR-028).
    async updateList(auth, id, changes, context) {
      return withTransaction(db, async (client) => {
        const before = await listForWrite(client, auth, id, { forUpdate: true });
        await repository.updateList(client, id, changes, auth.user.id);
        const after = await repository.list(client, { all: true }, id);
        await record(client, auth, context, 'list.update', 'contact_list', id, {
          before: { name: before.name, description: before.description },
          after: { name: after.name, description: after.description },
        });
        return toList(after);
      });
    },

    async contacts(auth, listId, { search, page, pageSize }) {
      await listInScope(db, auth, listId);
      const { rows, total } = await repository.contacts(db, listId, { search, limit: pageSize, offset: (page - 1) * pageSize });
      return { items: rows.map(toContact), total };
    },

    async createContact(auth, listId, input, context) {
      return withTransaction(db, async (client) => {
        const list = await listForWrite(client, auth, listId);
        const contact = normalizeContact(input, list.attributes, list.attribute_types);
        const id = await repository.createContact(client, { areaId: list.area_id, listId, contact, actorId: auth.user.id });
        await record(client, auth, context, 'contact.create', 'contact', id, { listId });
        return toContact(await repository.contactInScope(client, { all: true }, id));
      });
    },

    async updateContact(auth, id, input, context) {
      return withTransaction(db, async (client) => {
        const before = await contactForWrite(client, auth, id);
        if (before.anonymized_at) throw new AppError('El contacto fue anonimizado', { statusCode: 409, code: 'CONFLICT' });
        const contact = normalizeContact({
          email: input.email ?? before.email, firstName: 'firstName' in input ? input.firstName : before.first_name,
          lastName: 'lastName' in input ? input.lastName : before.last_name, attributes: input.attributes ?? before.attributes,
        }, before.list_attributes, before.list_types);
        await repository.updateContact(client, id, contact);
        // Personal data stays out of the audit: only which fields changed.
        await record(client, auth, context, 'contact.update', 'contact', id, { listId: before.list_id, fields: Object.keys(input) });
        return toContact(await repository.contactInScope(client, { all: true }, id));
      });
    },

    async deleteContact(auth, id, context) {
      await withTransaction(db, async (client) => {
        const contact = await contactForWrite(client, auth, id);
        await repository.deleteContact(client, id);
        await record(client, auth, context, 'contact.delete', 'contact', id, { listId: contact.list_id });
      });
    },

    // Rows for the CSV export; the export itself is audited.
    async exportList(auth, listId, context) {
      const list = await listInScope(db, auth, listId);
      await record(db, auth, context, 'contacts.export', 'contact_list', listId, { contacts: list.contact_count });
      return { list, batches: repository.exportRows(db, listId) };
    },
  };
}
