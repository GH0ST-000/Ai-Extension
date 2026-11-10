import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { RateLimit, RateLimitGuard } from '../common/security/rate-limit.guard';
import { AiService } from './ai.service';
import { ExecuteAiActionDto } from './dto/execute-ai-action.dto';

@Controller('ai')
@UseGuards(JwtAuthGuard, RateLimitGuard)
@RateLimit({ bucket: 'ai', limit: 60, windowSeconds: 60 })
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('actions/stream')
  @HttpCode(200)
  async streamAction(
    @CurrentUser() user: AuthRequestUser,
    @Body() body: ExecuteAiActionDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const abortController = new AbortController();

    const onClientClose = () => {
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    };

    req.on('close', onClientClose);
    res.on('close', onClientClose);

    try {
      await this.aiService.pipeActionStream(user.id, body, res, abortController.signal);
    } catch (error) {
      if (res.headersSent || res.writableEnded) {
        return;
      }

      if (error instanceof BadRequestException) {
        const status = error.getStatus();
        res.status(status).json({
          statusCode: status,
          message: error.message,
          error: 'Bad Request',
        });
        return;
      }

      // Coded, user-actionable failures (e.g. PR_DIFF_UNAVAILABLE) keep their code and message.
      if (error instanceof HttpException) {
        const body = error.getResponse();
        if (
          typeof body === 'object' &&
          body !== null &&
          typeof (body as { code?: unknown }).code === 'string' &&
          typeof (body as { message?: unknown }).message === 'string'
        ) {
          const { code, message } = body as { code: string; message: string };
          res.status(error.getStatus()).json({ statusCode: error.getStatus(), code, message });
          return;
        }
      }

      const status =
        typeof error === 'object' &&
        error !== null &&
        'getStatus' in error &&
        typeof (error as { getStatus: () => number }).getStatus === 'function'
          ? (error as { getStatus: () => number }).getStatus()
          : 503;

      res.status(Number.isFinite(status) ? status : 503).json({
        statusCode: Number.isFinite(status) ? status : 503,
        message: 'Unable to generate a response.',
        error: error instanceof ServiceUnavailableException ? 'Service Unavailable' : 'Error',
      });
    } finally {
      req.off('close', onClientClose);
      res.off('close', onClientClose);
    }
  }

  @Post('actions')
  @HttpCode(200)
  async generateAction(@CurrentUser() user: AuthRequestUser, @Body() body: ExecuteAiActionDto) {
    const { text, reviewScope, projectMemory } = await this.aiService.generateActionWithMetadata(
      user.id,
      body,
    );
    return {
      success: true as const,
      data: {
        action: body.action,
        result: text,
        ...(reviewScope ? { reviewScope } : {}),
        ...(projectMemory ? { projectMemory } : {}),
      },
    };
  }
}
