import { Transform } from 'class-transformer';
import { IsBoolean, type ValidationOptions } from 'class-validator';

/**
 * A request property that must be a real JSON boolean.
 *
 * The global ValidationPipe uses `enableImplicitConversion`, which coerces a `boolean`-typed
 * property with `Boolean(value)`: `"false"`, `"no"`, `"0"` and `1` all become `true` and then pass
 * `@IsBoolean()`. This decorator validates the raw request value instead, so anything other than
 * `true` / `false` is rejected with 400. Combine with `@IsOptional()` for optional flags.
 */
export function StrictBoolean(options?: ValidationOptions): PropertyDecorator {
  const keepRaw = Transform(
    ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key],
  );
  const isBoolean = IsBoolean(options);
  return (target: object, propertyKey: string | symbol) => {
    keepRaw(target, propertyKey);
    isBoolean(target, propertyKey);
  };
}
