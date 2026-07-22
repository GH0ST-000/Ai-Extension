# @project-x/config

Shared environment schemas and configuration helpers.

## Design

- Zod schemas define the contract for each surface (API, dashboard).
- Apps validate env at startup; fail fast on misconfiguration.
- Never commit secrets — use `.env` locally and CI secrets in pipelines.

## Usage

```ts
import { apiEnvSchema, parseEnv } from '@project-x/config';

const env = parseEnv(apiEnvSchema, process.env);
```
