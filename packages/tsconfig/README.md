# @project-x/tsconfig

Shared TypeScript base configurations used across apps and packages.

## Presets

| File | Use case |
|------|----------|
| `base.json` | Strict defaults for Node/library packages |
| `nestjs.json` | NestJS apps (decorators, CommonJS) |
| `nextjs.json` | Next.js apps |
| `react-library.json` | React component libraries |

## Usage

```json
{
  "extends": "@project-x/tsconfig/base.json"
}
```
