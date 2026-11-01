// Untrusted file inspection (ADR-004). Runs in its own container on the
// isolated "files" network: no database, no database credentials, no
// internet. Takes jobs from the "files" queue and reports each outcome to
// "files-results", where the worker (which has the database) applies it.
import { loadConfigOrExit } from './core/config/load-or-exit.js';
import { createClamav } from './core/files/clamav.js';
import { createFileStore } from './core/files/storage.js';
import { onShutdownSignal } from './core/lifecycle/shutdown.js';
import { createLogger } from './core/logging/logger.js';
import { createQueue, createWorker, QUEUES } from './core/queue/queues.js';
import { processCampaignPdf } from './modules/campaigns/files/campaign-pdf.processor.js';
import { processContactsCsv } from './modules/contacts/files/contacts-csv.processor.js';
import { processTemplateDocx } from './modules/templates/files/template-docx.processor.js';

const config = loadConfigOrExit('file-processor');
const logger = createLogger(config, { service: 'file-processor' });
const deps = { store: createFileStore(config.files.dir), clamav: createClamav(config.clamav) };

// kind -> inspector. New file types (templates, PDF) register here.
export const PROCESSORS = { contacts_csv: processContactsCsv, template_docx: processTemplateDocx, campaign_pdf: processCampaignPdf };

const results = createQueue(QUEUES.fileResults, config.redis);
const worker = createWorker(QUEUES.files, async (job) => {
  const processor = PROCESSORS[job.data.kind];
  if (!processor) throw new Error(`unknown file kind: ${job.data.kind}`);
  const outcome = await processor(job.data, deps);
  logger.info({ kind: job.data.kind, fileId: job.data.fileId, status: outcome.status, reason: outcome.reason }, 'file inspected');
  await results.add(job.data.kind, { ...job.data, outcome }, { jobId: job.data.fileId });
  return outcome.status;
}, config.redis, { concurrency: 2 });

// After the last attempt the upload is discarded and reported as failed, so
// the import does not stay pending forever.
worker.on('failed', async (job, error) => {
  logger.error({ kind: job?.data.kind, fileId: job?.data.fileId, errorMessage: error.message }, 'file inspection failed');
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  await deps.store.remove('incoming', job.data.fileId).catch(() => {});
  await results.add(job.data.kind, { ...job.data, outcome: { status: 'failed', reason: 'processing_error' } }, { jobId: job.data.fileId })
    .catch((addError) => logger.error({ errorMessage: addError.message }, 'could not report the failure'));
});

onShutdownSignal(logger, async () => {
  await worker.close();
  await results.close();
});

logger.info('file-processor ready');
