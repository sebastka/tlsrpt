// HTTP API, OIDC login routes and (in production) the static UI.
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { Filters, Me, ReportDetail } from '../shared/types.ts';
import { buildOverview, summarizeReport } from './analysis.ts';
import { type AppEnv, Auth, sameOriginGuard } from './auth.ts';
import { config } from './config.ts';
import type { Store } from './db.ts';
import type { Syncer } from './sync.ts';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseFilters(q: Record<string, string>): Filters {
  const f: Filters = {};
  if (q.from && DAY_RE.test(q.from)) f.from = q.from;
  if (q.to && DAY_RE.test(q.to)) f.to = q.to;
  if (q.domain) f.domain = q.domain.toLowerCase();
  if (q.org) f.org = q.org;
  return f;
}

export function createApp(store: Store, syncer: Syncer): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const auth = new Auth(store);

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  app.use('*', secureHeaders({ crossOriginEmbedderPolicy: false }));
  app.use('*', sameOriginGuard());
  app.use('*', auth.middleware());
  auth.routes(app);

  app.get('/api/health', (c) => c.json({ ok: true }));

  // The auth middleware guarantees a user on every /api route except /api/health.
  app.get('/api/me', (c) => c.json<Me>({ user: c.get('user')! }));

  app.get('/api/filters', async (c) => c.json(await store.filterOptions()));

  app.get('/api/overview', async (c) => {
    const filters = parseFilters(c.req.query());
    return c.json(buildOverview(await store.loadReports(filters), filters));
  });

  app.get('/api/reports', async (c) => {
    const reports = (await store.loadReports(parseFilters(c.req.query()))).map(summarizeReport);
    return c.json(reports.sort((a, b) => b.start.localeCompare(a.start) || b.id - a.id));
  });

  app.get('/api/reports/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404);
    const [row, src] = await Promise.all([store.reportById(id), store.reportSource(id)]);
    if (!row || !src) return c.json({ error: 'not found' }, 404);
    const detail: ReportDetail = {
      ...summarizeReport(row),
      contactInfo: row.contactInfo,
      policies: row.policies.map(({ id: _id, ...p }) => p),
      source: { from: src.from, subject: src.subject, filename: src.filename },
      raw: src.raw,
    };
    return c.json(detail);
  });

  app.get('/api/sync', async (c) => c.json(await syncer.status()));

  app.post('/api/sync', async (c) => {
    // Fire and forget; the UI polls GET /api/sync for progress.
    syncer.run().catch(() => {});
    return c.json(await syncer.status(), 202);
  });

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  if (existsSync(config.staticDir)) {
    // serveStatic resolves paths relative to the working directory.
    const root = relative(process.cwd(), config.staticDir) || '.';
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ root, path: 'index.html' }));
  } else {
    app.get('/', (c) =>
      c.text('UI not built. Run "npm run build", or use "npm run dev" and open the Vite dev server.', 404),
    );
  }

  return app;
}
