import { ImageResponse } from 'next/og';

import { SITE_NAME, SITE_TAGLINE } from '../lib/site';

export const alt = `${SITE_NAME} — ${SITE_TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 72px',
        background: 'linear-gradient(145deg, #0B1220 0%, #122033 52%, #0F2A2A 100%)',
        color: '#F8FAFC',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 20,
            background: '#0B1220',
            border: '1px solid rgba(20,184,166,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          }}
        >
          <div
            style={{
              width: 34,
              height: 6,
              background: '#14B8A6',
              transform: 'rotate(45deg)',
              position: 'absolute',
              borderRadius: 999,
            }}
          />
          <div
            style={{
              width: 34,
              height: 6,
              background: '#14B8A6',
              transform: 'rotate(-45deg)',
              position: 'absolute',
              borderRadius: 999,
            }}
          />
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 999,
              background: '#F59E0B',
              position: 'absolute',
              top: 14,
              right: 14,
            }}
          />
        </div>
        <div style={{ fontSize: 42, fontWeight: 700, letterSpacing: '-0.04em' }}>{SITE_NAME}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 900 }}>
        <div
          style={{
            fontSize: 64,
            fontWeight: 700,
            letterSpacing: '-0.045em',
            lineHeight: 1.08,
          }}
        >
          {SITE_TAGLINE}
        </div>
        <div style={{ fontSize: 28, color: 'rgba(248,250,252,0.68)', lineHeight: 1.35 }}>
          Chrome selection AI · GitHub · Jira · OpenAPI — confirmed writes only.
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 22,
          color: 'rgba(248,250,252,0.55)',
        }}
      >
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: '#14B8A6',
          }}
        />
        Extension + studio
      </div>
    </div>,
    { ...size },
  );
}
