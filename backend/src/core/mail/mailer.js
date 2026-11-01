// System mail (password recovery and, later, account notices) through the
// Mandrill API with the system API key, separate from the campaigns key
// (Parte B). Traffic leaves only through the egress proxy (NODE_USE_ENV_PROXY
// with HTTPS_PROXY, ADR-009). Without a key the mailer is disabled: messages
// are dropped and a warning is logged, never the content.

const SEND_URL = 'https://mandrillapp.com/api/1.0/messages/send';
const TIMEOUT_MS = 10000;

export function createMailer(mailConfig, logger, { fetchImpl = fetch } = {}) {
  if (!mailConfig?.enabled) {
    return {
      enabled: false,
      async send({ tag }) {
        logger.warn({ tag }, 'system mail disabled: MANDRILL_SYSTEM_API_KEY not configured');
      },
    };
  }

  return {
    enabled: true,
    async send({ to, subject, text, tag }) {
      const response = await fetchImpl(SEND_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          key: mailConfig.apiKey,
          message: {
            from_email: mailConfig.from,
            from_name: mailConfig.fromName,
            to: [{ email: to, type: 'to' }],
            subject,
            text,
            tags: [tag],
            track_opens: false,
            track_clicks: false,
            auto_html: false,
          },
        }),
      });
      if (!response.ok) throw new Error(`mandrill responded ${response.status}`);
      const [result] = await response.json();
      if (!['sent', 'queued', 'scheduled'].includes(result?.status)) {
        throw new Error(`mandrill rejected the message: ${result?.status} ${result?.reject_reason ?? ''}`.trim());
      }
    },
  };
}
