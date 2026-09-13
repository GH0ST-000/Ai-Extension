import { forwardRef } from 'react';
import { motion } from 'framer-motion';
import type { AIAction, WorkspaceErrorCode } from '@project-x/types';

import { cn } from '~/lib/utils/cn';
import { EntitlementUpgradeCta } from '~/lib/workspace/entitlement-upgrade-cta';
import { isEntitlementFailureCode } from '~/lib/workspace/entitlement';

import { getActionLabel, USER_FACING_AI_ERROR } from '../constants';

type ErrorPanelProps = {
  action: AIAction;
  message?: string;
  code?: WorkspaceErrorCode | null;
  requestId?: string | null;
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
    onRetry,
    onBack,
    onClose,
  },
  ref,
) {
  const entitlement = isEntitlementFailureCode(code);

  return (
    <motion.div
      ref={ref}
      role="alert"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.16 }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      className={cn(
        'pointer-events-auto w-[280px] overflow-hidden rounded-[12px] p-2',
        'bg-elevated text-primary shadow-menu backdrop-blur-2xl border border-border',
      )}
    >
      <div className="mb-2 flex items-start justify-between px-1">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            {getActionLabel(action)}
          </p>
          {entitlement ? (
            <div className="mt-1">
              <EntitlementUpgradeCta code={code} message={message} compact />
            </div>
          ) : (
            <>
              <p className="mt-1 text-[12.5px] leading-5 text-primary">{message}</p>
              {requestId ? (
                <p className="mt-1 font-mono text-[10px] text-muted">Reference: {requestId}</p>
              ) : null}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-primary"
        >
          Close
        </button>
      </div>
      <div className="flex items-center gap-1 px-1 pb-1">
        {entitlement ? null : (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
          >
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={onBack}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
        >
          Back
        </button>
      </div>
    </motion.div>
  );
});

ErrorPanel.displayName = 'ErrorPanel';
