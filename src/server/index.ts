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

function shutdown() {
  syncer.stop();
  server.close(() => {
    store.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
