// src/routes/preview.routes.ts
import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/authMiddleware';
import { prisma } from '..';

const router = Router();
router.use(requireAuth); // only auth required — not requireRegistered

// ─── shared pagination ────────────────────────────────────
function getPagination(query: Record<string, any>) {
  const page     = Math.max(1, parseInt(query.page) || 1);
  const pageSize = [10, 25, 50, 100].includes(parseInt(query.limit))
    ? parseInt(query.limit) : 10;
  const skip   = (page - 1) * pageSize;
  const search = (query.search ?? '').toLowerCase().trim();
  return { page, pageSize, skip, search };
}

// ─── BFS community count ──────────────────────────────────
async function countCommunity(rootUserId: string): Promise<number> {
  const allNodes = await prisma.generationTree.findMany({
    select: { uplineUserId: true, leftUserId: true, rightUserId: true },
  });
  const childMap = new Map<string, string[]>();
  for (const node of allNodes) {
    const children: string[] = [];
    if (node.leftUserId)  children.push(node.leftUserId);
    if (node.rightUserId) children.push(node.rightUserId);
    if (children.length)  childMap.set(node.uplineUserId, children);
  }
  let count = 0;
  const queue = [rootUserId];
  const seen  = new Set<string>([rootUserId]);
  while (queue.length) {
    const cur      = queue.shift()!;
    const children = childMap.get(cur) ?? [];
    for (const child of children) {
      if (!seen.has(child)) { seen.add(child); queue.push(child); count++; }
    }
  }
  return count;
}

