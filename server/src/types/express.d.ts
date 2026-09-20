import type { Principal } from '../middleware/auth.js';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      principal?: Principal;
    }
  }
}

export {};
