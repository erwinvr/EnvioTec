import { createBatchSender } from './batch-sender.js';
import { createDispatcher } from './dispatcher.js';
import { createReconciler } from './reconciler.js';
import { createSenderContext } from './sender-context.js';
import { createTestSender } from './test-sender.js';

// Campaign sender (ADR-005, ADR-024), run by the worker. Composes one part
// per responsibility, sharing the audit and content helpers:
//   dispatch()        dispatcher.js    start, batch the due recipients, queue, complete
//   sendBatch()       batch-sender.js  one Mandrill call per batch, quota and refunds
//   reconcile()       reconciler.js    batches with an unknown outcome, never resent blindly
//   testSend()        test-sender.js   a single message to the test address
//   rejectTestSend()  test-sender.js   a test send that cannot be delivered

export function createSender({ pool, repository, quotas, mandrill, store, audit, sendQueue, mailer, logger, batchSize }) {
  const shared = createSenderContext({ repository, store, audit });
  return {
    ...createDispatcher({ pool, repository, quotas, sendQueue, batchSize, shared }),
    ...createBatchSender({ pool, repository, quotas, mandrill, mailer, logger, shared }),
    ...createReconciler({ pool, repository, quotas, mandrill, logger, shared }),
    ...createTestSender({ pool, repository, mandrill, shared }),
  };
}
