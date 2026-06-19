// src/routes/health.routes.ts
import { Router, type Request, type Response } from 'express';
import { ethers } from 'ethers';
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

// ─── RPC check helper ──────────────────────────────────────────────────────────
// A live eth_blockNumber call is the simplest possible proof an RPC
// endpoint is actually answering — not just that the URL resolves, but
// that Alchemy is genuinely processing requests right now. Each check
// gets its own timeout so one slow/dead endpoint can't hang the whole
// /health/deep response.
async function checkHttpRpc(url: string, timeoutMs = 5000): Promise<{ status: 'ok' | 'error'; responseMs?: number; error?: string }> {
  const start = Date.now();
  try {
    const provider = new ethers.providers.JsonRpcProvider(url);
    await Promise.race([
      provider.getBlockNumber(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return { status: 'ok', responseMs: Date.now() - start };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  }
}

// WSS check is trickier than HTTP — opening a websocket and waiting for
// it to actually reach 'open' state, with its own timeout, then closing
// it cleanly either way so we don't leak connections on every health check.
async function checkWssRpc(url: string, timeoutMs = 6000): Promise<{ status: 'ok' | 'error'; responseMs?: number; error?: string }> {
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let provider: ethers.providers.WebSocketProvider | null = null;

    const finish = (result: { status: 'ok' | 'error'; responseMs?: number; error?: string }) => {
      if (settled) return;
      settled = true;
      try { provider?.destroy(); } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => finish({ status: 'error', error: 'timeout' }), timeoutMs);

    try {
      provider = new ethers.providers.WebSocketProvider(url);
      provider.getBlockNumber()
        .then(() => {
          clearTimeout(timer);
          finish({ status: 'ok', responseMs: Date.now() - start });
        })
        .catch((err: any) => {
          clearTimeout(timer);
          finish({ status: 'error', error: err.message });
        });
    } catch (err: any) {
      clearTimeout(timer);
      finish({ status: 'error', error: err.message });
    }
  });
}

// ─── GET /health/deep ─────────────────────────────────────────────────────────
// Deep check — verifies DB connection AND both Alchemy RPC endpoints
// (HTTP + WSS) are actually live, not just that the process is running.
// Use this for alerting (not for nginx upstream_hc — too slow for that).
router.get('/deep', async (_req: Request, res: Response) => {
  const start = Date.now();

  const [dbResult, httpRpcResult, wssRpcResult] = await Promise.allSettled([
    (async () => {
      const dbStart = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      return Date.now() - dbStart;
    })(),
    checkHttpRpc(process.env.ALCHEMY_HTTP!),
    checkWssRpc(process.env.ALCHEMY_WSS!),
  ]);

  const dbCheck = dbResult.status === 'fulfilled'
    ? { status: 'ok' as const, responseMs: dbResult.value }
    : { status: 'error' as const, error: (dbResult.reason as Error)?.message ?? 'unknown error' };

  const httpRpcCheck = httpRpcResult.status === 'fulfilled'
    ? httpRpcResult.value
    : { status: 'error' as const, error: 'check threw unexpectedly' };

  const wssRpcCheck = wssRpcResult.status === 'fulfilled'
    ? wssRpcResult.value
    : { status: 'error' as const, error: 'check threw unexpectedly' };

  const allOk = dbCheck.status === 'ok' && httpRpcCheck.status === 'ok' && wssRpcCheck.status === 'ok';

  res.status(allOk ? 200 : 503).json({
    status:  allOk ? 'ok' : 'error',
    pid:     process.pid,
    uptime:  Math.floor(process.uptime()),
    ts:      Date.now(),
    totalCheckMs: Date.now() - start,
    checks: {
      database: dbCheck,
      alchemyHttpRpc: httpRpcCheck,
      alchemyWssRpc:  wssRpcCheck,
      memory: {
        status:       'ok',
        heapUsedMB:   Math.round(process.memoryUsage().heapUsed  / 1024 / 1024),
        heapTotalMB:  Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rssMB:        Math.round(process.memoryUsage().rss       / 1024 / 1024),
      },
    },
  });
});

export default router;