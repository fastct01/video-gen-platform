/**
 * Runs the API and the worker in one process. Used for single-container hosting (Docker / Render),
 * where both need the same disk for local video storage. Locally you can still run them separately
 * with `npm run dev:api` and `npm run dev:worker`.
 */
process.env.VS_COMBINED = '1';
await import('./api/main.js');
await import('./worker/main.js');
