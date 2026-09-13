import type {
  ClientErrorTelemetryInput,
  ClientTelemetryEvent,
  ClientTelemetryIntegration,
} from '@project-x/types';

import { getAccessToken } from '../services/auth-storage';

function getApiBaseUrl(): string {
  const configured = process.env.PLASMO_PUBLIC_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3001').replace(
    /\/$/,
    '',
  );
}

/**
 * Privacy-safe extension telemetry.
 * Never send page URL, title, selected text, or DOM content.
 */
export async function reportExtensionError(input: {
  component: string;
  event: ClientTelemetryEvent;
  integration?: ClientTelemetryIntegration;
  errorCode?: string;
  normalizedMessage?: string;
  requestId?: string;
  executionId?: string;
  stack?: string;
}): Promise<string | undefined> {
  try {
    const token = await getAccessToken();
    if (!token) return undefined;

    const payload: ClientErrorTelemetryInput = {
      client: 'extension',
      component: input.component.slice(0, 64),
      event: input.event,
      ...(input.integration ? { integration: input.integration } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode.slice(0, 64) } : {}),
      ...(input.normalizedMessage
        ? { normalizedMessage: input.normalizedMessage.slice(0, 240) }
        : {}),
      ...(input.requestId ? { requestId: input.requestId.slice(0, 80) } : {}),
      ...(input.executionId ? { executionId: input.executionId.slice(0, 80) } : {}),
      ...(input.stack ? { stack: input.stack.slice(0, 2000) } : {}),
      release: process.env.PLASMO_PUBLIC_APP_RELEASE?.slice(0, 128),
    };

    const response = await fetch(`${getApiBaseUrl()}/api/telemetry/client-errors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(payload.requestId ? { 'X-Request-Id': payload.requestId } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) return undefined;
    const body = (await response.json()) as { referenceId?: string };
    return body.referenceId;
  } catch {
    return undefined;
  }
}
