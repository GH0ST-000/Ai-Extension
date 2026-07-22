# @project-x/eslint-config

Shared ESLint flat configs for Project X.

## Presets

| Export | Use case |
|--------|----------|
| `@project-x/eslint-config/base` | Node/library packages |
| `@project-x/eslint-config/nestjs` | NestJS API |
| `@project-x/eslint-config/nextjs` | Next.js dashboard |
| `@project-x/eslint-config/react` | React libraries / extension |

## Usage

```js
import { nestjsConfig } from '@project-x/eslint-config/nestjs';

export default nestjsConfig;
```
