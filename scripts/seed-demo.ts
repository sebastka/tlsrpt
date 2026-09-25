// Fills a separate demo database with synthetic reports to preview the UI with failures:
//   npm run demo   (seeds DB_NAME=tlsrpt_demo and starts the server on it)
import { config } from '../src/server/config.ts';
import { Store } from '../src/server/db.ts';
import { normalizeReport } from '../src/server/tlsrpt.ts';

if (!config.db.database.endsWith('_demo')) {
  throw new Error(`refusing to seed "${config.db.database}": the demo database name must end with _demo`);
}
const store = await Store.connect(config.db);
// Policies and failures cascade.
await store.pool.query('DELETE FROM reports');

let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const reporters = [
  { org: 'Google Inc.', volume: 40 },
  { org: 'Microsoft Corporation', volume: 25, dane: true },
  { org: 'Example Mail AB', volume: 6 },
];
const sts = ['version: STSv1', 'mode: testing', 'mx: mx.example.com', 'max_age: 86400'];

let n = 0;
for (let d = 120; d >= 1; d--) {
  const start = new Date(Date.now() - d * 86_400_000);
  start.setUTCHours(0, 0, 0, 0);
  const day = start.toISOString().slice(0, 10);
  for (const r of reporters) {
    if (rand() < 0.25) continue;
    const total = Math.round(r.volume * (0.5 + rand()));
    const incident = d > 40 && d < 47; // an expired certificate for a week
    const failed = incident ? Math.round(total * 0.3) : rand() < 0.1 ? 1 : 0;
    const failures = failed
      ? [
          incident
            ? {
                'result-type': 'certificate-expired',
                'receiving-mx-hostname': 'mx.example.com',
                'receiving-ip': '198.51.100.25',
                'sending-mta-ip': '192.0.2.10',
                'failed-session-count': failed,
              }
            : {
                'result-type': 'starttls-not-supported',
                'receiving-mx-hostname': 'mx2.example.com',
                'receiving-ip': '198.51.100.26',
                'sending-mta-ip': '192.0.2.11',
                'failed-session-count': failed,
              },
        ]
      : [];
    const policies: unknown[] = [
      {
        policy: {
          'policy-type': 'sts',
          'policy-string': sts,
          'policy-domain': 'example.com',
          'mx-host': ['mx.example.com'],
        },
        summary: { 'total-successful-session-count': total - failed, 'total-failure-session-count': failed },
        'failure-details': failures,
      },
    ];
    if (r.dane) {
      policies.push({
        policy: { 'policy-type': 'tlsa', 'policy-string': ['3 1 1 0000'], 'policy-domain': 'example.com' },
        summary: { 'total-successful-session-count': total, 'total-failure-session-count': 0 },
      });
    }
    if (rand() < 0.2) {
      policies.push({
        policy: { 'policy-type': 'no-policy-found', 'policy-domain': 'example.org' },
        summary: { 'total-successful-session-count': Math.round(rand() * 5) + 1, 'total-failure-session-count': 0 },
      });
    }
    const raw = {
      'organization-name': r.org,
      'date-range': { 'start-datetime': `${day}T00:00:00Z`, 'end-datetime': `${day}T23:59:59Z` },
      'contact-info': 'tlsrpt@example.net',
      'report-id': `${day}_${r.org}`,
      policies,
    };
    const received = new Date(start.getTime() + 86_400_000 + 10 * 3_600_000).toISOString();
    await store.insertReport(normalizeReport(raw), raw, {
      from: 'tlsrpt@example.net',
      subject: `Report ${day}`,
      filename: null,
      receivedAt: received,
    });
    n++;
  }
}
await store.close();
console.log(`wrote ${n} synthetic reports to ${config.db.database}`);
