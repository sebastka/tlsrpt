// One-shot sync from the command line: `npm run sync [-- --full]`.
import { config, validateConfig } from './config.ts';
import { Store } from './db.ts';
import { Syncer } from './sync.ts';

validateConfig({ server: false });
const store = await Store.connect(config.db);
const syncer = new Syncer(store);
// Ctrl+C / SIGTERM: finish the current message and log out of IMAP; the next run resumes.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void syncer.stop());
try {
  await syncer.run({ full: process.argv.includes('--full') });
} catch {
  process.exitCode = 1;
} finally {
  await store.close();
}
