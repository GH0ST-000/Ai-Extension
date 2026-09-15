# SSO / SCIM module (stub)

**Status:** Not wired into `AppModule`. No routes are registered.

Enterprise SAML SSO and SCIM provisioning are documented in [docs/security/sso-scim.md](../../../../docs/security/sso-scim.md).

## Planned layout

```
sso/
  saml.strategy.ts      # passport-saml or equivalent — validate assertions only
  saml.controller.ts    # /auth/saml/login, /auth/saml/callback
  scim.controller.ts    # /scim/v2/Users (Bearer SCIM_BEARER_TOKEN)
  sso.module.ts         # imports AuthModule for session issuance
```

## Before enabling

- Full signature validation, audience, and clock skew tests.
- JIT user provisioning aligned with `AuthService.register` workspace bootstrap.
- Rate limits on SAML callback and SCIM mutations.
- Production checks if `SSO_ENABLED=true` requires all SAML env vars set.

Do not import `SsoModule` until the above is implemented and reviewed.
