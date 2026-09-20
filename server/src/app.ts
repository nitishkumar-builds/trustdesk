import express, { Router, type Express, type Request } from 'express';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { notFoundError } from './errors/AppError.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { enforcePolicy } from './middleware/policy.js';
import { openRouter as authOpenRouter, router as authRouter } from './modules/auth/router.js';
import { router as customersRouter } from './modules/customers/router.js';
import { router as draftsRouter } from './modules/drafts/router.js';
import { router as evalsRouter } from './modules/evals/router.js';
import { router as feedbackRouter } from './modules/feedback/router.js';
import { router as knowledgeRouter } from './modules/knowledge/router.js';
import { router as metricsRouter } from './modules/metrics/router.js';
import { router as ordersRouter } from './modules/orders/router.js';
import { router as redTeamRouter } from './modules/redTeam/router.js';
import { router as ticketsRouter } from './modules/tickets/router.js';
import { router as toolActionsRouter } from './modules/toolActions/router.js';
import { router as tracesRouter } from './modules/traces/router.js';
import { router as triageRouter } from './modules/triage/router.js';

export const APP_VERSION = '0.1.0';

export const logger = pino({ level: env.LOG_LEVEL });

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestId);
  app.use(express.json({ limit: '1mb' }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).requestId,
      autoLogging: env.NODE_ENV !== 'test',
    }),
  );

  // No auth on this route.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: APP_VERSION, ai_provider: env.AI_PROVIDER });
  });

  // Every route under /api requires a bearer token (demo token or JWT) except POST /api/auth/login;
  // per-route role policies live in middleware/policy.ts and are enforced once, here.
  const api = Router();
  api.use(authOpenRouter);
  api.use(requireAuth);
  api.use(enforcePolicy);
  api.use(authRouter);
  api.use(ticketsRouter);
  api.use(customersRouter);
  api.use(ordersRouter);
  api.use(knowledgeRouter);
  api.use(triageRouter);
  api.use(draftsRouter);
  api.use(toolActionsRouter);
  api.use(tracesRouter);
  api.use(evalsRouter);
  api.use(metricsRouter);
  api.use(feedbackRouter);
  api.use(redTeamRouter);
  app.use('/api', api);

  app.use((req, _res, next) => {
    next(notFoundError(`Route ${req.method} ${req.path} not found`));
  });
  app.use(errorHandler);

  return app;
}
