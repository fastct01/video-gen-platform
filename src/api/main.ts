import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { listProviders } from '../providers/registry.js';
import { closeQueues } from '../queue/queues.js';
import { buildApp } from './app.js';

const app = await buildApp();
await app.listen({ port: config.PORT, host: '0.0.0.0' });
app.log.info(`providers: ${listProviders().map((p) => p.id).join(', ') || 'none (set GEMINI_API_KEY or MOCK_PROVIDER_ENABLED=true)'}`);

async function shutdown() {
  await app.close();
  await closeQueues();
  await pool.end();
  process.exit(0);
}
// In combined mode (src/main.ts) the worker owns shutdown: it waits for running jobs, then exits.
if (!process.env.VS_COMBINED) {
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
