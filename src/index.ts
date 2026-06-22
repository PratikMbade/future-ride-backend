// src/index.ts  — API server only, no blockchain side-effects
import express          from 'express';
import cors             from 'cors';
import { toNodeHandler } from 'better-auth/node';
import * as dotenv      from 'dotenv';
import helmet           from 'helmet';
import compression      from 'compression';
import registrationRoutes from './routes/registration.routes';
dotenv.config();

// ─── Prisma — imported from a standalone module, NOT defined here ───────────
// PREVIOUSLY this file created `export const prisma = new PrismaClient(...)`
// directly, and other files (event-listener.ts etc.) imported it via
// `import { prisma } from '../index'`. That import chain executed THIS
// ENTIRE FILE — Express setup, app.listen(), the WORKER_ROLE check, all of
// it — every time anything imported prisma from here. When worker.ts
// imports event-listener.ts, which imported prisma from index.ts, it
// silently re-ran this file's own blockchain-listener startup INSIDE the
// worker process, on top of worker.ts's own main() doing the same thing —
// causing every listener to open multiple times. prisma now lives in its
// own side-effect-free module; this file re-exports it for any code that
// still expects `prisma` from here, but no other file should import prisma
// from this path going forward — import from './lib/prisma' directly.
import { prisma } from './lib/prisma';
export { prisma };

import { auth }               from './lib/auth';
import dashboardRoutes        from './routes/dashboardRoutes';
import treeRoutes             from './routes/treeRoutes';
import packageRoutes          from './routes/packagesRoutes';
import userRoutes             from './routes/user.routes';
import incomeRoutes           from './routes/income.routes';
import chartRoutes            from './routes/chart.routes';
import previewRoutes          from './routes/preview.routes';
import healthRoutes from './routes/health.routes';

const app  = express();
const PORT = parseInt(process.env.PORT ?? '4000');

app.set('trust proxy', 1);


// ─── security & compression ───────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false, // needed for thirdweb iframe flows
  contentSecurityPolicy:     false, // set by nginx
}));
app.use(compression());             // gzip all JSON responses

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      'https://ficon.space',
      'https://www.ficon.space',
      'http://localhost:3000',
    ];
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: ${origin}`));
    }
  },
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
app.use('/health', healthRoutes);

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
app.use('/api/register', registrationRoutes);
// ─── global error handler ─────────────────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🚀 [API] Worker PID ${process.pid} listening on port ${PORT}`);
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