// ecosystem.config.js

module.exports = {
  apps: [

    // ─────────────────────────────────────────────────────────────────────────
    //  API SERVER — cluster mode, 3 workers
    //
    //  Why 3 and not 4?
    //  We reserve 1 vCPU for the blockchain worker + OS/Nginx overhead.
    //  3 API workers on a 4-vCPU box gives ~75% utilisation headroom before
    //  any single core saturates.
    //
    //  Memory budget (8 GB total):
    //    3 × API worker  = 3 × 500 MB max  = 1.5 GB
    //    1 × blockchain  = 1 × 800 MB max  = 0.8 GB
    //    PostgreSQL      = ~1.0 GB (if local) or 0 (if managed)
    //    Nginx           = ~0.05 GB
    //    OS + buffers    = ~0.5 GB
    //    Free headroom   = ~4.15 GB  ← plenty of room for traffic spikes
    // ─────────────────────────────────────────────────────────────────────────
    {
      name:        'future-ride-api',
      script:      'dist/index.js',
      instances:   3,               // 3 of 4 vCPUs for HTTP traffic
      exec_mode:   'cluster',
      watch:       false,
      autorestart: true,
      max_restarts: 15,
      min_uptime:  '10s',

      // ── memory guard ────────────────────────────────────────────────────
      // Each Prisma pool holds 5–10 idle PG connections.
      // Node + Prisma + V8 heap at idle is ~80 MB; 500 MB gives generous room.
      max_memory_restart: '500M',

      // ── graceful shutdown ────────────────────────────────────────────────
      // PM2 sends SIGINT, Express drains in-flight requests, then exits.
      // kill_timeout is the hard-kill deadline if drain stalls.
      kill_timeout:   6000,   // 6 s hard kill
      listen_timeout: 4000,   // 4 s for the port to become ready

      // ── environment ─────────────────────────────────────────────────────
      env_production: {
        NODE_ENV:    'production',
        PORT:        4005,
        WORKER_ROLE: 'api',     // prevents blockchain code from running here
      },

      // ── logging ─────────────────────────────────────────────────────────
      out_file:    '/var/log/pm2/future-ride-api-out.log',
      error_file:  '/var/log/pm2/future-ride-api-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:  true,  // merge all 3 cluster workers into one log file
    },


    // ─────────────────────────────────────────────────────────────────────────
    //  BLOCKCHAIN WORKER — single fork, owns WSS + sync scheduler
    //
    //  Must be singleton. If two processes listen to the same contract events
    //  via separate WebSocket connections, every on-chain event triggers 2×
    //  DB writes, causing unique constraint violations and double income records.
    //
    //  Memory budget:
    //  The sync service does prisma.generationTree.findMany() (all rows) and
    //  holds the result in memory during BFS. At 10k users that's ~10k rows
    //  × ~200 bytes = ~2 MB — tiny. 800 MB cap is a generous safety net.
    // ─────────────────────────────────────────────────────────────────────────
    {
      name:        'future-ride-worker',
      script:      'dist/worker.js',
      instances:   1,
      exec_mode:   'fork',          // MUST be fork — never cluster
      watch:       false,
      autorestart: true,
      max_restarts: 25,             // WSS drops are expected; restart quickly
      min_uptime:   '8s',           // if it dies in < 8 s, count as a crash

      max_memory_restart: '800M',

      // Longer kill timeout — give the WebSocket time to close cleanly and
      // let the current sync batch checkpoint its lastSyncedBlock before exit.
      kill_timeout: 10000,  // 10 s

      env_production: {
        NODE_ENV:    'production',
        WORKER_ROLE: 'blockchain',
      },

      out_file:   '/var/log/pm2/future-ride-worker-out.log',
      error_file: '/var/log/pm2/future-ride-worker-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

  ],
};
