import { APP_NAME } from '@project-x/shared';

function IndexPopup() {
  return (
    <div
      style={{
        width: 300,
        padding: 16,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        color: '#0f172a',
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: '#64748b',
        }}
      >
        {APP_NAME}
      </p>
      <h1 style={{ margin: '8px 0 6px', fontSize: 18 }}>Selection ready</h1>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45, color: '#475569' }}>
        Highlight text on any page to open the floating Ask AI button and action menu. AI runs later
        — Day 2 only ships the interaction layer.
      </p>
    </div>
  );
}

export default IndexPopup;
