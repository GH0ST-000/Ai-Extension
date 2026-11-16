/**
 * Public install link for the Project X browser extension, if one has been configured for
 * this deployment (`NEXT_PUBLIC_EXTENSION_INSTALL_URL`). Only an https URL is accepted; when
 * none is configured the UI shows setup guidance instead of inventing a store link.
 */
export function getExtensionInstallUrl(
  raw: string | undefined = process.env.NEXT_PUBLIC_EXTENSION_INSTALL_URL,
): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
