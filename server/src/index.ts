import { env } from './config/env.js';
import { createApp, logger } from './app.js';
import { getToolRegistry } from './modules/toolActions/registry.js';

const app = createApp();

// Warm the tool registry at boot so a missing executor fails loudly before the first request.
getToolRegistry()
  .then((registry) => logger.info({ tools: [...registry.keys()] }, 'Tool registry loaded'))
  .catch((err) => logger.error({ err }, 'Tool registry failed to load; tool actions will retry lazily'));

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, ai_provider: env.AI_PROVIDER }, 'TrustDesk API listening');
});
