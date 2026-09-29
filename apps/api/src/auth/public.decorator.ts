import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Skip the global JWT guard — route must enforce its own auth (or be intentionally open). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
