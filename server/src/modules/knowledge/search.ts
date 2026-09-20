import { prisma } from '../../db/prisma.js';
import { CATEGORY_PRIOR_BOOST, priorDocIdFor } from './categoryPriors.js';

export type SearchSource = 'fts' | 'trigram' | 'category_prior';

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
}

export interface SearchKnowledgeOutput {
  results: SearchResult[];
}

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
  if (query === '') return { results: [] };

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
  return { results };
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