function sumAmount(records: { amount: string }[]): number {
  return records.reduce((acc, r) => acc + parseFloat(r.amount ?? '0'), 0);
}
// ─────────────────────────────────────────────────────────
//  GET /api/preview/:userAddress/info
//  Overview card — same shape as /api/user/me
// ─────────────────────────────────────────────────────────
router.get('/:userAddress/info', async (req: Request, res: Response) => {
  try {
    const userAddress = String(req.params.userAddress).toLowerCase().trim();
    const user = await prisma.user.findUnique({
      where:  { userAddress },
      select: {
        id: true, userAddress: true, contractRegId: true,
        isRegistered: true, referalAddress: true, createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: `User ${userAddress} not found` });
      return;
    }

    const [highestPkg, directTeamCount, communityCount] = await Promise.all([
      prisma.package.findFirst({
        where:   { userId: user.id },
        orderBy: { packageNumber: 'desc' },
        select:  { packageNumber: true, packageName: true, createdAt: true },
      }),
      prisma.user.count({
        where: { referalAddress: user.userAddress, isRegistered: true },
      }),
      countCommunity(user.id),
    ]);

    const baseUrl      = process.env.FRONTEND_URL ?? 'http://localhost:5173';
    const referralLink = `${baseUrl}/register?ref=${user.userAddress}`;
    const referredBy   = user.referalAddress === user.userAddress
      ? null : user.referalAddress;

      const [directRecs, genRecs, lapsRecs] = await Promise.all([
  prisma.directIncome.findMany({
    where:  { userId: user.id },
    select: { amount: true },
  }),
  prisma.generationIncome.findMany({
    where:  { userId: user.id },
    select: { amount: true },
  }),
  prisma.lapsIncome.findMany({
    where:  { userId: user.id },
    select: { amount: true },
  }),
]);

const directIncome     = sumAmount(directRecs);
const generationIncome = sumAmount(genRecs);
const lapsIncome       = sumAmount(lapsRecs);

    res.json({
      success: true,
      userAddress:         user.userAddress,
      contractRegId:       user.contractRegId,
      isRegistered:        user.isRegistered,
      joinedAt:            user.createdAt.toISOString(),
      highestPackage:      highestPkg?.packageNumber    ?? 0,
      packageName:         highestPkg?.packageName      ?? 'None',
      packagePurchaseDate: highestPkg?.createdAt?.toISOString() ?? user.createdAt.toISOString(),
      referredBy,
      referralLink,
      directTeamCount,
        directIncome,
  generationIncome,
  lapsIncome,
      totalCommunityTeam: communityCount,
    });

  } catch (e: any) {
    console.error('preview/info error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────
//  GET /api/preview/:userAddress/generation-tree
// ─────────────────────────────────────────────────────────
router.get('/:userAddress/generation-tree', async (req: Request, res: Response) => {
  try {
    const userAddress = String(req.params.userAddress).toLowerCase().trim();    const maxDepth    = Math.min(parseInt(req.query.depth as string) || 10, 15);

    const user = await prisma.user.findUnique({
      where:  { userAddress },
      select: { id: true },
    });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    // same single-query approach as treeController
    const [allTreeNodes, allUsers] = await Promise.all([
      prisma.generationTree.findMany({
        select: { uplineUserId: true, leftUserId: true, rightUserId: true },
      }),
      prisma.user.findMany({
        select: { id: true, userAddress: true, referalAddress: true, contractRegId: true, isRegistered: true },
      }),
    ]);

    const userMap = new Map(allUsers.map(u => [u.id, u]));
    const treeMap = new Map(allTreeNodes.map(n => [n.uplineUserId, n]));

    function buildNode(userId: string, depth: number): any {
      if (depth > maxDepth) return null;
      const u = userMap.get(userId);
      if (!u) return null;
      const node = treeMap.get(userId);
      return {
        id: u.id, address: u.userAddress,
        referralAddress: u.referalAddress ?? '',
        contractRegId: u.contractRegId ?? null,
        isRegistered: u.isRegistered,
        left:  node?.leftUserId  ? buildNode(node.leftUserId,  depth + 1) : null,
        right: node?.rightUserId ? buildNode(node.rightUserId, depth + 1) : null,
      };
    }

    res.json({ success: true, tree: buildNode(user.id, 0) });

  } catch (e: any) {
    console.error('preview/tree error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────
//  GET /api/preview/:userAddress/direct-team
// ─────────────────────────────────────────────────────────
router.get('/:userAddress/direct-team', async (req: Request, res: Response) => {
  try {
    const userAddress = String(req.params.userAddress).toLowerCase().trim();
        const { page, pageSize, skip, search } = getPagination(req.query);

    const user = await prisma.user.findUnique({
      where:  { userAddress },
      select: { id: true, userAddress: true },
    });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const where = {
      referalAddress: user.userAddress,
      isRegistered:   true,
      ...(search ? { userAddress: { contains: search, mode: 'insensitive' as const } } : {}),
    };

    const [members, total] = await Promise.all([
      prisma.user.findMany({
        where, skip, take: pageSize,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, userAddress: true, contractRegId: true,
          isRegistered: true, createdAt: true,
          packages: { orderBy: { packageNumber: 'desc' }, take: 1, select: { packageNumber: true, packageName: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    const addrs = members.map(m => m.userAddress);
    const subCounts = await prisma.user.groupBy({
      by: ['referalAddress'],
      where: { referalAddress: { in: addrs }, isRegistered: true },
      _count: { _all: true },
    });
    const subMap = new Map(subCounts.map(r => [r.referalAddress, r._count._all]));

    const rows = members.map((m, idx) => ({
      id: m.id, rank: skip + idx + 1,
      userAddress: m.userAddress, contractRegId: m.contractRegId,
      isRegistered: m.isRegistered, joinedAt: m.createdAt.toISOString(),
      highestPackage: m.packages[0]?.packageNumber ?? 0,
      packageName:    m.packages[0]?.packageName   ?? 'None',
      directTeam: subMap.get(m.userAddress) ?? 0,
    }));

    res.json({ success: true, total, page, pageSize, totalPages: Math.ceil(total / pageSize), members: rows });

  } catch (e: any) {
    console.error('preview/direct-team error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────
//  GET /api/preview/:userAddress/income/direct
// ─────────────────────────────────────────────────────────
router.get('/:userAddress/income/direct', async (req: Request, res: Response) => {
  try {
    const userAddress = String(req.params.userAddress).toLowerCase().trim();
        const { page, pageSize, skip, search } = getPagination(req.query);

    const user = await prisma.user.findUnique({ where: { userAddress }, select: { id: true } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const where = {
      userId: user.id,
      ...(search ? { fromUserAddress: { contains: search, mode: 'insensitive' as const } } : {}),
    };

    const [records, total] = await Promise.all([
      prisma.directIncome.findMany({
        where, skip, take: pageSize,
        orderBy: { createdAt: 'desc' },
        select: { id: true, fromUserAddress: true, packageNumber: true, packageName: true, amount: true, timestamp: true, transactionHash: true, createdAt: true },
      }),
      prisma.directIncome.count({ where }),
    ]);

    res.json({ success: true, total, page, pageSize, totalPages: Math.ceil(total / pageSize), records });

  } catch (e: any) {
    console.error('preview/direct-income error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────
//  GET /api/preview/:userAddress/income/generation
// ─────────────────────────────────────────────────────────
router.get('/:userAddress/income/generation', async (req: Request, res: Response) => {
  try {
    const userAddress = String(req.params.userAddress).toLowerCase().trim();
        const { page, pageSize, skip, search } = getPagination(req.query);

    const user = await prisma.user.findUnique({ where: { userAddress }, select: { id: true } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const where = {
      userId: user.id,
      ...(search ? { fromUserAddress: { contains: search, mode: 'insensitive' as const } } : {}),
    };

    const [records, total] = await Promise.all([
      prisma.generationIncome.findMany({
        where, skip, take: pageSize,
        orderBy: { createdAt: 'desc' },
        select: { id: true, fromUserAddress: true, packageNumber: true, packageName: true, amount: true, timestamp: true, transactionHash: true, level: true, createdAt: true },
      }),
      prisma.generationIncome.count({ where }),
    ]);

    res.json({ success: true, total, page, pageSize, totalPages: Math.ceil(total / pageSize), records });

  } catch (e: any) {
    console.error('preview/gen-income error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;