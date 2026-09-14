import { forwardRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  copyTextToClipboard,
  formatSafeDiagnostics,
  mapToUserFacingError,
} from '@project-x/shared';
import type { AIAction, WorkspaceErrorCode } from '@project-x/types';

import { cn } from '~/lib/utils/cn';
import { getDashboardBaseUrl, getDashboardBillingUrl } from '~/lib/workspace/dashboard-url';
import { EntitlementUpgradeCta } from '~/lib/workspace/entitlement-upgrade-cta';
import { isEntitlementFailureCode } from '~/lib/workspace/entitlement';

import { getActionLabel, USER_FACING_AI_ERROR } from '../constants';
import { BrandMark } from './brand-mark';

type ErrorPanelProps = {
  action: AIAction;
  message?: string;
  code?: WorkspaceErrorCode | string | null;
  requestId?: string | null;
  unauthorized?: boolean;
  onRetry: () => void;
  onBack: () => void;
  onClose: () => void;
};

export const ErrorPanel = forwardRef<HTMLDivElement, ErrorPanelProps>(function ErrorPanel(
  {
    action,
    message = USER_FACING_AI_ERROR,
    code = null,
    requestId = null,
    unauthorized = false,
    onRetry,
    onBack,
    onClose,
  },
  ref,
) {
  const [copied, setCopied] = useState(false);
  const entitlement = isEntitlementFailureCode(code as WorkspaceErrorCode | null);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const mapped = mapToUserFacingError({
    code,
    message,
    referenceId: requestId,
    unauthorized,
    offline,
  });

  async function copyReference() {
    if (!requestId) return;
    const ok = await copyTextToClipboard(requestId);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  async function copyDiagnostics() {
    const text = formatSafeDiagnostics({
      client: 'extension',
      integration: 'generic',
      errorCode: mapped.code,
      requestReference: requestId ?? undefined,
      online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
    });
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  function runPrimary() {
    const kind = mapped.primaryAction?.kind;
    if (kind === 'retry') {
      onRetry();
      return;
    }
    if (kind === 'view_plans') {
      window.open(getDashboardBillingUrl(), '_blank', 'noopener,noreferrer');
      return;
    }
    if (kind === 'reconnect_github' || kind === 'grant_repo_access' || kind === 'open_settings') {
      window.open(`${getDashboardBaseUrl()}/app/settings`, '_blank', 'noopener,noreferrer');
      return;
    }
    if (kind === 'sign_in') {
      window.open(`${getDashboardBaseUrl()}/login`, '_blank', 'noopener,noreferrer');
      return;
    }
    if (kind === 'copy_reference') {
      void copyReference();
      return;
    }
    if (kind === 'refresh') {
      onRetry();
    }
  }

  return (
    <motion.div
      ref={ref}
      role="alert"
      initial={{ opacity: 0, scale: 0.96, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 4 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      className={cn(
        'pointer-events-auto w-[320px] overflow-hidden rounded-panel p-3',
        'px-panel-wash text-primary shadow-menu backdrop-blur-2xl border border-border',
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <BrandMark className="mt-0.5 h-7 w-7 rounded-[9px]" />
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-muted">{getActionLabel(action)}</p>
            {entitlement ? (
              <div className="mt-1">
                <EntitlementUpgradeCta
                  code={code as WorkspaceErrorCode}
                  message={mapped.message}
                  compact
                />
              </div>
            ) : (
              <>
                <p className="mt-0.5 text-[14px] font-semibold leading-5 tracking-[-0.02em] text-primary">
                  {mapped.title}
                </p>
                <p className="mt-1.5 text-[12.5px] leading-5 text-secondary">{mapped.message}</p>
                {requestId ? (
                  <p className="mt-2 font-mono text-[10px] text-muted">Reference: {requestId}</p>
                ) : null}
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-hover hover:text-primary"
        >
          Close
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {entitlement ? null : mapped.primaryAction && mapped.primaryAction.kind !== 'none' ? (
          <button
            type="button"
            onClick={runPrimary}
            className="rounded-full bg-accent px-3 py-1.5 text-[11.5px] font-semibold text-[#042f2e] transition-opacity hover:opacity-90"
          >
            {mapped.primaryAction.label}
          </button>
        ) : null}
        {requestId ? (
          <button
            type="button"
            onClick={() => void copyReference()}
            className="rounded-full px-2.5 py-1.5 text-[11.5px] font-medium text-secondary transition-colors hover:bg-hover hover:text-primary"
          >
            {copied ? 'Copied' : 'Copy reference'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void copyDiagnostics()}
          className="rounded-full px-2.5 py-1.5 text-[11.5px] font-medium text-secondary transition-colors hover:bg-hover hover:text-primary"
        >
          Copy diagnostics
        </button>
        <button
          type="button"
          onClick={onBack}
          className="rounded-full px-2.5 py-1.5 text-[11.5px] font-medium text-secondary transition-colors hover:bg-hover hover:text-primary"
        >
          Back
        </button>
      </div>
    </motion.div>
  );
});

ErrorPanel.displayName = 'ErrorPanel';
