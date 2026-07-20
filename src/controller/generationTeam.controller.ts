// src/controllers/generationTeamController.ts
//
// Lists every descendant of the logged-in user across the binary
// GenerationTree, each annotated with its generation level (distance
// from the logged-in user as root = level 1, their direct left/right
// children = level 2, etc.), plus contractRegId, userAddress, sponsor
// address, upline address, highest package, and total income earned.
//
// Unlike DirectIncome/GenerationIncome (which have a `level` column we
// can filter on directly in SQL), GenerationTree has no level column —
// level is purely structural (depth from the root in the binary tree).
// So filtering by level can't be pushed into a WHERE clause the way
// package filtering can; it requires walking the tree first to compute
// each node's level, THEN filtering/paginating in application code.
// Page/limit/search/package/level/sort are all still applied server-side —
// nothing in this endpoint sends the full member list to the client;
// only the requested page after all filters are resolved.

import { Request, Response } from "express";
import { prisma } from "..";

interface TeamMemberNode {
  userId:        string;
  userAddress:   string;
  level:         number;
  uplineAddress: string;
}

// ─── BFS walk that records each descendant's level + upline address ─────────
async function walkGenerationTree(rootUserId: string): Promise<TeamMemberNode[]> {
  const allNodes = await prisma.generationTree.findMany({
    select: {
      uplineUserId:      true,
      leftUserId:        true,
      leftChildAddress:  true,
      rightUserId:       true,
      rightChildAddress: true,
      uplineUser: {
        select: {
          userAddress:true
        },
      },
    },
  });

  const childMap = new Map<string, { userId: string; userAddress: string; uplineAddress: string }[]>();
  for (const node of allNodes) {
    const uplineAddress = node.uplineUser?.userAddress;
    const children: { userId: string; userAddress: string; uplineAddress: string }[] = [];
    if (node.leftUserId && node.leftChildAddress) {
      children.push({ userId: node.leftUserId, userAddress: node.leftChildAddress, uplineAddress });
    }
    if (node.rightUserId && node.rightChildAddress) {
      children.push({ userId: node.rightUserId, userAddress: node.rightChildAddress, uplineAddress });
    }
    if (children.length > 0) childMap.set(node.uplineUserId, children);
  }

  const result: TeamMemberNode[] = [];
  const seen = new Set<string>([rootUserId]);

  let queue: { userId: string; userAddress: string; uplineAddress: string; level: number }[] =
    (childMap.get(rootUserId) ?? []).map(c => ({
      userId:        c.userId,
      userAddress:   c.userAddress,
      uplineAddress: c.uplineAddress,
      level:         1,
    }));

  while (queue.length > 0) {
    const { userId, userAddress, uplineAddress, level } = queue.shift()!;
    if (seen.has(userId)) continue;
    seen.add(userId);

    result.push({ userId, userAddress, level, uplineAddress });

    const children = childMap.get(userId) ?? [];
    for (const child of children) {
      if (!seen.has(child.userId)) {
        queue.push({
          userId:        child.userId,
          userAddress:   child.userAddress,
          uplineAddress: child.uplineAddress,
          level:         level + 1,
        });
      }
    }
  }

  return result;
}

