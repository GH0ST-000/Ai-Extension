import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Allows logout without a valid access token (still clears cookies). */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const ok = await super.canActivate(context);
      return Boolean(ok);
    } catch {
      return true;
    }
  }

  override handleRequest<TUser>(_err: Error | null, user: TUser): TUser | undefined {
    return user ?? undefined;
  }
}
