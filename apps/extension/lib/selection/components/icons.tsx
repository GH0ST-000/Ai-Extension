import type { SVGProps } from 'react';

export function SparkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path
        d="M10 2.5l1.2 4.1c.2.7.7 1.3 1.4 1.5L16.5 9l-3.9 1.9c-.7.3-1.2.9-1.4 1.6L10 17.5l-1.2-4.9c-.2-.7-.7-1.3-1.4-1.6L3.5 9l3.9-1.9c.7-.3 1.2-.8 1.4-1.5L10 2.5z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ExplainIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path
        d="M10 17.5a7.5 7.5 0 100-15 7.5 7.5 0 000 15z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M10 9v4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="10" cy="6.75" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function ImproveIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path
        d="M4 14.5l7.2-7.2a1.5 1.5 0 012.1 0L15 6.2a1.5 1.5 0 010 2.1L7.8 15.5H4v-1z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M11 5.5l2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function SummarizeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path d="M4.5 5.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M4.5 10h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M4.5 14.5h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function TranslateIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path
        d="M3.5 5.5h8.5M7.75 5.5S7 10.5 3.5 13"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M9.5 9.5c-1 1.6-2.6 2.9-4.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M11 14.5l1.6-4h.5l1.6 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M11.6 13h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function CodeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path
        d="M7 5.5L3.5 10 7 14.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 5.5L16.5 10 13 14.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PromptIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path
        d="M4.5 5.5h11v7.5H9l-2.5 2v-2h-2v-7.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M7 8.5h6M7 11h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
