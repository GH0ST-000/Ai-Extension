'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  fallbackTitle?: string;
};

type State = {
  hasError: boolean;
  referenceId: string | null;
};

function createReferenceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  }
  return `req_${Date.now().toString(16)}`;
}

/**
 * Top-level dashboard error boundary — never shows stack traces.
 * Reports via allowlisted backend telemetry when authenticated.
 */
export class DashboardErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, referenceId: null };

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true, referenceId: createReferenceId() };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    const referenceId = this.state.referenceId ?? createReferenceId();
    if (!this.state.referenceId) {
      this.setState({ referenceId });
    }

    void reportDashboardError({
      referenceId,
      errorCode: error.name || 'RenderError',
      normalizedMessage: 'Dashboard render failure',
    });
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, referenceId: null });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
            {this.props.fallbackTitle ?? 'Something went wrong'}
          </h1>
          <p className="max-w-md text-sm text-muted-foreground">
            Try again. If the problem continues, share the reference with support.
          </p>
          {this.state.referenceId ? (
            <p className="rounded-lg border border-line bg-panel/80 px-3 py-2 font-mono text-xs text-muted-foreground">
              Reference: {this.state.referenceId}
            </p>
          ) : null}
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-inverse transition hover:opacity-90"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

async function reportDashboardError(input: {
  referenceId: string;
  errorCode: string;
  normalizedMessage: string;
}): Promise<void> {
  try {
    const apiBase = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') || 'http://localhost:3001';

    await fetch(`${apiBase}/api/telemetry/client-errors`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': input.referenceId,
      },
      body: JSON.stringify({
        client: 'dashboard',
        component: 'error_boundary',
        event: 'page_crash',
        errorCode: input.errorCode.slice(0, 64),
        normalizedMessage: input.normalizedMessage.slice(0, 240),
        requestId: input.referenceId,
        release: process.env.NEXT_PUBLIC_APP_RELEASE || undefined,
      }),
    });
  } catch {
    // telemetry must never break UI
  }
}
