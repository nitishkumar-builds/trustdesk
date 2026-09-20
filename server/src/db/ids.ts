import { createId } from '@paralleldrive/cuid2';

// Prefixed cuid generator for every non-pack entity. Pack entities keep their natural ids.
export const ID_PREFIXES = {
  draft: 'draft_',
  run: 'run_',
  action: 'act_',
  approval: 'appr_',
  evalRun: 'eval_run_',
  feedback: 'fb_',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}${createId()}`;
}
