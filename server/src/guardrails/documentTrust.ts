import { scanUntrustedInput } from './inputScanner.js';
import { DOCUMENT_REJECT_GROUPS } from './patterns.js';

// Minimal shape so both SearchResult rows and raw test fixtures can be assessed.
export interface AssessableChunk {
  doc_id: string;
  title?: string;
  trust_level?: string;
  quarantined?: boolean;
  /** Section heading; scanned together with the body (it reaches the prompt too). */
  heading?: string | null;
  /** Full chunk text; `snippet` is used only when `content`/`text` are absent. */
  content?: string;
  text?: string;
  snippet?: string;
}

export interface DocumentFinding {
  doc_id: string;
  reason: 'untrusted_instructions_in_document';
  detail: 'quarantined' | 'pattern_match';
  matched_terms: string[];
}

export interface DocumentAssessment<T extends AssessableChunk> {
  safeChunks: T[];
  rejectedDocIds: string[];
  findings: DocumentFinding[];
}

/**
 * Rule R4: drops any chunk whose document is quarantined (or marked untrusted) or whose text
 * trips INSTRUCTION_OVERRIDE / CONCEALMENT. Rejected chunks never reach a prompt or a citation.
 */
export function assessDocuments<T extends AssessableChunk>(chunks: T[]): DocumentAssessment<T> {
  const safeChunks: T[] = [];
  const findings: DocumentFinding[] = [];
  const rejected = new Set<string>();

  for (const chunk of chunks) {
    const quarantined = chunk.quarantined === true || (chunk.trust_level !== undefined && chunk.trust_level !== 'trusted');
    const body = chunk.content ?? chunk.text ?? chunk.snippet ?? '';
    const text = chunk.heading ? `${chunk.heading}\n${body}` : body;
    const scan = scanUntrustedInput(text, 'retrieved_document');
    const hits = scan.matches.filter((m) => DOCUMENT_REJECT_GROUPS.has(m.group));

    if (quarantined || hits.length > 0) {
      rejected.add(chunk.doc_id);
      findings.push({
        doc_id: chunk.doc_id,
        reason: 'untrusted_instructions_in_document',
        detail: quarantined ? 'quarantined' : 'pattern_match',
        matched_terms: hits.map((h) => h.term),
      });
      continue;
    }
    safeChunks.push(chunk);
  }

  return { safeChunks, rejectedDocIds: [...rejected], findings };
}
