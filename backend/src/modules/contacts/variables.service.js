import { actorFrom } from '../../core/audit/audit.service.js';
import { findForWrite } from '../../core/authorization/area-scope.js';
import { withTransaction } from '../../core/db/transaction.js';
import { ConflictError, ValidationError } from '../../core/errors/errors.js';
import { ATTRIBUTE_PATTERN, cleanValue, RESERVED_VARIABLES, variableNameFrom } from './csv-rows.js';

// Variables of a contact list (ADR-028): a technical name used in templates
// ({{numero_poliza}}) and a label people read ("Número de póliza"), of type
// text or date (ADR-030). Name and type never change once created, because
// templates and data depend on them; the label can. A variable that holds
// data in any contact cannot be removed.

const MAX_VARIABLES = 30;
const MAX_LABEL = 60;
export const VARIABLE_TYPES = Object.freeze(['text', 'date']);

export function cleanLabel(label) {
  const text = cleanValue(label);
  if (text.length < 1 || text.length > MAX_LABEL) throw new ValidationError([{ field: 'label', code: 'invalid_label' }]);
  return text;
}

// Name and label of a new variable, checked against the list's variables.
export function newVariable({ label, name, type = 'text' }, existing) {
  const cleanedLabel = cleanLabel(label);
  if (!VARIABLE_TYPES.includes(type)) throw new ValidationError([{ field: 'type', code: 'invalid_variable_type' }]);
  const variableName = name ?? variableNameFrom(cleanedLabel);
  if (!ATTRIBUTE_PATTERN.test(variableName)) throw new ValidationError([{ field: 'name', code: 'invalid_variable_name' }]);
  if (RESERVED_VARIABLES.includes(variableName)) throw new ValidationError([{ field: 'name', code: 'reserved_variable' }]);
  if (existing.includes(variableName)) throw new ConflictError('La variable ya existe en la lista', { details: [{ field: 'name', code: 'variable_exists' }] });
  if (existing.length >= MAX_VARIABLES) throw new ValidationError([{ field: 'name', code: 'too_many_variables' }]);
  return { name: variableName, label: cleanedLabel, type };
}

export function createVariablesService({ db, repository, audit }) {
  const record = (client, auth, context, action, listId, metadata) => audit.record(client, {
    actor: actorFrom(auth), action, resourceType: 'contact_list', resourceId: listId, result: 'success', context, metadata,
  });
  const listForWrite = (client, auth, id) => findForWrite(auth, {
    resourceType: 'contact_list', id, find: (scope, { lock = true } = {}) => repository.list(client, scope, id, { forUpdate: lock }),
  });
  const known = (list, name) => {
    if (!list.attributes.includes(name)) throw new ValidationError([{ field: 'name', code: 'unknown_variable' }]);
  };

  return {
    async add(auth, listId, input, context) {
      return withTransaction(db, async (client) => {
        const list = await listForWrite(client, auth, listId);
        const variable = newVariable(input, list.attributes);
        await repository.addVariable(client, listId, variable, auth.user.id);
        await record(client, auth, context, 'list.variable_add', listId, variable);
        return repository.list(client, { all: true }, listId);
      });
    },

    async relabel(auth, listId, name, { label }, context) {
      return withTransaction(db, async (client) => {
        const list = await listForWrite(client, auth, listId);
        known(list, name);
        const cleaned = cleanLabel(label);
        await repository.setVariableLabel(client, listId, name, cleaned, auth.user.id);
        await record(client, auth, context, 'list.variable_update', listId, { name, before: list.attribute_labels[name] ?? null, after: cleaned });
        return repository.list(client, { all: true }, listId);
      });
    },

    async remove(auth, listId, name, context) {
      return withTransaction(db, async (client) => {
        const list = await listForWrite(client, auth, listId);
        known(list, name);
        if (await repository.variableInUse(client, listId, name)) {
          throw new ConflictError('La variable tiene datos en algún contacto y no se puede borrar', { details: [{ field: 'name', code: 'variable_in_use' }] });
        }
        await repository.removeVariable(client, listId, name, auth.user.id);
        await record(client, auth, context, 'list.variable_remove', listId, { name });
        return repository.list(client, { all: true }, listId);
      });
    },
  };
}
