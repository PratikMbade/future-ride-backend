// src/controllers/generationTeamController.ts
//
// Lists every descendant of the logged-in user across the binary
// GenerationTree, each annotated with its generation level (distance
// from the logged-in user as root = level 1, their direct left/right
// children = level 2, etc.), plus contractRegId, userAddress, sponsor
// address, and highest package.
//
// Unlike DirectIncome/GenerationIncome (which have a `level` column we
// can filter on directly in SQL), GenerationTree has no level column —
// level is purely structural (depth from the root in the binary tree).
// So filtering by level can't be pushed into a WHERE clause the way
// package filtering can; it requires walking the tree first to compute
// each node's level, THEN filtering/paginating in application code.

import { Request, Response } from "express";
import { prisma } from "..";

interface TeamMemberNode {
  userId:         string;
  userAddress:    string;
  level:          number;
}

// ─── BFS walk that records each descendant's level ─────────
// Same childMap-building approach as countCommunity in dashboardController,
// but instead of just counting, we record (userId, level) for every node
// so level-based filtering is possible afterward.
async function walkGenerationTree(rootUserId: string): Promise<TeamMemberNode[]> {
  const allNodes = await prisma.generationTree.findMany({
    select: {
      uplineUserId: true,
      leftUserId:   true,
      leftChildAddress: true,
      rightUserId:  true,
      rightChildAddress: true,
    },
  });

  const childMap = new Map<string, { userId: string; userAddress: string }[]>();
  for (const node of allNodes) {
    const children: { userId: string; userAddress: string }[] = [];
    if (node.leftUserId && node.leftChildAddress) {
      children.push({ userId: node.leftUserId, userAddress: node.leftChildAddress });
    }
    if (node.rightUserId && node.rightChildAddress) {
      children.push({ userId: node.rightUserId, userAddress: node.rightChildAddress });
    }
    if (children.length > 0) childMap.set(node.uplineUserId, children);
  }

  const result: TeamMemberNode[] = [];
  const seen = new Set<string>([rootUserId]);

  // queue holds [userId, level] pairs — root's direct children start at level 1
  let queue: { userId: string; level: number }[] =
    (childMap.get(rootUserId) ?? []).map(c => ({ userId: c.userId, level: 1 }));

  // also need userAddress for each queued node — re-derive from childMap entries
  const addressLookup = new Map<string, string>();
  for (const children of childMap.values()) {
    for (const c of children) addressLookup.set(c.userId, c.userAddress);
  }

  while (queue.length > 0) {
    const { userId, level } = queue.shift()!;
    if (seen.has(userId)) continue;
    seen.add(userId);

    result.push({
      userId,
      userAddress: addressLookup.get(userId) ?? '',
      level,
    });

    const children = childMap.get(userId) ?? [];
    for (const child of children) {
      if (!seen.has(child.userId)) {
        queue.push({ userId: child.userId, level: level + 1 });
      }
    }
  }

  return result;
}

// ─── GET /api/dashboard/generation-team ───────────────────
export const getGenerationTeam = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;

    const page       = Math.max(1, parseInt(req.query.page  as string) || 1);
    const pageSize    = Math.min(50, parseInt(req.query.limit as string) || 10);
    const search      = (req.query.search as string ?? '').toLowerCase().trim();
    const pkgFilter   = parseInt(req.query.package as string) || 0;
    const levelFilter = req.query.level !== undefined && req.query.level !== ''
      ? parseInt(req.query.level as string)
      : undefined;

    // ── 1. walk the tree once to get every descendant + their level ──
    const allMembers = await walkGenerationTree(dbUser.id);

    // ── 2. apply level filter in-memory (structural — can't be a WHERE clause) ──
    const levelFiltered = levelFilter !== undefined
      ? allMembers.filter(m => m.level === levelFilter)
      : allMembers;

    if (levelFiltered.length === 0) {
      res.json({
        success: true, total: 0, page, pageSize, totalPages: 0, members: [],
      });
      return;
    }

    // ── 3. fetch user details for ONLY the level-filtered set ──
    // (avoids loading user/package data for the entire tree when a level
    // filter has already narrowed things down — package/search filters
    // below operate on this already-reduced set)
    const memberIds = levelFiltered.map(m => m.userId);

    const userWhere: any = {
      id: { in: memberIds },
      ...(search ? { userAddress: { contains: search, mode: 'insensitive' } } : {}),
    };
    if (pkgFilter > 0) {
      userWhere.packages = { some: { packageNumber: pkgFilter } };
    }

    const users = await prisma.user.findMany({
      where: userWhere,
      select: {
        id:             true,
        userAddress:    true,
        contractRegId:  true,
        referalAddress: true,
        isRegistered:   true,
        createdAt:      true,
        packages: {
          orderBy: { packageNumber: 'desc' },
          take:    1,
          select:  { packageNumber: true, packageName: true },
        },
      },
    });

    const levelById = new Map(levelFiltered.map(m => [m.userId, m.level]));

    // ── 4. merge level info + sort (level asc, then createdAt desc) ──
    const merged = users
      .map(u => ({
        id:             u.id,
        userAddress:    u.userAddress,
        contractRegId:  u.contractRegId,
        sponsorAddress: u.referalAddress,
        isRegistered:   u.isRegistered,
        joinedAt:       u.createdAt.toISOString(),
        generationLevel: levelById.get(u.id) ?? 0,
        highestPackage: u.packages[0]?.packageNumber ?? 0,
        packageName:    u.packages[0]?.packageName   ?? 'None',
      }))
      .sort((a, b) => a.generationLevel - b.generationLevel || b.joinedAt.localeCompare(a.joinedAt));

    const total      = merged.length;
    const totalPages = Math.ceil(total / pageSize);
    const skip       = (page - 1) * pageSize;
    const pageRows   = merged.slice(skip, skip + pageSize).map((m, idx) => ({
      ...m,
      rank: skip + idx + 1,
    }));

    res.json({
      success: true,
      total,
      page,
      pageSize,
      totalPages,
      members: pageRows,
    });

  } catch (error: any) {
    console.error('generation-team error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};