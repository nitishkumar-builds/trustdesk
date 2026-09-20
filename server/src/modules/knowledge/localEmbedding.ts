/**
 * Local hashing-based embedding (Phase 11 item 3), used when EMBEDDING_PROVIDER=local (the default).
 *
 * It is NOT a learned embedding: each chunk becomes a 256-dimensional bag of hashed unigrams and
 * bigrams (FNV-1a feature hashing with a sign bit, log-scaled term frequency, L2-normalised).
 * Cosine similarity over these vectors is therefore a smoothed lexical overlap measure that is
 * robust to word order and tolerant of partial matches, deterministic, dependency-free and needs
 * no network. It gives the hybrid fusion a second, differently-shaped ranking signal; it does not
 * capture synonyms or meaning the way a neural embedding would. Switch EMBEDDING_PROVIDER to
 * openrouter for a real embedding model (see embeddings.ts).
 */

export const LOCAL_EMBEDDING_MODEL = 'local-hash-v1';
export const LOCAL_EMBEDDING_DIMENSIONS = 256;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'be', 'it', 'this', 'that',
  'with', 'as', 'at', 'by', 'from', 'we', 'you', 'your', 'our', 'i', 'my', 'me', 'can', 'will', 'has', 'have', 'had',
  'do', 'does', 'not', 'no', 'if', 'but', 'so', 'than', 'then', 'they', 'their', 'them', 'he', 'she', 'his', 'her',
]);

export function tokenize(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOPWORDS.has(w));
  // crude stemming: plural / -ing / -ed endings, so "refunds" and "refunded" share a bucket with "refund"
  return words.map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/u, '') : w));
}

// 32-bit FNV-1a; the low bit chooses the sign, the rest the bucket (classic hashing trick).
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function embedLocal(text: string, dimensions = LOCAL_EMBEDDING_DIMENSIONS): number[] {
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    counts.set(tokens[i]!, (counts.get(tokens[i]!) ?? 0) + 1);
    if (i + 1 < tokens.length) {
      const bigram = `${tokens[i]} ${tokens[i + 1]}`;
      counts.set(bigram, (counts.get(bigram) ?? 0) + 0.5);
    }
  }
  const vector = new Array<number>(dimensions).fill(0);
  for (const [feature, tf] of counts) {
    const h = fnv1a(feature);
    const bucket = (h >>> 1) % dimensions;
    const sign = h & 1 ? 1 : -1;
    vector[bucket]! += sign * Math.log1p(tf);
  }
  return normalise(vector);
}

export function normalise(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
