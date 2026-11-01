import { ValidationError } from '../../core/errors/errors.js';

// Allowed senders (Parte B): the From must belong to the sending subdomain
// (DKIM-signed by Mandrill) and the Reply-To to a domain with real mailboxes.
// Exact domain match, case-insensitive; an empty list means not configured.

export const domainOf = (email) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

export function assertSenderDomains({ email, replyTo }, { senderDomains, replyToDomains }) {
  if (email !== undefined) {
    if (senderDomains.length === 0) {
      throw new ValidationError([{ field: 'email', code: 'sender_domains_not_configured' }], 'Configure primero los dominios de envío');
    }
    if (!senderDomains.includes(domainOf(email))) throw new ValidationError([{ field: 'email', code: 'domain_not_allowed' }]);
  }
  if (replyTo !== undefined && replyTo !== null) {
    if (!replyToDomains.includes(domainOf(replyTo))) throw new ValidationError([{ field: 'replyTo', code: 'domain_not_allowed' }]);
  }
}
