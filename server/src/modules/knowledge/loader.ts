import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Rule R4: this document is ingested but quarantined — never grounding context, never cited.
export const QUARANTINED_DOC_IDS: ReadonlySet<string> = new Set(['KB-ADVERSARIAL-001']);

export interface ParsedChunk {
  ordinal: number;
  heading: string | null;
  content: string;
}

export interface ParsedDocument {
  docId: string;
  title: string;
  content: string;
  sourcePath: string;
  version: string;
  audience: string;
  trustLevel: 'trusted' | 'untrusted';
  quarantined: boolean;
  checksum: string;
  chunks: ParsedChunk[];
}

const HEADER_FIELD = /^(Doc ID|Audience|Version):\s*(.+?)\s*$/;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Parses one knowledge-base markdown file from the pack.
 * - doc_id comes from the "Doc ID:" line (never invented); missing -> throws.
 * - title is the first H1.
 * - chunks split on H2 headings; a doc with no H2 is one chunk.
 */
export function parseKnowledgeMarkdown(raw: string, sourcePath: string): ParsedDocument {
  const lines = raw.split(/\r?\n/);
  let title: string | null = null;
  const fields: Record<string, string> = {};

  for (const line of lines) {
    if (title === null && line.startsWith('# ')) {
      title = line.slice(2).trim();
      continue;
    }
    const m = HEADER_FIELD.exec(line);
    if (m) fields[m[1]!] = m[2]!;
  }

  const docId = fields['Doc ID'];
  if (!docId) throw new Error(`Knowledge document ${sourcePath} has no "Doc ID:" line`);
  if (!title) throw new Error(`Knowledge document ${sourcePath} (${docId}) has no H1 title`);

  const quarantined = QUARANTINED_DOC_IDS.has(docId);

  return {
    docId,
    title,
    content: raw,
    sourcePath,
    version: fields['Version'] ?? 'unknown',
    audience: fields['Audience'] ?? 'unknown',
    trustLevel: quarantined ? 'untrusted' : 'trusted',
    quarantined,
    checksum: sha256(raw),
    chunks: chunkMarkdown(raw, title),
  };
}

/**
 * Splits markdown on H2 (`## `) headings. The preamble (H1 + Doc ID / Audience / Version lines)
 * is kept only when prose remains after removing those lines. No H2 -> one chunk.
 */
export function chunkMarkdown(raw: string, title: string | null): ParsedChunk[] {
  const lines = raw.split(/\r?\n/);
  const sections: Array<{ heading: string | null; body: string[] }> = [{ heading: null, body: [] }];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      sections.push({ heading: line.slice(3).trim(), body: [] });
    } else {
      sections[sections.length - 1]!.body.push(line);
    }
  }

  const chunks: ParsedChunk[] = [];
  for (const section of sections) {
    let body = section.body;
    if (section.heading === null) {
      body = body.filter(
        (l) => !(title !== null && l.trim() === `# ${title}`) && !HEADER_FIELD.test(l),
      );
    }
    const content = body.join('\n').trim();
    if (section.heading === null && content === '') continue;
    chunks.push({ ordinal: chunks.length, heading: section.heading, content });
  }

  if (chunks.length === 0) {
    chunks.push({ ordinal: 0, heading: null, content: raw.trim() });
  }
  return chunks;
}

/**
 * Loads every .md under `knowledgeBaseDir`. `repoRoot` is used to compute the repo-relative
 * sourcePath (e.g. data/knowledge_base/refund_policy.md).
 */
export async function loadKnowledgeBase(
  knowledgeBaseDir: string,
  repoRoot: string,
): Promise<ParsedDocument[]> {
  const entries = await readdir(knowledgeBaseDir);
  const files = entries.filter((f) => f.toLowerCase().endsWith('.md')).sort();
  const docs: ParsedDocument[] = [];
  for (const file of files) {
    const abs = path.join(knowledgeBaseDir, file);
    const raw = await readFile(abs, 'utf8');
    const sourcePath = path.relative(repoRoot, abs).split(path.sep).join('/');
    docs.push(parseKnowledgeMarkdown(raw, sourcePath));
  }
  return docs;
}
