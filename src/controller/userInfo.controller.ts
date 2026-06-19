import { Request, Response } from "express";
import { prisma } from "..";

// ─── community counter (BFS) ──────────────────────────────
async function countCommunity(rootUserId: string): Promise<number> {
  const allNodes = await prisma.generationTree.findMany({
    select: { uplineUserId: true, leftUserId: true, rightUserId: true },
  });

  const childMap = new Map<string, string[]>();
  for (const node of allNodes) {
    const children: string[] = [];
    if (node.leftUserId)  children.push(node.leftUserId);
    if (node.rightUserId) children.push(node.rightUserId);
    if (children.length > 0) childMap.set(node.uplineUserId, children);
  }

  let count = 0;
  const queue = [rootUserId];
  const seen  = new Set<string>([rootUserId]);
  while (queue.length > 0) {
    const current  = queue.shift()!;
    const children = childMap.get(current) ?? [];
    for (const child of children) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
        count++;
      }
    }
  }
  return count;
}

// ─── sum helper — amount stored as String in DB ───────────
function sumAmount(records: { amount: string }[]): number {
  return records.reduce((acc, r) => acc + parseFloat(r.amount ?? '0'), 0);
}

// ─── weekly income builder ────────────────────────────────
// timestamp in DirectIncome/GenerationIncome/LapsIncome is stored as String
// timestamp in UpgradeHolding is stored as Int
// We filter UpgradeHolding by Int timestamp, others we filter in JS after fetching
async function buildWeeklyIncome(userId: string, now: Date) {
  // fetch ALL income records for this user once — then bucket per week in JS
  // avoids 32 DB queries (8 weeks × 4 income types)
  const [directRecs, genRecs, lapsRecs, upgradeRecs] = await Promise.all([
    prisma.directIncome.findMany({
      where:  { userId },
      select: { amount: true, timestamp: true },
    }),
    prisma.generationIncome.findMany({
      where:  { userId },
      select: { amount: true, timestamp: true },
    }),
    prisma.lapsIncome.findMany({
      where:  { userId },
      select: { amount: true, timestamp: true },
    }),
    prisma.upgradeHolding.findMany({
      where:  { userId },
      select: { amount: true, timestamp: true }, // timestamp is Int here
    }),
  ]);

  const weeks = [];

  for (let i = 7; i >= 0; i--) {
    const weekStart = new Date(now);
    const day = weekStart.getDay();
    const diffToMonday = (day === 0 ? -6 : 1 - day) - i * 7;
    weekStart.setDate(weekStart.getDate() + diffToMonday);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const tsFrom = Math.floor(weekStart.getTime() / 1000);
    const tsTo   = Math.floor(weekEnd.getTime()   / 1000);

    // income models store timestamp as String — parse to Int for comparison
    const inRange = (ts: string) => {
      const n = parseInt(ts ?? '0');
      return n >= tsFrom && n <= tsTo;
    };

    // upgradeHolding stores timestamp as Int directly
    const upgradeInRange = (ts: number) => ts >= tsFrom && ts <= tsTo;

    const month     = weekStart.toLocaleString('default', { month: 'short' });
    const dateRange = `${month} ${weekStart.getDate()}–${weekEnd.getDate()}`;

    weeks.push({
      week:       `W${8 - i}`,
      dateRange,
      isCurrent:  i === 0,
      direct:     sumAmount(directRecs.filter(r => inRange(r.timestamp))),
      generation: sumAmount(genRecs.filter(r => inRange(r.timestamp))),
      laps:       sumAmount(lapsRecs.filter(r => inRange(r.timestamp))),
      upgrade:    sumAmount(
        upgradeRecs
          .filter(r => upgradeInRange(r.timestamp))
          .map(r => ({ amount: r.amount }))
      ),
    });
  }

  return weeks;
}

// ─── today's income builder ───────────────────────────────
// Same timestamp-type quirk as buildWeeklyIncome: direct/generation/laps
// store timestamp as String, upgradeHolding stores it as Int. Reuses the
// same fetch-all-then-filter-in-JS approach rather than adding 4 more
// per-request DB queries with range filters.
async function buildTodaysIncome(userId: string, now: Date): Promise<number> {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(now);
  dayEnd.setHours(23, 59, 59, 999);

  const tsFrom = Math.floor(dayStart.getTime() / 1000);
  const tsTo   = Math.floor(dayEnd.getTime()   / 1000);

  const inRange = (ts: string) => {
    const n = parseInt(ts ?? '0');
    return n >= tsFrom && n <= tsTo;
  };
  const upgradeInRange = (ts: number) => ts >= tsFrom && ts <= tsTo;

  const [directRecs, genRecs, lapsRecs, upgradeRecs] = await Promise.all([
    prisma.directIncome.findMany({
      where:  { userId },
      select: { amount: true, timestamp: true },
    }),
    prisma.generationIncome.findMany({
      where:  { userId },
      select: { amount: true, timestamp: true },
    }),
    prisma.lapsIncome.findMany({
      where:  { userId },
      select: { amount: true, timestamp: true },
    }),
    prisma.upgradeHolding.findMany({
      where:  { userId },
      select: { amount: true, timestamp: true }, // timestamp is Int here
    }),
  ]);

  const todaysDirect     = sumAmount(directRecs.filter(r => inRange(r.timestamp)));
  const todaysGeneration = sumAmount(genRecs.filter(r => inRange(r.timestamp)));
  const todaysLaps       = sumAmount(lapsRecs.filter(r => inRange(r.timestamp)));
  const todaysUpgrade    = sumAmount(
    upgradeRecs
      .filter(r => upgradeInRange(r.timestamp))
      .map(r => ({ amount: r.amount }))
  );

  return todaysDirect + todaysGeneration + todaysLaps + todaysUpgrade;
}

