import type { Metadata } from 'next';
import Link from 'next/link';

import { APP_NAME } from '@project-x/shared';

import { LandingHeader } from '../../components/landing-header';
import { SITE_NAME, absoluteUrl, buildSocialMetadata } from '../../lib/site';

const TITLE = 'Terms and Conditions';
const DESCRIPTION = `Terms governing use of ${SITE_NAME} — the Chrome extension, Studio, and related private-beta services.`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  ...buildSocialMetadata({
    title: `${TITLE} · ${SITE_NAME}`,
    description: DESCRIPTION,
    path: '/terms',
  }),
};

const EFFECTIVE_DATE = 'September 29, 2026';

const SECTIONS = [
  {
    id: 'agreement',
    title: '1. Agreement',
    body: [
      `These Terms and Conditions (“Terms”) govern access to and use of ${APP_NAME}, including the website, Studio dashboard, Chrome extension, APIs, and related services (together, the “Service”).`,
      'By creating an account, installing the extension, or otherwise using the Service, you agree to these Terms. If you use the Service on behalf of an organization, you represent that you have authority to bind that organization, and “you” includes that organization.',
      'If you do not agree, do not use the Service.',
    ],
  },
  {
    id: 'service',
    title: '2. The Service',
    body: [
      `${APP_NAME} is a contextual AI assistant for software development workflows. It can help you understand page content, review pull requests, align requirements, analyze API contracts, and prepare actions — including proposed GitHub writes that require your explicit confirmation.`,
      'Features, limits, and availability may change as we iterate. We may add, modify, or remove functionality without prior notice.',
    ],
  },
  {
    id: 'beta',
    title: '3. Private Beta',
    body: [
      'The Service is offered as a private beta. Beta software may be incomplete, unstable, or change materially. There is no service-level agreement, uptime commitment, or guarantee of continued access.',
      'We may suspend, limit, or end the beta (or your access) at any time, with or without notice. Beta access is personal to you unless we expressly allow workspace invites.',
    ],
  },
  {
    id: 'accounts',
    title: '4. Accounts and workspaces',
    body: [
      'You must provide accurate registration information and keep credentials secure. You are responsible for activity under your account and workspaces you control.',
      'You must be at least 16 years old (or the higher age of digital consent in your country) to use the Service.',
      'Notify us promptly if you suspect unauthorized access. We may suspend accounts that appear compromised, abusive, or in violation of these Terms.',
    ],
  },
  {
    id: 'acceptable-use',
    title: '5. Acceptable use',
    body: ['You agree not to:'],
    bullets: [
      'Use the Service unlawfully, or to violate others’ rights or third-party terms (including GitHub, Atlassian/Jira, and model-provider policies).',
      'Attempt to probe, scan, reverse engineer, or disrupt the Service except where applicable law expressly permits.',
      'Bypass rate limits, authentication, confirmation prompts, or safety controls.',
      'Upload or instruct the Service to process malware, credentials you are not authorized to use, or content you do not have rights to process.',
      'Resell, sublicense, or provide the Service to third parties without our written permission.',
      'Use outputs to train competing models or products in a way that extracts proprietary prompts, system behavior, or non-public Service materials.',
    ],
  },
  {
    id: 'third-parties',
    title: '6. Third-party services',
    body: [
      'The Service integrates with third parties you connect (for example GitHub and Jira) and may call AI model providers to generate responses. Those services are governed by their own terms and privacy policies.',
      'You are responsible for configuring permissions (tokens, apps, scopes) appropriately and for complying with the policies of those providers. We do not control third-party availability, accuracy, or security practices.',
      'Provider API keys and integration credentials you supply are intended to be stored encrypted on our API and not returned to the browser or extension. You remain responsible for rotating and revoking credentials you control.',
    ],
  },
  {
    id: 'ai-outputs',
    title: '7. AI outputs and human confirmation',
    body: [
      'AI-generated content may be inaccurate, incomplete, biased, or unsafe. Outputs are suggestions for your review — not legal, security, or professional advice.',
      'You must review results before relying on them. External writes (such as GitHub comments, review submits, or applying patches) are designed to require your confirmation; approving a plan does not by itself authorize a write.',
      'You are solely responsible for decisions you make and actions you take based on the Service, including code you commit, merge, or deploy.',
    ],
  },
  {
    id: 'content',
    title: '8. Your content',
    body: [
      '“Customer Content” means text, code, selections, URLs, metadata, tickets, specs, and other materials you submit or that the Service processes at your direction.',
      `You retain ownership of Customer Content. You grant ${APP_NAME} a limited license to host, process, transmit, and display Customer Content solely to operate and improve the Service for you (including routing requests to AI providers you enable).`,
      'You represent that you have the rights and permissions needed to submit Customer Content and to connect third-party accounts.',
      'Unless we publish a separate Privacy Policy with different rules, we do not claim a right to use Customer Content to train foundation models for unrelated customers. Provider-side retention or training is governed by the provider terms applicable to the models you use through the Service.',
    ],
  },
  {
    id: 'feedback',
    title: '9. Feedback',
    body: [
      `If you provide ideas, bug reports, or suggestions (“Feedback”), you grant ${APP_NAME} a perpetual, worldwide, royalty-free license to use Feedback without restriction or attribution. Feedback is not confidential unless we agree otherwise in writing.`,
    ],
  },
  {
    id: 'ip',
    title: '10. Intellectual property',
    body: [
      `The Service — including software, branding, UI, documentation, and non-Customer Content — is owned by ${APP_NAME} and its licensors. These Terms do not transfer ownership to you.`,
      'We grant you a limited, revocable, non-exclusive, non-transferable license to use the Service during the beta solely for your internal evaluation and development workflows, subject to these Terms.',
    ],
  },
  {
    id: 'confidentiality',
    title: '11. Confidentiality',
    body: [
      'Non-public information about the beta, unreleased features, performance, and security of the Service is confidential. You will not disclose it except to your colleagues who need it and are bound by similar obligations, or as required by law.',
      'Customer Content you process remains yours; this section does not give us ownership of your source code or tickets.',
    ],
  },
  {
    id: 'disclaimer',
    title: '12. Disclaimers',
    body: [
      'THE SERVICE IS PROVIDED “AS IS” AND “AS AVAILABLE.” TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT.',
      'We do not warrant that the Service will be uninterrupted, error-free, secure, or free of harmful components, or that AI outputs will be correct.',
    ],
  },
  {
    id: 'liability',
    title: '13. Limitation of liability',
    body: [
      'TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE AND OUR SUPPLIERS WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE, DATA, GOODWILL, OR BUSINESS INTERRUPTION, EVEN IF ADVISED OF THE POSSIBILITY.',
      'OUR TOTAL LIABILITY ARISING OUT OF OR RELATING TO THE SERVICE OR THESE TERMS WILL NOT EXCEED THE GREATER OF (A) AMOUNTS YOU PAID US FOR THE SERVICE IN THE TWELVE (12) MONTHS BEFORE THE CLAIM OR (B) ONE HUNDRED U.S. DOLLARS (US $100).',
      'Some jurisdictions do not allow certain limitations; in those cases, our liability is limited to the fullest extent permitted.',
    ],
  },
  {
    id: 'indemnity',
    title: '14. Indemnification',
    body: [
      `You will defend and indemnify ${APP_NAME} and its operators against claims, damages, and expenses (including reasonable attorneys’ fees) arising from your Customer Content, your use of the Service, your connected third-party accounts, or your violation of these Terms or applicable law.`,
    ],
  },
  {
    id: 'termination',
    title: '15. Suspension and termination',
    body: [
      'You may stop using the Service at any time and may request account deletion through available product controls or by contacting us.',
      'We may suspend or terminate access immediately for violation of these Terms, risk to the Service or others, legal requirements, or end of the beta. On termination, your license ends and you must stop using the Service and uninstall the extension.',
      'Sections that by nature should survive (including intellectual property, disclaimers, liability limits, and indemnity) will survive termination.',
    ],
  },
  {
    id: 'changes',
    title: '16. Changes to these Terms',
    body: [
      'We may update these Terms from time to time. The “Effective date” above will change when we do. Material changes may be communicated in-product or by email when practical.',
      'Continued use after the updated Terms take effect constitutes acceptance. If you do not agree, stop using the Service.',
    ],
  },
  {
    id: 'general',
    title: '17. General',
    body: [
      'These Terms are the entire agreement between you and us regarding the Service and supersede prior understandings on that subject.',
      'If a provision is unenforceable, the remainder stays in effect. Failure to enforce a provision is not a waiver. You may not assign these Terms without our consent; we may assign them in connection with a reorganization or sale.',
      'These Terms are governed by the laws applicable at the Operator’s principal place of business, without regard to conflict-of-law rules, except where mandatory consumer protections in your country apply.',
      'Nothing in these Terms creates a partnership, employment, or agency relationship.',
    ],
  },
  {
    id: 'contact',
    title: '18. Contact',
    body: [
      `Questions about these Terms: use your private-beta support channel, or open an issue through the channels provided by the ${APP_NAME} maintainers.`,
      'These Terms are a product agreement, not legal advice. Have counsel review them before relying on them for production or enterprise use.',
    ],
  },
] as const;

