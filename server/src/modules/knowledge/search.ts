import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { CATEGORY_PRIOR_BOOST, priorDocIdFor } from './categoryPriors.js';
import { getEmbeddingProvider } from './embeddings.js';
import { cosineSimilarity } from './localEmbedding.js';

export type SearchSource = 'fts' | 'trigram' | 'category_prior' | 'vector' | 'hybrid';
export type RetrievalMode = 'fts' | 'hybrid';

export interface SearchResult {
  doc_id: string;
  title: string;
  chunk_id: string;
  heading: string | null;
  snippet: string;
  /** Full chunk text (used for grounding and document-trust scanning). */
  content: string;
  score: number;
  source: SearchSource;
  trust_level: string;
  quarantined: boolean;
}

export interface SearchKnowledgeInput {
  query: string;
  categoryHint?: string;
  limit?: number;
  /** Rule R4: only the Phase 5 guardrail self-test may pass true. */
  includeQuarantined?: boolean;
  /** fts (default = env.RETRIEVAL_MODE) or hybrid: FTS ranking fused with embedding cosine similarity (RRF). */
  mode?: RetrievalMode;
}

export interface SearchKnowledgeOutput {
  results: SearchResult[];
  mode: RetrievalMode;
}

// Reciprocal rank fusion constant (Cormack et al. 2009); 60 is the conventional value.
export const RRF_K = 60;
// How many nearest chunks the vector side contributes before fusion.
const VECTOR_CANDIDATES = 8;

interface Row {
  chunk_id: string;
  doc_id: string;
  title: string;
  heading: string | null;
  snippet: string;
  content: string;
  score: number;
  trust_level: string;
  quarantined: boolean;
}

const MIN_FTS_ROWS = 2;
// Chunks that satisfy the strict (all-terms) query outrank partial matches from the OR retry,
// because ts_rank_cd flattens scores for OR queries (CLAUDE.md D-026).
const FULL_MATCH_BONUS = 0.25;
const TRIGRAM_THRESHOLD = 0.15;
const HEADLINE_OPTS = 'StartSel="",StopSel="",MaxWords=40,MinWords=15';

/**
 * Hybrid lexical retrieval over knowledge_chunk (no vector DB):
 *   Stage A  Postgres FTS: websearch_to_tsquery, ts_rank_cd, ts_headline snippet.
 *            The strict (AND) form runs first and its rows carry a full-match bonus; if it yields
 *            < 2 rows the same terms are retried OR-joined so partial matches still rank (D-026).
 *   Stage B  pg_trgm similarity(content, query) > 0.15 when Stage A yields < 2 rows.
 *   Stage C  category prior: the hinted category's document is guaranteed a slot and boosted.
 * Quarantined documents are excluded unless includeQuarantined is explicitly true (rule R4).
 */
