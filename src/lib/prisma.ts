// src/lib/prisma.ts
//
// Standalone Prisma client module with NO other side effects — no Express
// app, no routes, no listeners. Both index.ts (API) and worker.ts
// (blockchain) import from HERE, never from each other.
//
// WHY THIS FILE NEEDS TO EXIST: any file that did
// `import { prisma } from '../index'` was transitively executing index.ts's
// ENTIRE top-level code (Express setup, app.listen(), the WORKER_ROLE check
// and ITS OWN copy of the blockchain listener startup) every time it ran —
// including inside worker.ts's process, where event-listener.ts pulled
// prisma in from '../index'. That's almost certainly what caused multiple
// sets of WebSocket listeners to open simultaneously: worker.ts's own
// main() started one set, and importing event-listener.ts (which imports
// prisma from index.ts) silently re-ran index.ts's blockchain-listener
// startup block a second (or third) time in the same process.

import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
dotenv.config();

export const prisma = new PrismaClient({
  log: ['warn', 'error'],
  datasources: { db: { url: process.env.DATABASE_URL } },
});