export default function TermsPage() {
  return (
    <main className="atmosphere relative isolate min-h-dvh">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute inset-0 grid-fade opacity-40" />
        <div className="absolute left-[-8%] top-[-10%] h-[20rem] w-[20rem] rounded-full bg-accent/15 blur-3xl" />
      </div>

      <LandingHeader />

      <article className="relative mx-auto w-full max-w-3xl px-6 pb-16 pt-24 md:px-10 md:pb-20 md:pt-28">
        <header className="landing-fade border-b border-line/70 pb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">Legal</p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl">
            Terms and Conditions
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">
            Effective date: {EFFECTIVE_DATE}. These Terms apply to {APP_NAME} private beta — Chrome
            extension, Studio, and related services.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Canonical URL:{' '}
            <a href={absoluteUrl('/terms')} className="underline-offset-4 hover:underline">
              {absoluteUrl('/terms')}
            </a>
          </p>
        </header>

        <nav aria-label="On this page" className="mt-8 border-b border-line/70 pb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            On this page
          </p>
          <ol className="mt-3 columns-1 gap-x-8 space-y-1.5 text-sm text-muted-foreground sm:columns-2">
            {SECTIONS.map((section) => (
              <li key={section.id} className="break-inside-avoid">
                <a href={`#${section.id}`} className="transition hover:text-ink">
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 space-y-10">
          {SECTIONS.map((section) => (
            <section key={section.id} id={section.id} className="scroll-mt-24">
              <h2 className="font-display text-xl font-semibold tracking-tight text-ink md:text-2xl">
                {section.title}
              </h2>
              <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground md:text-[15px]">
                {section.body.map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
                {'bullets' in section && section.bullets ? (
                  <ul className="list-disc space-y-2 pl-5 text-ink/80">
                    {section.bullets.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </section>
          ))}
        </div>

        <footer className="mt-14 border-t border-line/70 pt-6 text-sm text-muted-foreground">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p>
              <span className="font-medium text-ink">{APP_NAME}</span>
              {' · '}
              Private Beta
            </p>
            <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
              <Link href="/" className="transition hover:text-ink">
                Home
              </Link>
              <Link href="/login" className="transition hover:text-ink">
                Sign in
              </Link>
              <Link href="/terms" className="transition hover:text-ink" aria-current="page">
                Terms
              </Link>
              <Link href="/app" className="transition hover:text-ink">
                Studio
              </Link>
            </nav>
          </div>
        </footer>
      </article>
    </main>
  );
}
