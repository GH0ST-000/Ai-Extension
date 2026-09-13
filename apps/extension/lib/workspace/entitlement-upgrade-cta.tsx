import type { CSSProperties } from 'react';

import { getDashboardBillingUrl } from './dashboard-url';
import {
  entitlementFailureMessage,
  isEntitlementFailureCode,
  type EntitlementFailureCode,
} from './entitlement';

type EntitlementUpgradeCtaProps = {
  code: string | null | undefined;
  message?: string | null;
  /** Compact inline for panels; default fits popup / error strip. */
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
};

function openBilling(): void {
  const url = getDashboardBillingUrl();
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    void chrome.tabs.create({ url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Compact upgrade CTA for FEATURE_NOT_AVAILABLE / USAGE_LIMIT_REACHED.
 * Links to dashboard billing — does not embed Paddle checkout.
 */
export function EntitlementUpgradeCta(props: EntitlementUpgradeCtaProps) {
  if (!isEntitlementFailureCode(props.code)) {
    return null;
  }

  const code = props.code as EntitlementFailureCode;
  const text = entitlementFailureMessage(code, props.message ?? undefined);
  const planHint =
    code === 'USAGE_LIMIT_REACHED'
      ? 'Upgrade for higher limits.'
      : 'Upgrade to unlock this feature.';

  if (props.compact) {
    return (
      <div className={props.className} style={props.style}>
        <p className="text-[11px] leading-4 text-secondary">{text}</p>
        <button
          type="button"
          onClick={openBilling}
          className="mt-1 rounded-md px-0 py-0.5 text-[11px] font-semibold text-accent hover:underline"
        >
          View plans
        </button>
      </div>
    );
  }

  return (
    <div
      className={props.className}
      style={{
        marginTop: 10,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid #e2e8f0',
        background: '#f8fafc',
        ...props.style,
      }}
    >
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.4, color: '#334155' }}>{text}</p>
      <p style={{ margin: '4px 0 0', fontSize: 11, color: '#64748b' }}>{planHint}</p>
      <button
        type="button"
        onClick={openBilling}
        style={{
          marginTop: 8,
          border: 'none',
          borderRadius: 8,
          background: '#0f172a',
          color: '#fff',
          fontSize: 12,
          fontWeight: 600,
          padding: '7px 10px',
          cursor: 'pointer',
        }}
      >
        View plans
      </button>
    </div>
  );
}
