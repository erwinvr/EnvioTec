import { createLocalProvider } from '../../core/auth/providers/local.provider.js';
import { createAccountService } from './account.service.js';
import { createAuthRepository } from './auth.repository.js';
import { createCredentialsService } from './credentials.service.js';
import { createLoginService } from './login.service.js';
import { createMfaRepository } from './mfa.repository.js';
import { createMfaService } from './mfa.service.js';
import { createPasswordService } from './password.service.js';
import { createSessionIssuer } from './session-issuer.js';

// Wires the authentication services. `ad` is the AD provider (disabled when
// AD_ENABLED=false), `mailer` the system mailer and `limiter` the Redis rate
// limiter.
export function createAuthServices({ db, config, audit, limiter, ad, mailer, mfaPolicy, logger }) {
  const repository = createAuthRepository();
  const local = createLocalProvider({ argon2: config.argon2 });
  const issuer = createSessionIssuer({ db, config, mfaPolicy });
  const credentials = createCredentialsService({ db, repository, audit, local, ad, lockout: config.lockout });
  const mfa = createMfaService({ db, repository, mfaRepository: createMfaRepository(), audit, limiter, issuer, config });
  const shared = { db, repository, credentials, audit, limiter, local, ad, issuer, config, logger };
  return {
    issuer,
    login: createLoginService(shared),
    mfa,
    password: createPasswordService({ ...shared, mailer }),
    account: createAccountService({ ...shared, mfa }),
  };
}
