// src/index.ts  — API server only, no blockchain side-effects
import express          from 'express';
import cors             from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { PrismaClient } from '@prisma/client';
import * as dotenv      from 'dotenv';
import helmet           from 'helmet';
import compression      from 'compression';
import {
  registrationEventListener,
  packageBuyEventListener,
  packageUpgradeEventListener,
  directIncomeEventListener,
  generationEventListener,
  lapsIncomeEventListener,
} from './contract/event-listener';
import { startSyncScheduler } from './services/syncService';
dotenv.config();

// ─── Prisma singleton per process ─────────────────────────────────────────────
export const prisma = new PrismaClient({
  log: ['warn', 'error'],
  // Connection pool: keep 5 idle + allow burst to 10 per API worker process.
  // With 2 cluster workers → max 20 PG connections total. Stays well inside
  // DigitalOcean's managed PG default of 25 max_connections.
  datasources: { db: { url: process.env.DATABASE_URL } },
});

import { auth }               from './lib/auth';
import dashboardRoutes        from './routes/dashboardRoutes';
import treeRoutes             from './routes/treeRoutes';
import packageRoutes          from './routes/packagesRoutes';
import userRoutes             from './routes/user.routes';
import incomeRoutes           from './routes/income.routes';
import chartRoutes            from './routes/chart.routes';
import previewRoutes          from './routes/preview.routes';

const app  = express();
const PORT = parseInt(process.env.PORT ?? '4000');

// ─── security & compression ───────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false, // needed for thirdweb iframe flows
  contentSecurityPolicy:     false, // set by nginx
}));
app.use(compression());             // gzip all JSON responses

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin:      process.env.FRONTEND_URL,
  credentials: true,
}));

// ─── better-auth BEFORE express.json ─────────────────────────────────────────
app.use('/api/auth/*splat', toNodeHandler(auth));
// ─── body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));   // reject giant payloads

// ─── rate limiting (in-process, per cluster worker) ──────────────────────────
// For 1000 users × 10 req/min = ~167 rps.  Each worker gets its own bucket.
// In cluster mode, limits are per-process — that's fine since we keep them loose.
import rateLimit from 'express-rate-limit';

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max:      120,          // 120 requests per IP per worker process per minute
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, slow down.' },
  skip: (req) => req.path.startsWith('/api/auth'), // auth has its own limit
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max:      30,               // 30 auth attempts per IP per 15 min
  message: { error: 'Too many auth attempts.' },
});

app.use('/api/',     apiLimiter);
app.use('/api/auth', authLimiter);

// ─── health check — used by nginx upstream_hc and PM2 ────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', pid: process.pid, ts: Date.now() });
});

// ─── routes ───────────────────────────────────────────────────────────────────
app.use('/api/dashboard',    dashboardRoutes);
app.use('/api/tree',         treeRoutes);
app.use('/api/packages',     packageRoutes);
app.use('/api/user',         userRoutes);
app.use('/api/income',       incomeRoutes);
app.use('/api/charts',       chartRoutes);
app.use('/api/preview',      previewRoutes);

// ─── global error handler ─────────────────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🚀 [API] Worker PID ${process.pid} listening on port ${PORT}`);

  // ONLY start blockchain listeners if running as a single process (dev mode).
  // In production, PM2 runs worker.ts separately.
 if (process.env.WORKER_ROLE !== 'api') {
  registrationEventListener();
  packageBuyEventListener();
  packageUpgradeEventListener();
  directIncomeEventListener();
  generationEventListener();
  lapsIncomeEventListener();
  startSyncScheduler(5 * 60 * 1000);
  console.log('✅ Blockchain listeners + sync scheduler started');
}

});

// ─── graceful shutdown ────────────────────────────────────────────────────────
// PM2 sends SIGINT on restart. We drain in-flight requests before closing.
process.on('SIGINT', async () => {
  console.log(`[PID ${process.pid}] Shutting down gracefully…`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // hard kill after 5 s if drain hangs
  setTimeout(() => process.exit(1), 5000);
});

process.on('SIGTERM', async () => {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
});

export default app;