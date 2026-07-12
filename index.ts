/**
 * Root entrypoint for Vercel Node.js deployment.
 * Re-exports and starts the Express app from src/api/server.
 */
import { app } from './src/api/server.js';

export default app;
