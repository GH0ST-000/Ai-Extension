import { Component, type ErrorInfo, type ReactNode } from 'react';

import { reportExtensionError } from '~/lib/observability/report-error';
import { SelectionToolbar } from '~/lib/selection/components/selection-toolbar';
import { SHADOW_HOST_ID } from '~/lib/selection/constants';

import cssText from 'data-text:~/style.css';
import type { PlasmoCSConfig, PlasmoGetShadowHostId } from 'plasmo';

export const config: PlasmoCSConfig = {
  matches: ['<all_urls>'],
  all_frames: false,
  run_at: 'document_idle',
};

export const getShadowHostId: PlasmoGetShadowHostId = () => SHADOW_HOST_ID;

export const getStyle = () => {
  const style = document.createElement('style');
  style.textContent = cssText;
  return style;
};

type BoundaryState = {
  hasError: boolean;
  referenceId: string | null;
};

class ContentScriptErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { hasError: false, referenceId: null };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    const referenceId = `req_${Date.now().toString(16)}`;
    return { hasError: true, referenceId };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    void reportExtensionError({
      component: 'content_script',
      event: 'content_script_init_failed',
      errorCode: error.name || 'RenderError',
      normalizedMessage: 'Content script render failure',
      requestId: this.state.referenceId ?? undefined,
      // Never include page URL / selected text / DOM.
    });
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          style={{
            fontFamily: 'system-ui, sans-serif',
            fontSize: 12,
            padding: 10,
            borderRadius: 10,
            background: '#0f172a',
            color: '#f8fafc',
            maxWidth: 260,
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>Something went wrong</p>
          <p style={{ margin: '6px 0 0', opacity: 0.8 }}>Try again or reload the page.</p>
          {this.state.referenceId ? (
            <p style={{ margin: '8px 0 0', fontFamily: 'ui-monospace, monospace', opacity: 0.7 }}>
              Reference: {this.state.referenceId}
            </p>
          ) : null}
          <button
            type="button"
            style={{
              marginTop: 10,
              border: 0,
              borderRadius: 8,
              padding: '6px 10px',
              background: '#14b8a6',
              color: '#042f2e',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={() => this.setState({ hasError: false, referenceId: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function SelectionToolbarContent() {
  return (
    <ContentScriptErrorBoundary>
      <SelectionToolbar />
    </ContentScriptErrorBoundary>
  );
}
