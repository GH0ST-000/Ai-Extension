import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthRequestUser } from './jwt.strategy';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthRequestUser => {
    const request = context.switchToHttp().getRequest<{ user: AuthRequestUser }>();
    return request.user;
  },
);
