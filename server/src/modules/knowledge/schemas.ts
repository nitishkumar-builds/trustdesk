import { z } from 'zod';

export const ingestDocumentSchema = z.object({
  doc_id: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(200000),
  source_path: z.string().min(1).max(500).optional(),
  version: z.string().min(1).max(50).optional(),
  audience: z.string().min(1).max(200).optional(),
});
export type IngestDocumentInput = z.infer<typeof ingestDocumentSchema>;

export const ingestBodySchema = z.object({
  documents: z.array(ingestDocumentSchema).min(1).max(100),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(1000),
  category: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(5),
  mode: z.enum(['fts', 'hybrid']).optional(),
});

export const docIdParamSchema = z.object({ docId: z.string().min(1) });
