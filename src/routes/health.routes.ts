// src/routes/health.routes.ts
import { Router, type Request, type Response } from 'express';
import { prisma } from '..';

const router = Router();

// ─── GET /health ──────────────────────────────────────────────────────────────
// Basic liveness check — used by nginx, PM2, and uptime monitors.
// Returns immediately without hitting the DB.
router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    status:  'ok',
    pid:     process.pid,
    uptime:  Math.floor(process.uptime()),   // seconds since process started
    ts:      Date.now(),
  });
});

// ─── GET /health/deep ─────────────────────────────────────────────────────────
// Deep check — verifies DB connection is alive.
// Use this for alerting (not for nginx upstream_hc — too slow for that).
router.get('/deep', async (_req: Request, res: Response) => {
  const start = Date.now();

  try {
    // lightweight DB ping — just count one row
    await prisma.$queryRaw`SELECT 1`;
    const dbMs = Date.now() - start;

    res.status(200).json({
      status:   'ok',
      pid:      process.pid,
      uptime:   Math.floor(process.uptime()),
      ts:       Date.now(),
      checks: {
        database: { status: 'ok', responseMs: dbMs },
        memory: {
          status:       'ok',
          heapUsedMB:   Math.round(process.memoryUsage().heapUsed  / 1024 / 1024),
          heapTotalMB:  Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          rssMB:        Math.round(process.memoryUsage().rss       / 1024 / 1024),
        },
      },
    });

  } catch (err: any) {
    // DB is down — return 503 so load balancers pull this instance
    res.status(503).json({
      status:  'error',
      pid:     process.pid,
      ts:      Date.now(),
      checks: {
        database: { status: 'error', error: err.message },
      },
    });
  }
});

export default router;