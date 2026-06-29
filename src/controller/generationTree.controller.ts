// src/controllers/treeController.ts
import { Request, Response } from 'express';
import { prisma } from '..';

interface HighestPackage {
  packageNumber: number;
  packageName:   string;
  packageAmount: number;
}

interface TreeNodeResponse {
  id:              string;
  address:         string;
  referralAddress: string;
  contractRegId:   number | null;
  isRegistered:    boolean;
  highestPackage:  HighestPackage | null;
  left:            TreeNodeResponse | null;
  right:           TreeNodeResponse | null;
}

// ─────────────────────────────────────────────────────────
//  Targeted subtree fetch — only pulls the nodes actually
//  needed for the requested depth, not the whole tree table.
//
//  depth=3 (the default) covers root → children → grandchildren
//  → great-grandchildren, i.e. exactly the 1+2+4+8 = 15 nodes the
//  UI renders in one screen. Even on a tree with 100k users this
//  never fetches more than a few dozen rows.
//
//  Approach: breadth-first expansion, one DB round-trip per
//  level instead of one giant findMany() for the whole table,
//  plus a single trailing query for everyone's highest package.
// ─────────────────────────────────────────────────────────
async function buildSubtree(
  rootUserId: string,
  maxDepth:   number,
): Promise<TreeNodeResponse | null> {

  // level 0: just the root's tree row + user row
  const rootTreeRow = await prisma.generationTree.findUnique({
    where:  { uplineUserId: rootUserId },
    select: { uplineUserId: true, leftUserId: true, rightUserId: true },
  });

  const rootUser = await prisma.user.findUnique({
    where:  { id: rootUserId },
    select: {
      id: true, userAddress: true, referalAddress: true,
      contractRegId: true, isRegistered: true,
    },
  });
  if (!rootUser) return null;

  // collect userIds level by level — never more than ~2^depth ids in flight
  const treeRowMap = new Map<string, typeof rootTreeRow>();
  if (rootTreeRow) treeRowMap.set(rootUserId, rootTreeRow);

  const userMap = new Map([[rootUser.id, rootUser]]);

  let frontier: string[] = [];
  if (rootTreeRow?.leftUserId)  frontier.push(rootTreeRow.leftUserId);
  if (rootTreeRow?.rightUserId) frontier.push(rootTreeRow.rightUserId);

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    // fetch this level's tree rows + user rows in 2 queries (not per-node)
    const [treeRows, users] = await Promise.all([
      prisma.generationTree.findMany({
        where:  { uplineUserId: { in: frontier } },
        select: { uplineUserId: true, leftUserId: true, rightUserId: true },
      }),
      prisma.user.findMany({
        where:  { id: { in: frontier } },
        select: {
          id: true, userAddress: true, referalAddress: true,
          contractRegId: true, isRegistered: true,
        },
      }),
    ]);

    for (const row of treeRows) treeRowMap.set(row.uplineUserId, row);
    for (const u of users)      userMap.set(u.id, u);

    // build next frontier from this level's children
    const next: string[] = [];
    for (const row of treeRows) {
      if (row.leftUserId)  next.push(row.leftUserId);
      if (row.rightUserId) next.push(row.rightUserId);
    }
    frontier = next;
  }

  // ── highest package per user, one query for the whole subtree ──
  // Ordering by packageNumber desc means the first row we see for a
  // given userId is already their highest — no groupBy/aggregate needed.
  const allUserIds = Array.from(userMap.keys());
  const highestPackageMap = new Map<string, HighestPackage>();

  if (allUserIds.length > 0) {
    const packageRows = await prisma.package.findMany({
      where:   { userId: { in: allUserIds } },
      orderBy: { packageNumber: 'desc' },
      select:  { userId: true, packageNumber: true, packageName: true, packageAmount: true },
    });

    for (const p of packageRows) {
      if (!highestPackageMap.has(p.userId)) {
        highestPackageMap.set(p.userId, {
          packageNumber: p.packageNumber,
          packageName:   p.packageName,
          packageAmount: p.packageAmount,
        });
      }
    }
  }

  // build response tree purely from the in-memory maps (no more DB calls)
  function buildNode(userId: string, depth: number): TreeNodeResponse | null {
    if (depth > maxDepth) return null;
    const user = userMap.get(userId);
    if (!user) return null;
    const row = treeRowMap.get(userId);

    return {
      id:              user.id,
      address:         user.userAddress,
      referralAddress: user.referalAddress ?? '',
      contractRegId:   user.contractRegId ?? null,
      isRegistered:    user.isRegistered,
      highestPackage:  highestPackageMap.get(userId) ?? null,
      left:  row?.leftUserId  ? buildNode(row.leftUserId,  depth + 1) : null,
      right: row?.rightUserId ? buildNode(row.rightUserId, depth + 1) : null,
    };
  }

  return buildNode(rootUserId, 0);
}

// ─────────────────────────────────────────────────────────
//  GET /api/tree/:userAddress
// ─────────────────────────────────────────────────────────
export const getGenerationTree = async (req: Request, res: Response) => {
  try {
    const raw = req.params.userAddress;

    if (
      !raw || typeof raw !== 'string' ||
      raw === 'undefined' || raw === 'null' || raw.trim() === ''
    ) {
      res.status(400).json({ error: 'userAddress is required', received: raw ?? null });
      return;
    }

    const userAddress = raw.toLowerCase().trim();

    const isValidEvmAddress = /^0x[a-f0-9]{40}$/.test(userAddress);
    if (!isValidEvmAddress) {
      res.status(400).json({ error: 'Invalid wallet address format', received: raw });
      return;
    }

    const maxDepthRaw = parseInt(req.query.depth as string);
    const maxDepth     = Number.isFinite(maxDepthRaw)
      ? Math.min(Math.max(maxDepthRaw, 1), 15)
      : 3; // default = root + 3 generations = 1+2+4+8 = 15 nodes, matching the UI

    const user = await prisma.user.findUnique({
      where:  { userAddress },
      select: { id: true, isRegistered: true },
    });

    if (!user) {
      res.status(404).json({
        error: `No registered user found for address ${userAddress}`,
        code:  'USER_NOT_FOUND',
      });
      return;
    }

    const tree = await buildSubtree(user.id, maxDepth);

    if (!tree) {
      res.status(404).json({ error: 'Generation tree not found for this user', code: 'TREE_NOT_FOUND' });
      return;
    }

    res.status(200).json({ success: true, userAddress, tree });

  } catch (error: any) {
    console.error('getGenerationTree error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};