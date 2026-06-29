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


// ─── weekly income builder ────────────────────────────────
// timestamp in DirectIncome/GenerationIncome/LapsIncome is stored as String
// timestamp in UpgradeHolding is stored as Int
async function buildWeeklyIncome(userId: string, now: Date) {
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
      select: { amount: true, timestamp: true },
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

    const inRange = (ts: string) => {
      const n = parseInt(ts ?? '0');
      return n >= tsFrom && n <= tsTo;
    };

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
// Now returns a per-type breakdown (not just a single total) since the
// dashboard UI needs today's split across direct/generation/laps/upgrade/lost.
async function buildTodaysIncome(userId: string, now: Date) {
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

  const [directRecs, genRecs, lapsRecs, upgradeRecs, lostRecs] = await Promise.all([
    prisma.directIncome.findMany({ where: { userId }, select: { amount: true, timestamp: true } }),
    prisma.generationIncome.findMany({ where: { userId }, select: { amount: true, timestamp: true } }),
    prisma.lapsIncome.findMany({ where: { userId }, select: { amount: true, timestamp: true } }),
    prisma.upgradeHolding.findMany({ where: { userId }, select: { amount: true, timestamp: true } }),
    prisma.lostIncome.findMany({ where: { userId }, select: { amount: true, timestamp: true } }),
  ]);

  const direct     = sumAmount(directRecs.filter(r => inRange(r.timestamp)));
  const generation = sumAmount(genRecs.filter(r => inRange(r.timestamp)));
  const laps        = sumAmount(lapsRecs.filter(r => inRange(r.timestamp)));
  const upgrade     = sumAmount(
    upgradeRecs.filter(r => upgradeInRange(r.timestamp)).map(r => ({ amount: r.amount }))
  );

  return {
    total: direct + generation + laps + upgrade, // lost intentionally excluded — money missed, not received
    distribution: { direct, generation, laps, upgrade },
  };
}

// ─── GET /api/dashboard/me ────────────────────────────────
// DB-only — no blockchain calls here. walletFundBalance and
// upgradeHoldingIncome (the on-chain ones) moved OUT to their own
// endpoint (getOnChainBalances below) so a slow/rate-limited RPC never
// blocks this — the fast, frequently-needed dashboard data.
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
    const referralLink = `${baseUrl}/registration?ref=${dbUser.futureRideId ?? ''}`;

    // ── 5. sponsor ────────────────────────────────────────
    const referredBy =
      dbUser.referalAddress === dbUser.userAddress ? null : dbUser.referalAddress;

    // sponsor's own contractRegId — referredBy above is just an address;
    // displaying "Referral ID" on the dashboard needs the sponsor's
    // registered ID, which requires a separate lookup since dbUser only
    // carries the CALLER's own contractRegId, not their sponsor's.
    let referredByContractRegId: string | null = null;
    if (referredBy) {
      const sponsor = await prisma.user.findUnique({
        where:  { userAddress: referredBy },
        select: { futureRideId: true },
      });
      referredByContractRegId = sponsor?.futureRideId ?? null;
    }

    // ── 6. income totals (DB only) ────────────────────────
    const [directRecs, genRecs, lapsRecs, lostRecs] = await Promise.all([
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
      prisma.lostIncome.findMany({
        where:  { userId: dbUser.id },
        select: { amount: true },
      }),
    ]);

    const directIncome     = sumAmount(directRecs);
    const generationIncome = sumAmount(genRecs);
    const lapsIncome       = sumAmount(lapsRecs);
    const lostIncome       = sumAmount(lostRecs);
    // totalIncome here is DB-only (direct + generation + laps).
    // upgradeHoldingIncome is added on the FRONTEND once the separate
    // on-chain endpoint resolves — see DashboardHomePage's totalIncome
    // computation. lostIncome intentionally excluded (money missed, not received).
    const totalIncome = directIncome + generationIncome + lapsIncome;

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
      referredByContractRegId,
      referralLink,
      directTeamCount,
      totalCommunityTeam:  communityCount,

      // identity
      userAddress:       dbUser.userAddress,
      contractRegId:     dbUser.futureRideId,
      isRegistered:      dbUser.isRegistered,

      // income (DB-derived, fast)
      directIncome,
      generationIncome,
      lapsIncome,
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

// ─── sum helper — amount stored as String in DB ───────────
function sumAmount(records: { amount: string }[]): number {
  return records.reduce((acc, r) => acc + parseFloat(r.amount ?? '0'), 0);
}

// ─── GET /api/dashboard/direct-team ──────────────────────
// ─── GET /api/dashboard/direct-team ──────────────────────
export const getDirectTeam = async (req: Request, res: Response) => {
  try {
    const dbUser    = (req as any).dbUser;
    const page      = Math.max(1, parseInt(req.query.page  as string) || 1);
    const pageSize  = Math.min(500, parseInt(req.query.limit as string) || 15);
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
          futureRideId:true,
          contractRegistrationTimestamp:true,
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
    const memberIds        = members.map(m => m.id);

    const subCounts = await prisma.user.groupBy({
      by:     ['referalAddress'],
      where:  { referalAddress: { in: memberAddresses }, isRegistered: true },
      _count: { _all: true },
    });
    const subMap = new Map(subCounts.map(r => [r.referalAddress, r._count._all]));

    // ── per-member income breakdown (direct, generation, laps, royalty) ──
    // Each income table is keyed by userId = WHO RECEIVED that income —
    // so this is "how much has this team member earned in total on the
    // platform," not income they generated for the viewer.
    //
    // direct/generation/laps store `amount` as a decimal STRING (e.g. "5.0"),
    // not wei — groupBy's _sum can't aggregate non-numeric Decimal/String
    // columns the way it does for Int/Float, so we fetch raw rows and sum
    // in JS, same pattern as buildWeeklyIncome.
    //
    // royaltyIncome is DIFFERENT: its amount field is `amountClaim`, a
    // genuine Float (not a String), so it's summed separately rather than
    // going through the shared sumAmount() string-parsing helper.
    const [directRows, genRows, lapsRows, royaltyRows] = await Promise.all([
      prisma.directIncome.findMany({
        where:  { userId: { in: memberIds } },
        select: { userId: true, amount: true },
      }),
      prisma.generationIncome.findMany({
        where:  { userId: { in: memberIds } },
        select: { userId: true, amount: true },
      }),
      prisma.lapsIncome.findMany({
        where:  { userId: { in: memberIds } },
        select: { userId: true, amount: true },
      }),
      prisma.royaltyIncome.findMany({
        where:  { userId: { in: memberIds } },
        select: { userId: true, amountClaim: true },
      }),
    ]);

    const directByUserId     = groupSumByUserId(directRows);
    const generationByUserId = groupSumByUserId(genRows);
    const lapsByUserId       = groupSumByUserId(lapsRows);
    const royaltyByUserId    = groupSumByUserIdFloat(royaltyRows);

    const rows = members.map((m, idx) => {
      const directIncome     = directByUserId.get(m.id)     ?? 0;
      const generationIncome = generationByUserId.get(m.id) ?? 0;
      const lapsIncome       = lapsByUserId.get(m.id)        ?? 0;
      const royaltyIncome    = royaltyByUserId.get(m.id)     ?? 0;

      return {
        id:               m.id,
        rank:             skip + idx + 1,
        userAddress:      m.userAddress,
        contractRegId:    m.futureRideId,
        isRegistered:     m.isRegistered,
        joinedAt:         m.contractRegistrationTimestamp
                            ? new Date(Number(m.contractRegistrationTimestamp) * 1000).toISOString()
                            : null,
        highestPackage:   m.packages[0]?.packageNumber ?? 0,
        packageName:      m.packages[0]?.packageName   ?? 'None',
        directTeam:       subMap.get(m.userAddress)     ?? 0,

        // income breakdown
        directIncome,
        generationIncome,
        lapsIncome,
        royaltyIncome,
        totalIncome: directIncome + generationIncome + lapsIncome + royaltyIncome,
      };
    });

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

// ─── grouping helpers ──────────────────────────────────────
// amount stored as decimal String (direct/generation/laps income tables)
function groupSumByUserId(rows: { userId: string; amount: string }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const current = map.get(row.userId) ?? 0;
    map.set(row.userId, current + parseFloat(row.amount ?? '0'));
  }
  return map;
}

// amountClaim stored as a genuine Float (royaltyIncome only)
function groupSumByUserIdFloat(rows: { userId: string; amountClaim: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const current = map.get(row.userId) ?? 0;
    map.set(row.userId, current + (row.amountClaim ?? 0));
  }
  return map;
}