// ─── GET /api/dashboard/me ────────────────────────────────
export const getMe = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;

    // ── 1. highest package ────────────────────────────────
    const highestPkg = await prisma.package.findFirst({
      where:   { userId: dbUser.id },
      orderBy: { packageNumber: 'desc' },
      select:  { packageNumber: true, createdAt: true },
    });

    // ── 2. direct team count ──────────────────────────────
    const directTeamCount = await prisma.user.count({
      where: { referalAddress: dbUser.userAddress, isRegistered: true },
    });

    // ── 3. total community ────────────────────────────────
    const communityCount = await countCommunity(dbUser.id);

    // ── 4. referral link ──────────────────────────────────
    const baseUrl      = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    const referralLink = `${baseUrl}/registration?ref=${dbUser.contractRegId ?? ''}`;

    // ── 5. sponsor ────────────────────────────────────────
    const referredBy =
      dbUser.referalAddress === dbUser.userAddress ? null : dbUser.referalAddress;

    // ── 6. income totals ──────────────────────────────────
    // All income models use userId relation — no toAddress field in schema
    // timestamp is String in direct/gen/laps, Int in upgradeHolding
    // LostIncome also uses userId relation, amount stored as String like the others
    const [directRecs, genRecs, lapsRecs, upgradeRecs, lostRecs] = await Promise.all([
      prisma.directIncome.findMany({
        where:  { userId: dbUser.id },
        select: { amount: true },
      }),
      prisma.generationIncome.findMany({
        where:  { userId: dbUser.id },
        select: { amount: true },
      }),
      prisma.lapsIncome.findMany({
        where:  { userId: dbUser.id },
        select: { amount: true },
      }),
      prisma.upgradeHolding.findMany({
        where:  { userId: dbUser.id },
        select: { amount: true },
      }),
      prisma.lostIncome.findMany({
        where:  { userId: dbUser.id },
        select: { amount: true },
      }),
    ]);

    const directIncome         = sumAmount(directRecs);
    const generationIncome     = sumAmount(genRecs);
    const lapsIncome           = sumAmount(lapsRecs);
    const upgradeHoldingIncome = sumAmount(upgradeRecs);
    const lostIncome           = sumAmount(lostRecs);
    // NOTE: lostIncome is intentionally NOT added into totalIncome — it
    // represents income the user MISSED OUT on (redirected elsewhere due
    // to a laps event), not income actually received. Including it in
    // the total would overstate what the user actually earned.
    const totalIncome          = directIncome + generationIncome + lapsIncome + upgradeHoldingIncome;

    // ── 7. today's income ─────────────────────────────────
    const todaysIncome = await buildTodaysIncome(dbUser.id, new Date());

    // ── 8. weekly chart data ──────────────────────────────
    const weeklyData = await buildWeeklyIncome(dbUser.id, new Date());

    res.status(200).json({
      success: true,

      // account card
      highestPackage:      highestPkg?.packageNumber ?? 0,
      packagePurchaseDate: highestPkg?.createdAt?.toISOString() ?? new Date().toISOString(),
      referredBy,
      referralLink,
      directTeamCount,
      totalCommunityTeam:  communityCount,

      // identity
      userAddress:       dbUser.userAddress,
      contractRegId:     dbUser.contractRegId,
      isRegistered:      dbUser.isRegistered,
      walletFundBalance: 0,

      // income
      directIncome,
      generationIncome,
      lapsIncome,
      upgradeHoldingIncome,
      lostIncome,
      totalIncome,
      todaysIncome,

      // chart
      weeklyData,
    });

  } catch (error: any) {
    console.error('getMe error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ─── GET /api/dashboard/direct-team ──────────────────────
export const getDirectTeam = async (req: Request, res: Response) => {
  try {
    const dbUser    = (req as any).dbUser;
    const page      = Math.max(1, parseInt(req.query.page  as string) || 1);
    const pageSize  = Math.min(50, parseInt(req.query.limit as string) || 15);
    const skip      = (page - 1) * pageSize;
    const search    = (req.query.search  as string ?? '').toLowerCase().trim();
    const pkgFilter = parseInt(req.query.package as string) || 0;

    const where: any = {
      referalAddress: dbUser.userAddress,
      isRegistered:   true,
      ...(search ? { userAddress: { contains: search, mode: 'insensitive' } } : {}),
    };

    if (pkgFilter > 0) {
      where.packages = { some: { packageNumber: pkgFilter } };
    }

    const [members, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take:    pageSize,
        orderBy: { createdAt: 'desc' },
        select: {
          id:            true,
          userAddress:   true,
          contractRegId: true,
          isRegistered:  true,
          createdAt:     true,
          packages: {
            orderBy: { packageNumber: 'desc' },
            take:    1,
            select:  { packageNumber: true, packageName: true },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    const memberAddresses = members.map(m => m.userAddress);
    const subCounts = await prisma.user.groupBy({
      by:     ['referalAddress'],
      where:  { referalAddress: { in: memberAddresses }, isRegistered: true },
      _count: { _all: true },
    });
    const subMap = new Map(subCounts.map(r => [r.referalAddress, r._count._all]));

    const rows = members.map((m, idx) => ({
      id:             m.id,
      rank:           skip + idx + 1,
      userAddress:    m.userAddress,
      contractRegId:  m.contractRegId,
      isRegistered:   m.isRegistered,
      joinedAt:       m.createdAt.toISOString(),
      highestPackage: m.packages[0]?.packageNumber ?? 0,
      packageName:    m.packages[0]?.packageName   ?? 'None',
      directTeam:     subMap.get(m.userAddress)    ?? 0,
    }));

    res.json({
      success:    true,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      members:    rows,
    });

  } catch (error: any) {
    console.error('direct-team error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};