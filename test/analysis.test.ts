import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { buildOverview, reportSessions } from '../src/server/analysis.ts';
import { decodePayload, normalizeReport, ReportFormatError } from '../src/server/tlsrpt.ts';
import { extractReports } from '../src/server/mail.ts';
import { fixture, rows } from './helpers.ts';

test('normalizeReport parses an MTA-STS report and its mode', () => {
  const r = normalizeReport(fixture('google-sts.json'));
  assert.equal(r.organizationName, 'Google Inc.');
  assert.equal(r.start, '2026-08-27T00:00:00.000Z');
  assert.equal(r.policies.length, 1);
  assert.deepEqual(
    { type: r.policies[0]!.type, mode: r.policies[0]!.mode, ok: r.policies[0]!.successful, mx: r.policies[0]!.mxHosts },
    { type: 'sts', mode: 'testing', ok: 2, mx: ['mx.domeneshop.no'] },
  );
});

test('normalizeReport rejects reports without mandatory fields', () => {
  assert.throws(() => normalizeReport({ 'organization-name': 'x' }), ReportFormatError);
  assert.throws(() => normalizeReport([]), ReportFormatError);
});

test('decodePayload handles gzip and plain JSON, rejects zip', () => {
  const json = JSON.stringify(fixture('google-sts.json'));
  assert.deepEqual(decodePayload(gzipSync(json)), JSON.parse(json));
  assert.deepEqual(decodePayload(Buffer.from(json)), JSON.parse(json));
  assert.throws(() => decodePayload(Buffer.from('PK\u0003\u0004')), ReportFormatError);
});

test('sessions reported under several policies for one domain are not double counted', () => {
  assert.deepEqual(reportSessions(rows('microsoft-tlsa-sts.json')[0]!.policies), { sessions: 4, failed: 0 });
});

test('buildOverview aggregates KPIs, failures and insights', () => {
  const o = buildOverview(
    rows('google-sts.json', 'microsoft-tlsa-sts.json', 'synthetic-failures.json'),
    {},
    new Date('2026-09-11T00:00:00Z'),
  );
  // google 2 + microsoft 4 (deduped) + synthetic 100 (example.com) + 5 (example.org)
  assert.equal(o.kpis.sessions, 111);
  assert.equal(o.kpis.failed, 10);
  assert.equal(o.kpis.reports, 3);
  assert.equal(o.kpis.domains, 3);
  assert.equal(o.bucket, 'day');
  assert.equal(o.series[0]!.start, '2026-08-18');
  assert.equal(o.series.at(-1)!.start, '2026-09-10');
  assert.equal(o.series.length, 24);
  assert.deepEqual(
    o.failureTypes.map((f) => [f.resultType, f.sessions]),
    [
      ['certificate-expired', 7],
      ['starttls-not-supported', 3],
    ],
  );
  assert.equal(o.failureDetails[0]!.receivingIp, '198.51.100.25');
  const titles = o.insights.map((i) => i.title);
  assert.ok(titles.some((t) => t.startsWith('10 failed TLS sessions')));
  assert.ok(titles.includes('MTA-STS for karlsen.fr is in testing mode'));
  assert.ok(titles.includes('Reporters found no policy for example.org'));
  const sts = o.byPolicy.find((p) => p.domain === 'karlsen.fr' && p.type === 'sts')!;
  assert.equal(sts.reports, 2);
  assert.equal(sts.successful, 6);
});

test('long ranges are bucketed by ISO week', () => {
  const o = buildOverview(rows('google-sts.json'), { from: '2026-01-01', to: '2026-09-25' });
  assert.equal(o.bucket, 'week');
  assert.equal(o.series[0]!.start, '2025-12-29'); // Monday
  assert.equal(
    o.series.reduce((n, b) => n + b.successful, 0),
    2,
  );
});

test('extractReports finds a gzip tlsrpt attachment in a MIME message', async () => {
  const gz = gzipSync(JSON.stringify(fixture('google-sts.json'))).toString('base64');
  const eml = [
    'From: TLS Reports <noreply@example.net>',
    'Subject: Report Domain: karlsen.fr',
    'Message-ID: <x@example.net>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type="tlsrpt"; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain',
    '',
    'This is a report.',
    '--b',
    'Content-Type: application/tlsrpt+gzip',
    'Content-Disposition: attachment; filename="example.net!karlsen.fr!1!2.json.gz"',
    'Content-Transfer-Encoding: base64',
    '',
    gz,
    '--b--',
    '',
  ].join('\r\n');
  const m = await extractReports(Buffer.from(eml));
  assert.equal(m.from, 'noreply@example.net');
  assert.equal(m.errors.length, 0);
  assert.equal(m.reports.length, 1);
  assert.equal(m.reports[0]!.report.reportId, '2026-08-27T00:00:00Z_karlsen.fr');
});
