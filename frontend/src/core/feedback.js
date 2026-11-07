import { describeError } from './errors.js';
import { STAGE_ROUTES, navigate } from './router.js';
import { toast } from '../components/toast.js';
import { askReauth } from '../components/reauth-dialog.js';

// Runs an API action with the central error handling: redirects, the
// reauthentication dialog (then one retry) and messages. Per-field errors
// are passed to `form` when given. Returns the action's result, or
// undefined if it failed.
export async function run(action, { form } = {}) {
  try {
    return await action();
  } catch (error) {
    const outcome = describeError(error);
    if (outcome.kind === 'reauth') {
      if (await askReauth()) return run(action, { form });
      return undefined;
    }
    if (outcome.kind === 'redirect') {
      toast(outcome.message, 'warning');
      navigate(outcome.to);
      return undefined;
    }
    if (outcome.kind === 'step') {
      navigate(STAGE_ROUTES[outcome.stage] ?? '/');
      return undefined;
    }
    if (outcome.kind === 'fields' && form) {
      form.showErrors(outcome.fields, outcome.message);
      return undefined;
    }
    if (outcome.kind === 'fields' && outcome.problems.length > 0) {
      toast(`${outcome.message}: ${outcome.problems.join('; ')}`, 'error');
      return undefined;
    }
    toast(outcome.message, 'error');
    return undefined;
  }
}
