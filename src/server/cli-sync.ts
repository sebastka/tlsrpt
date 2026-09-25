// One-shot sync from the command line: `npm run sync [-- --full]`.
import { config, validateConfig } from './config.ts';
import { Store } from './db.ts';
import { Syncer } from './sync.ts';

validateConfig({ server: false });
const store = await Store.connect(config.db);
try {
  await new Syncer(store).run({ full: process.argv.includes('--full') });
} catch {
  process.exitCode = 1;
} finally {
  await store.close();
}