// ─── GET /api/dashboard/generation-team ───────────────────
export const getGenerationTeam = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;

    const page        = Math.max(1, parseInt(req.query.page  as string) || 1);
    const pageSize    = Math.min(50, parseInt(req.query.limit as string) || 10);
    const search      = (req.query.search as string ?? '').toLowerCase().trim();
    const pkgFilter   = parseInt(req.query.package as string) || 0;
    const levelFilter = req.query.level !== undefined && req.query.level !== ''
      ? parseInt(req.query.level as string)
      : undefined;

    // Sort params — validated below in the switch (unknown keys fall back to default).
    const sortKey = (req.query.sortKey as string) || 'generationLevel';
    const sortDir: 'asc' | 'desc' = req.query.sortDir === 'desc' ? 'desc' : 'asc';

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
        id:                            true,
        userAddress:                   true,
        contractRegId:                 true,
        futureRideId:                  true,
        referalAddress:                true,
        isRegistered:                  true,
        createdAt:                     true,
        contractRegistrationTimestamp: true,
        packages: {
          orderBy: { packageNumber: 'desc' },
          take:    1,
          select:  { packageNumber: true, packageName: true },
        },
      },
    });

    const levelById  = new Map(levelFiltered.map(m => [m.userId, m.level]));
    const uplineById = new Map(levelFiltered.map(m => [m.userId, m.uplineAddress]));

    // ── 4. per-member income breakdown (direct + generation + laps + royalty) ──
    // Same approach as DirectTeamPage's backend: each income table is
    // keyed by userId = WHO RECEIVED that income, so this is "how much
    // has this team member earned in total," not income generated for
    // the viewer. Only queries for the users actually matched above
    // (post search/package filter), not the whole tree.
    //
    // royaltyIncome is summed separately — its amount field is
    // `amountClaim`, a genuine Float, not a decimal String like the
    // other three tables, so it can't go through the same string-parsing
    // accumulator.
    const userIds = users.map(u => u.id);
    const [directRows, genRows, lapsRows, royaltyRows] = await Promise.all([
      prisma.directIncome.findMany({
        where:  { userId: { in: userIds } },
        select: { userId: true, amount: true },
      }),
      prisma.generationIncome.findMany({
        where:  { userId: { in: userIds } },
        select: { userId: true, amount: true },
      }),
      prisma.lapsIncome.findMany({
        where:  { userId: { in: userIds } },
        select: { userId: true, amount: true },
      }),
      prisma.royaltyIncome.findMany({
        where:  { userId: { in: userIds } },
        select: { userId: true, amountClaim: true },
      }),
    ]);

    const directByUserId     = groupSumByUserId(directRows);
    const generationByUserId = groupSumByUserId(genRows);
    const lapsByUserId       = groupSumByUserId(lapsRows);
    const royaltyByUserId    = groupSumByUserIdFloat(royaltyRows);

    // ── 5. merge level + upline + income info ──
    const merged = users.map(u => {
      const directIncome     = directByUserId.get(u.id)     ?? 0;
      const generationIncome = generationByUserId.get(u.id) ?? 0;
      const lapsIncome       = lapsByUserId.get(u.id)       ?? 0;
      const royaltyIncome    = royaltyByUserId.get(u.id)    ?? 0;

      return {
        id:              u.id,
        userAddress:     u.userAddress,
        contractRegId:   u.futureRideId,
        referralAddress: u.referalAddress,
        uplineAddress:   uplineById.get(u.id) ?? '',
        isRegistered:    u.isRegistered,
        joinedAt:        u.contractRegistrationTimestamp
                           ? new Date(Number(u.contractRegistrationTimestamp) * 1000).toISOString()
                           : null,
        generationLevel: levelById.get(u.id) ?? 0,
        highestPackage:  u.packages[0]?.packageNumber ?? 0,
        packageName:     u.packages[0]?.packageName   ?? 'None',

        directIncome,
        generationIncome,
        lapsIncome,
        royaltyIncome,
        totalIncome: directIncome + generationIncome + lapsIncome + royaltyIncome,
      };
    });

    // ── 6. sort by requested column ──
    const dir = sortDir === 'asc' ? 1 : -1;
    merged.sort((a, b) => {
      switch (sortKey) {
        case 'generationLevel':
          return (a.generationLevel - b.generationLevel) * dir
            || (b.joinedAt ?? '').localeCompare(a.joinedAt ?? ''); // tiebreak: newest first
        case 'highestPackage':
          return (a.highestPackage - b.highestPackage) * dir;
        case 'totalIncome':
          return (a.totalIncome - b.totalIncome) * dir;
        case 'contractRegId':
          return (Number(a.contractRegId ?? 0) - Number(b.contractRegId ?? 0)) * dir;
        case 'joinedAt':
          return ((a.joinedAt ?? '').localeCompare(b.joinedAt ?? '')) * dir;
        default:
          // unknown key → default ordering
          return (a.generationLevel - b.generationLevel)
            || (b.joinedAt ?? '').localeCompare(a.joinedAt ?? '');
      }
    });

    // ── 7. paginate ──
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

// ─── grouping helpers (shared with direct-team controller) ─
function groupSumByUserId(rows: { userId: string; amount: string }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const current = map.get(row.userId) ?? 0;
    map.set(row.userId, current + parseFloat(row.amount ?? '0'));
  }
  return map;
}

function groupSumByUserIdFloat(rows: { userId: string; amountClaim: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const current = map.get(row.userId) ?? 0;
    map.set(row.userId, current + (row.amountClaim ?? 0));
  }
  return map;
}