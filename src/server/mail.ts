// Extracts TLSRPT payloads from a raw RFC 822 message.
import { simpleParser, type Attachment } from 'mailparser';
import { decodePayload, normalizeReport, type NormalizedReport } from './tlsrpt.ts';

export interface ExtractedMessage {
  messageId: string | null;
  from: string | null;
  subject: string | null;
  date: string | null;
  reports: { filename: string | null; raw: unknown; report: NormalizedReport }[];
  errors: string[];
}

function looksLikeReport(a: Attachment): boolean {
  const type = a.contentType.toLowerCase();
  const name = (a.filename ?? '').toLowerCase();
  return (
    type.startsWith('application/tlsrpt') ||
    name.endsWith('.json.gz') ||
    name.endsWith('.json') ||
    ((type === 'application/gzip' || type === 'application/x-gzip') && name.endsWith('.gz'))
  );
}

export async function extractReports(source: Buffer): Promise<ExtractedMessage> {
  const mail = await simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const out: ExtractedMessage = {
    messageId: mail.messageId ?? null,
    from: mail.from?.value[0]?.address?.toLowerCase() ?? null,
    subject: mail.subject ?? null,
    date: mail.date ? mail.date.toISOString() : null,
    reports: [],
    errors: [],
  };
  for (const a of mail.attachments.filter(looksLikeReport)) {
    try {
      const raw = decodePayload(a.content);
      out.reports.push({ filename: a.filename ?? null, raw, report: normalizeReport(raw) });
    } catch (e) {
      out.errors.push(`${a.filename ?? a.contentType}: ${(e as Error).message}`);
    }
  }
  return out;
}
