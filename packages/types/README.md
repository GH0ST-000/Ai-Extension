# @project-x/types

Shared TypeScript types and DTOs used across API, dashboard, and extension.

## Design

- Types only — no runtime code or side effects.
- Keep contracts stable; prefer additive changes.
- Apps import from `@project-x/types`, never from sibling apps.

## Usage

```ts
import type { HealthCheckResponse } from '@project-x/types';
```