export async function searchKnowledge(input: SearchKnowledgeInput): Promise<SearchKnowledgeOutput> {
  const query = input.query.trim();
  const limit = Math.max(1, Math.min(input.limit ?? 5, 50));
  const includeQuarantined = input.includeQuarantined === true;
  const mode: RetrievalMode = input.mode ?? env.RETRIEVAL_MODE;
  if (query === '') return { results: [], mode };

  const merged = new Map<string, SearchResult>();
  const add = (row: Row, source: SearchSource) => {
    if (!merged.has(row.chunk_id)) merged.set(row.chunk_id, toResult(row, source));
  };

  // Stage A — full-text search (strict, then OR-joined).
  let ftsRows = (await ftsStage(query, includeQuarantined, limit)).map((r) => ({
    ...r,
    score: Number(r.score) + FULL_MATCH_BONUS,
  }));
  if (ftsRows.length < MIN_FTS_ROWS) {
    const orQuery = toOrQuery(query);
    if (orQuery && orQuery !== query) {
      const extra = await ftsStage(orQuery, includeQuarantined, limit);
      ftsRows = mergeRows(ftsRows, extra, limit);
    }
  }
  ftsRows.forEach((r) => add(r, 'fts'));

  // Stage B — trigram fallback.
  if (ftsRows.length < MIN_FTS_ROWS) {
    const trigramRows = await trigramStage(query, includeQuarantined, limit);
    trigramRows.forEach((r) => add(r, 'trigram'));
  }

  // Stage B' — hybrid: fuse the lexical ranking with embedding cosine similarity (reciprocal rank
  // fusion). Scores become RRF scores (same scale for both lists), so the category-prior boost
  // below still dominates. Default mode is fts, so the eval baseline does not move (D-071).
  if (mode === 'hybrid') {
    const vectorRows = await vectorStage(query, includeQuarantined, VECTOR_CANDIDATES);
    const lexical = [...merged.values()].sort((a, b) => b.score - a.score);
    const fused = fuseByReciprocalRank(lexical, vectorRows);
    merged.clear();
    for (const r of fused) merged.set(r.chunk_id, r);
  }

  // Stage C — category prior.
  const priorDocId = priorDocIdFor(input.categoryHint);
  if (priorDocId) {
    const existing = [...merged.values()]
      .filter((r) => r.doc_id === priorDocId)
      .sort((a, b) => b.score - a.score)[0];
    if (existing) {
      existing.score = round(existing.score + CATEGORY_PRIOR_BOOST);
      existing.source = 'category_prior';
    } else {
      const best = await bestChunkOfDocument(priorDocId, toOrQuery(query) ?? query, includeQuarantined);
      if (best) {
        const result = toResult(best, 'category_prior');
        result.score = round(result.score + CATEGORY_PRIOR_BOOST);
        merged.set(best.chunk_id, result);
      }
    }
  }

  const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  return { results, mode };
}

/**
 * Reciprocal rank fusion of the lexical list and the vector list: score = Σ 1 / (RRF_K + rank),
 * ranks starting at 1 in each list. A chunk present in both lists gets source 'hybrid'.
 */
