import { ConfigError, loadConfig } from './index.js';

// Loads the configuration at process start. On an invalid configuration it
// prints the problems (never the values) and exits: the process must not run
// with missing or weak settings.
export function loadConfigOrExit(profile) {
  try {
    return loadConfig(process.env, { profile });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
