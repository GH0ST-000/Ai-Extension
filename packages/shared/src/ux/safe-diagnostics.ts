import type { SafeDiagnostics } from '@project-x/types';

/** Build a clipboard-safe diagnostics block — content-free by construction. */
export function formatSafeDiagnostics(input: SafeDiagnostics): string {
  const lines = [
    'Project X diagnostics',
    input.appRelease ? `Release: ${input.appRelease}` : null,
    input.extensionVersion ? `Extension: ${input.extensionVersion}` : null,
    `Client: ${input.client}`,
    input.integration ? `Integration: ${input.integration}` : null,
    input.workspacePlan ? `Plan: ${input.workspacePlan}` : null,
    input.githubConnectionState ? `GitHub: ${input.githubConnectionState}` : null,
    typeof input.online === 'boolean' ? `Online: ${input.online ? 'yes' : 'no'}` : null,
    input.errorCode ? `Error code: ${input.errorCode}` : null,
    input.requestReference ? `Reference: ${input.requestReference}` : null,
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    const clipboard = (
      globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } }
    ).navigator?.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}