export function fuseByReciprocalRank(lexical: SearchResult[], vector: SearchResult[]): SearchResult[] {
  const fused = new Map<string, SearchResult>();
  const bump = (list: SearchResult[], source: SearchSource) => {
    list.forEach((r, i) => {
      const contribution = 1 / (RRF_K + i + 1);
      const existing = fused.get(r.chunk_id);
      if (existing) {
        existing.score = round(existing.score + contribution);
        existing.source = 'hybrid';
      } else {
        fused.set(r.chunk_id, { ...r, score: round(contribution), source });
      }
    });
  };
  bump(lexical, lexical[0]?.source ?? 'fts');
  bump(vector, 'vector');
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

// Vector side of hybrid retrieval: the query is embedded with the same provider that embedded the
// chunks at ingest; cosine similarity is computed in Node over the (small) chunk set.
async function vectorStage(query: string, includeQuarantined: boolean, limit: number): Promise<SearchResult[]> {
  const provider = getEmbeddingProvider();
  const { vectors } = await provider.embed([query]);
  const q = vectors[0] ?? [];
  const chunks = await prisma.knowledgeChunk.findMany({
    where: { ...(includeQuarantined ? {} : { document: { quarantined: false } }), embeddingModel: provider.model },
    select: { id: true, docId: true, heading: true, content: true, embedding: true, document: { select: { title: true, trustLevel: true, quarantined: true } } },
  });
  return chunks
    .map((c) => ({
      doc_id: c.docId,
      title: c.document.title,
      chunk_id: c.id,
      heading: c.heading,
      snippet: c.content.slice(0, 240),
      content: c.content,
      score: round(cosineSimilarity(q, c.embedding)),
      source: 'vector' as SearchSource,
      trust_level: c.document.trustLevel,
      quarantined: c.document.quarantined,
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk_id.localeCompare(b.chunk_id))
    .slice(0, limit);
}

function toResult(row: Row, source: SearchSource): SearchResult {
  return {
    doc_id: row.doc_id,
    title: row.title,
    chunk_id: row.chunk_id,
    heading: row.heading,
    snippet: row.snippet,
    content: row.content,
    score: round(Number(row.score)),
    source,
    trust_level: row.trust_level,
    quarantined: row.quarantined,
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function mergeRows(primary: Row[], extra: Row[], limit: number): Row[] {
  const seen = new Set(primary.map((r) => r.chunk_id));
  const out = [...primary];
  for (const r of extra) {
    if (!seen.has(r.chunk_id)) {
      seen.add(r.chunk_id);
      out.push(r);
    }
  }
  return out.slice(0, limit);
}

// "damaged earbuds replacement" -> "damaged or earbuds or replacement" (websearch syntax).
export function toOrQuery(query: string): string | null {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].filter(
    (t) => t !== 'or' && t !== 'and' && t !== 'not',
  );
  if (terms.length < 2) return null;
  return terms.join(' or ');
}

async function ftsStage(tsQueryText: string, includeQuarantined: boolean, limit: number): Promise<Row[]> {
  return prisma.$queryRaw<Row[]>`
    SELECT c.id AS chunk_id,
           c.doc_id,
           d.title,
           c.heading,
           d.trust_level,
           d.quarantined,
           c.content,
           ts_headline('english', c.content, websearch_to_tsquery('english', ${tsQueryText}), ${HEADLINE_OPTS}) AS snippet,
           ts_rank_cd(c.search_vector, websearch_to_tsquery('english', ${tsQueryText}))::float8 AS score
    FROM knowledge_chunk c
    JOIN knowledge_document d ON d.doc_id = c.doc_id
    WHERE c.search_vector @@ websearch_to_tsquery('english', ${tsQueryText})
      AND (${includeQuarantined} OR d.quarantined = false)
    ORDER BY score DESC, c.doc_id ASC, c.ordinal ASC
    LIMIT ${limit}
  `;
}

async function trigramStage(query: string, includeQuarantined: boolean, limit: number): Promise<Row[]> {
  return prisma.$queryRaw<Row[]>`
    SELECT c.id AS chunk_id,
           c.doc_id,
           d.title,
           c.heading,
           d.trust_level,
           d.quarantined,
           c.content,
           left(c.content, 240) AS snippet,
           similarity(c.content, ${query})::float8 AS score
    FROM knowledge_chunk c
    JOIN knowledge_document d ON d.doc_id = c.doc_id
    WHERE similarity(c.content, ${query}) > ${TRIGRAM_THRESHOLD}
      AND (${includeQuarantined} OR d.quarantined = false)
    ORDER BY score DESC, c.doc_id ASC, c.ordinal ASC
    LIMIT ${limit}
  `;
}

// Best-matching chunk of one document for the query; falls back to its first chunk.
async function bestChunkOfDocument(
  docId: string,
  tsQueryText: string,
  includeQuarantined: boolean,
): Promise<Row | null> {
  const matched = await prisma.$queryRaw<Row[]>`
    SELECT c.id AS chunk_id,
           c.doc_id,
           d.title,
           c.heading,
           d.trust_level,
           d.quarantined,
           c.content,
           ts_headline('english', c.content, websearch_to_tsquery('english', ${tsQueryText}), ${HEADLINE_OPTS}) AS snippet,
           ts_rank_cd(c.search_vector, websearch_to_tsquery('english', ${tsQueryText}))::float8 AS score
    FROM knowledge_chunk c
    JOIN knowledge_document d ON d.doc_id = c.doc_id
    WHERE c.doc_id = ${docId}
      AND (${includeQuarantined} OR d.quarantined = false)
    ORDER BY score DESC, c.ordinal ASC
    LIMIT 1
  `;
  const row = matched[0];
  if (!row) return null;
  if (Number(row.score) === 0) {
    // No lexical overlap: use the first chunk with a plain snippet.
    const first = await prisma.$queryRaw<Row[]>`
      SELECT c.id AS chunk_id, c.doc_id, d.title, c.heading, d.trust_level, d.quarantined, c.content,
             left(c.content, 240) AS snippet, 0::float8 AS score
      FROM knowledge_chunk c
      JOIN knowledge_document d ON d.doc_id = c.doc_id
      WHERE c.doc_id = ${docId}
      ORDER BY c.ordinal ASC
      LIMIT 1
    `;
    return first[0] ?? row;
  }
  return row;
}
