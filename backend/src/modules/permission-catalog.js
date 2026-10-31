// Complete permission catalog: the union of every module's *.permissions.js.
// A new module adds its import here; database/seeds/system syncs the result
// with the permissions table.
import { permissions as administration } from './administration/administration.permissions.js';
import { permissions as auditLogs } from './audit-logs/audit-logs.permissions.js';
import { permissions as campaigns } from './campaigns/campaigns.permissions.js';
import { permissions as contacts } from './contacts/contacts.permissions.js';
import { permissions as permissionsModule } from './permissions/permissions.permissions.js';
import { permissions as quotas } from './quotas/quotas.permissions.js';
import { permissions as reports } from './reports/reports.permissions.js';
import { permissions as roles } from './roles/roles.permissions.js';
import { permissions as senders } from './senders/senders.permissions.js';
import { permissions as sessions } from './sessions/sessions.permissions.js';
import { permissions as templates } from './templates/templates.permissions.js';
import { permissions as users } from './users/users.permissions.js';

export const PERMISSION_CATALOG = Object.freeze([
  ...users, ...roles, ...permissionsModule, ...sessions, ...auditLogs, ...administration,
  ...senders, ...templates, ...contacts, ...campaigns, ...quotas, ...reports,
].map((permission) => Object.freeze({ ...permission })));

export const PERMISSION_CODES = new Set(PERMISSION_CATALOG.map((permission) => permission.code));
