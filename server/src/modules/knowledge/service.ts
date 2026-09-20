import { prisma } from '../../db/prisma.js';
import { getEmbeddingProvider } from './embeddings.js';
import { KNOWLEDGE_BASE_DIR, REPO_ROOT } from '../../config/paths.js';
import { notFoundError } from '../../errors/AppError.js';
import { scanUntrustedInput } from '../../guardrails/inputScanner.js';
import { DOCUMENT_REJECT_GROUPS } from '../../guardrails/patterns.js';
import {
  chunkMarkdown,
  loadKnowledgeBase,
  sha256,
  QUARANTINED_DOC_IDS,
  type ParsedDocument,
} from './loader.js';
import type { IngestDocumentInput } from './schemas.js';

// Ingest-time quarantine (rule R4): a document that carries instruction-override or concealment
// language is stored untrusted + quarantined. Same groups as guardrails/documentTrust.ts.
export function looksLikeInjection(content: string): boolean {
  return scanUntrustedInput(content, 'retrieved_document').categories.some((g) => DOCUMENT_REJECT_GROUPS.has(g));
}

export interface DocumentListItemDto {
  doc_id: string;
  title: string;
  version: string;
  audience: string;
  trust_level: string;
  quarantined: boolean;
  chunk_count: number;
  /** Embedding model stored for the chunks (null when none was computed). */
  embedding_model: string | null;
}

export interface DocumentChunkDto {
  chunk_id: string;
  ordinal: number;
  heading: string | null;
  content: string;
}

export interface DocumentDetailDto extends DocumentListItemDto {
  source_path: string;
  checksum: string;
  updated_at: string;
  content: string;
  chunks: DocumentChunkDto[];
}

export interface IngestResult {
  ingested: number;
  document_ids: string[];
}

// Single persistence path used by the seeder, /documents/ingest and /documents/reingest:
// upsert the document row and replace its chunk set in one transaction (CLAUDE.md D-015).
export async function persistParsedDocument(doc: ParsedDocument): Promise<void> {
  // Phase 11 item 3: embeddings are computed at ingest with the configured provider (local hashing by
  // default), so hybrid retrieval can be switched on at query time without re-ingesting.
  const embeddings = await getEmbeddingProvider().embed(doc.chunks.map((c) => `${c.heading ?? ''}\n${c.content}`));
  const data = {
    title: doc.title,
    content: doc.content,
    sourcePath: doc.sourcePath,
    version: doc.version,
    audience: doc.audience,
    trustLevel: doc.trustLevel,
    quarantined: doc.quarantined,
    checksum: doc.checksum,
    updatedAt: new Date(),
  };
  await prisma.$transaction([
    prisma.knowledgeDocument.upsert({
      where: { docId: doc.docId },
      create: { docId: doc.docId, ...data },
      update: data,
    }),
    prisma.knowledgeChunk.deleteMany({ where: { docId: doc.docId } }),
    prisma.knowledgeChunk.createMany({
      data: doc.chunks.map((chunk, i) => ({
        docId: doc.docId,
        ordinal: chunk.ordinal,
        heading: chunk.heading,
        content: chunk.content,
        embedding: embeddings.vectors[i] ?? [],
        embeddingModel: embeddings.model,
      })),
    }),
  ]);
}

// API ingest: same quarantine rule as the loader (R4) plus an injection-pattern check.
export function toParsedDocument(input: IngestDocumentInput): ParsedDocument {
  const quarantined =
    QUARANTINED_DOC_IDS.has(input.doc_id) ||
    input.doc_id.toUpperCase().includes('ADVERSARIAL') ||
    looksLikeInjection(input.content);
  return {
    docId: input.doc_id,
    title: input.title,
    content: input.content,
    sourcePath: input.source_path ?? `api://documents/ingest/${input.doc_id}`,
    version: input.version ?? 'unversioned',
    audience: input.audience ?? 'unknown',
    trustLevel: quarantined ? 'untrusted' : 'trusted',
    quarantined,
    checksum: sha256(input.content),
    chunks: chunkMarkdown(input.content, input.title),
  };
}

export async function ingestDocuments(inputs: IngestDocumentInput[]): Promise<IngestResult> {
  const ids: string[] = [];
  for (const input of inputs) {
    await persistParsedDocument(toParsedDocument(input));
    ids.push(input.doc_id);
  }
  return { ingested: ids.length, document_ids: ids };
}

export async function reingestFromDisk(): Promise<IngestResult> {
  const docs = await loadKnowledgeBase(KNOWLEDGE_BASE_DIR, REPO_ROOT);
  for (const doc of docs) await persistParsedDocument(doc);
  return { ingested: docs.length, document_ids: docs.map((d) => d.docId) };
}

export async function listDocuments(): Promise<{ items: DocumentListItemDto[]; total: number }> {
  const rows = await prisma.knowledgeDocument.findMany({
    include: { _count: { select: { chunks: true } }, chunks: { select: { embeddingModel: true }, take: 1 } },
    orderBy: { docId: 'asc' },
  });
  const items = rows.map((d) => ({
    doc_id: d.docId,
    title: d.title,
    version: d.version,
    audience: d.audience,
    trust_level: d.trustLevel,
    quarantined: d.quarantined,
    chunk_count: d._count.chunks,
    embedding_model: d.chunks[0]?.embeddingModel ?? null,
  }));
  return { items, total: items.length };
}

export async function getDocument(docId: string): Promise<DocumentDetailDto> {
  const d = await prisma.knowledgeDocument.findUnique({
    where: { docId },
    include: { chunks: { orderBy: { ordinal: 'asc' } } },
  });
  if (!d) throw notFoundError(`Document ${docId} not found`);
  return {
    doc_id: d.docId,
    title: d.title,
    version: d.version,
    audience: d.audience,
    trust_level: d.trustLevel,
    quarantined: d.quarantined,
    chunk_count: d.chunks.length,
    embedding_model: d.chunks[0]?.embeddingModel ?? null,
    source_path: d.sourcePath,
    checksum: d.checksum,
    updated_at: d.updatedAt.toISOString(),
    content: d.content,
    chunks: d.chunks.map((c) => ({
      chunk_id: c.id,
      ordinal: c.ordinal,
      heading: c.heading,
      content: c.content,
    })),
  };
}
