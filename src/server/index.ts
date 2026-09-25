import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { config, imapConfigured, validateConfig } from './config.ts';
import { Store } from './db.ts';
import { Syncer } from './sync.ts';

validateConfig({ server: true });
const store = await Store.connect(config.db);
const syncer = new Syncer(store);
const app = createApp(store, syncer);

const server = serve({ fetch: app.fetch, hostname: config.http.host, port: config.http.port }, (info) => {
  console.log(
    `TLSRPT dashboard listening on http://${info.address}:${info.port} (public URL ${config.http.publicUrl}, ` +
      `db ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}, ` +
      `login via ${config.oidc.issuer} for groups: ${config.oidc.allowedGroups.join(', ')})`,
  );
});

if (imapConfigured()) {
  syncer.run().catch(() => {});
  syncer.schedule(config.syncIntervalMinutes);
} else {
  console.warn('IMAP is not configured; set IMAP_HOST, IMAP_USERNAME and IMAP_PASSWORD to fetch reports.');
}

// Graceful shutdown on SIGTERM (docker stop, Kubernetes) and SIGINT (Ctrl+C). Node runs as
// PID 1 in the container, where signals without a handler are ignored, so these handlers are
// what makes the container stop promptly.
const SHUTDOWN_TIMEOUT_MS = 8000; // below Docker's default 10 s grace period
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    console.warn(`${signal} received again, exiting immediately`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => {
    console.error(`shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS / 1000} s, exiting`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // Stop accepting connections (idle keep-alive connections are closed), let a running
  // mailbox sync finish its current message, then close the database pool.
  const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  await syncer.stop();
  // In-flight requests have had the sync's duration to finish; cut any that remain.
  if ('closeAllConnections' in server) server.closeAllConnections();
  await httpClosed;
  await store.close();
  console.log('shutdown complete');
  process.exit(0);
}
process.on('SIGINT', (s) => void shutdown(s));
process.on('SIGTERM', (s) => void shutdown(s));
