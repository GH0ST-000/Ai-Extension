/**
 * Global setup of the integration run: refuse to start — never skip — unless the database is
 * explicitly a throwaway one. Each suite repeats the name/port check before connecting.
 */
export default function requireIntegrationDatabase(): void {
  const raw = process.env.MEMORY_IT_DATABASE_URL;
  if (!raw) {
    throw new Error(
      'MEMORY_IT_DATABASE_URL is not set. Integration tests need a throwaway PostgreSQL ' +
        'database: run `pnpm --filter @project-x/api test:integration` (starts one in Docker).',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MEMORY_IT_DATABASE_URL is not a valid URL.');
  }
  if (!url.pathname.endsWith('_it') || url.port === '5432' || url.port === '') {
    throw new Error(
      `Refusing to run integration tests against ${url.host}${url.pathname}: the database ` +
        'name must end in "_it" and the port must not be the default 5432.',
    );
  }
  const local = ['127.0.0.1', 'localhost', '[::1]', 'postgres'].includes(url.hostname);
  if (!local) {
    throw new Error(`Refusing to run integration tests against the remote host ${url.hostname}.`);
  }
}
