// src/controllers/income.controller.ts
import { Request, Response } from 'express';
import { prisma } from '..';

// ─── GET /api/income/direct ───────────────────────────────
export const getDirectIncome = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, parseInt(req.query.limit as string) || 15);
    const skip = (page - 1) * pageSize;
    const search = (req.query.search as string ?? '').toLowerCase().trim();
    const pkgFilter = parseInt(req.query.package as string) || 0;

    const where: any = {
      userId: dbUser.id,
      ...(search ? { fromUserAddress: { contains: search, mode: 'insensitive' } } : {}),
      ...(pkgFilter > 0 ? { packageNumber: pkgFilter } : {}),
    };

    const [records, total] = await Promise.all([
      prisma.directIncome.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          fromUserAddress: true,
          packageNumber: true,
          packageName: true,
          amount: true,
          timestamp: true,
          transactionHash: true,
          createdAt: true,
        },
      }),
      prisma.directIncome.count({ where }),
    ]);

    // ── "User Id" = the SENDER's registered contractRegId ──
    const senderAddresses = records.map(r => r.fromUserAddress);
    const senders = await prisma.user.findMany({
      where: { userAddress: { in: senderAddresses } },
      select: { userAddress: true, futureRideId: true },
    });
    const regIdByAddress = new Map(senders.map(s => [s.userAddress, s.futureRideId]));

    const rows = records.map(r => ({
      id: r.id,
      contractRegId: regIdByAddress.get(r.fromUserAddress) ?? null,
      fromUserAddress: r.fromUserAddress,
      packageNumber: r.packageNumber,
      packageName: r.packageName,
      amount: parseFloat(r.amount ?? '0'),
      creditedAt: r.createdAt.toISOString(),
      transactionHash: r.transactionHash,
    }));

    res.status(200).json({
      success: true,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      records: rows,
    });
  } catch (error: any) {
    console.error('getDirectIncome error:', error.message);
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

export const getGenerationIncome = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, parseInt(req.query.limit as string) || 15);
    const skip = (page - 1) * pageSize;
    const search = (req.query.search as string ?? '').toLowerCase().trim();
    const pkgFilter = parseInt(req.query.package as string) || 0;
    const levelFilter = req.query.level !== undefined && req.query.level !== ''
      ? parseInt(req.query.level as string)
      : undefined;

    const where: any = {
      userId: dbUser.id,
      ...(search ? { fromUserAddress: { contains: search, mode: 'insensitive' } } : {}),
      ...(pkgFilter > 0 ? { packageNumber: pkgFilter } : {}),
      ...(levelFilter !== undefined ? { level: levelFilter } : {}),
    };

    const [records, total] = await Promise.all([
      prisma.generationIncome.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          fromUserAddress: true,
          packageNumber: true,
          packageName: true,
          amount: true,
          timestamp: true,
          transactionHash: true,
          level: true,
          createdAt: true,
        },
      }),
      prisma.generationIncome.count({ where }),
    ]);

    // ── "User Id" = the SENDER's registered contractRegId ──
    const senderAddresses = records.map(r => r.fromUserAddress);
    const senders = await prisma.user.findMany({
      where: { userAddress: { in: senderAddresses } },
      select: { userAddress: true, futureRideId: true },
    });
    const regIdByAddress = new Map(senders.map(s => [s.userAddress, s.futureRideId]));

    const rows = records.map(r => ({
      id: r.id,
      contractRegId: regIdByAddress.get(r.fromUserAddress) ?? null,
      fromUserAddress: r.fromUserAddress,
      packageNumber: r.packageNumber,
      packageName: r.packageName,
      amount: parseFloat(r.amount ?? '0'),
      level: r.level,
      creditedAt: r.createdAt.toISOString(),
      transactionHash: r.transactionHash,
    }));

    res.status(200).json({
      success: true,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      records: rows,
    });
  } catch (error: any) {
    console.error('getGenerationIncome error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ─── GET /api/income/laps ─────────────────────────────────
export const getLapsIncome = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, parseInt(req.query.limit as string) || 15);
    const skip = (page - 1) * pageSize;
    const search = (req.query.search as string ?? '').toLowerCase().trim();
    const pkgFilter = parseInt(req.query.package as string) || 0;

    const where: any = {
      userId: dbUser.id,
      ...(search ? { fromUserAddress: { contains: search, mode: 'insensitive' } } : {}),
      ...(pkgFilter > 0 ? { packageNumber: pkgFilter } : {}),
    };

    const [records, total] = await Promise.all([
      prisma.lapsIncome.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          fromUserAddress: true,
          packageNumber: true,
          packageName: true,
          amount: true,
          timestamp: true,
          transactionHash: true,
          createdAt: true,
          level: true
        },
      }),
      prisma.lapsIncome.count({ where }),
    ]);

    // ── "User Id" = the lapsed sender's registered contractRegId ──
    const senderAddresses = records.map(r => r.fromUserAddress);
    const senders = await prisma.user.findMany({
      where: { userAddress: { in: senderAddresses } },
      select: { userAddress: true, futureRideId: true },
    });
    const regIdByAddress = new Map(senders.map(s => [s.userAddress, s.futureRideId]));

    const rows = records.map(r => ({
      id: r.id,
      contractRegId: regIdByAddress.get(r.fromUserAddress) ?? null,
      fromUserAddress: r.fromUserAddress,
      packageNumber: r.packageNumber,
      packageName: r.packageName,
      amount: parseFloat(r.amount ?? '0'),
      creditedAt: r.createdAt.toISOString(),
      level: r.level,
      transactionHash: r.transactionHash,
    }));

    res.status(200).json({
      success: true,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      records: rows,
    });
  } catch (error: any) {
    console.error('getLapsIncome error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};



function getPagination(query: Record<string, any>) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const pageSize = [10, 25, 50, 100].includes(parseInt(query.limit))
    ? parseInt(query.limit) : 10;
  const skip = (page - 1) * pageSize;
  const search = (query.search ?? '').toLowerCase().trim();
  const pkgFilter = parseInt(query.package) || 0;
  // level filter — undefined means "all levels"
  const levelFilter = query.level !== undefined && query.level !== ''
    ? parseInt(query.level)
    : undefined;
  return { page, pageSize, skip, search, pkgFilter, levelFilter };
}


export const getDirectIncomeTable = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;
    const { page, pageSize, skip, search, pkgFilter } = getPagination(req.query);

    const where: any = {
      userId: dbUser.id,
      ...(search ? { fromUserAddress: { contains: search, mode: 'insensitive' as const } } : {}),
      ...(pkgFilter ? { packageNumber: pkgFilter } : {}),
    };

    const [records, total] = await Promise.all([
      prisma.directIncome.findMany({
        where, skip, take: pageSize,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, fromUserAddress: true, packageNumber: true,
          packageName: true, amount: true, timestamp: true,
          transactionHash: true, createdAt: true,
        },
      }),
      prisma.directIncome.count({ where }),
    ]);

    res.json({ success: true, total, page, pageSize, totalPages: Math.ceil(total / pageSize), records });
  } catch (e: any) {
    console.error('direct income error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export const getGenerationIncomeTable = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;
    const { page, pageSize, skip, search, pkgFilter, levelFilter } = getPagination(req.query);

    const where: any = {
      userId: dbUser.id,
      ...(search ? { fromUserAddress: { contains: search, mode: 'insensitive' as const } } : {}),
      ...(pkgFilter ? { packageNumber: pkgFilter } : {}),
      // level filter — exact match on the lvlpay tree level
      ...(levelFilter !== undefined ? { level: levelFilter } : {}),
    };

    const [records, total] = await Promise.all([
      prisma.generationIncome.findMany({
        where, skip, take: pageSize,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, fromUserAddress: true, packageNumber: true,
          packageName: true, amount: true, timestamp: true,
          transactionHash: true, level: true, createdAt: true,
        },
      }),
      prisma.generationIncome.count({ where }),
    ]);

    res.json({ success: true, total, page, pageSize, totalPages: Math.ceil(total / pageSize), records });
  } catch (e: any) {
    console.error('generation income error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── GET /api/income/lost ──────────────────────────────────
export const getLostIncome = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, parseInt(req.query.limit as string) || 15);
    const skip = (page - 1) * pageSize;
    const search = (req.query.search as string ?? '').toLowerCase().trim();
    const pkgFilter = parseInt(req.query.package as string) || 0;

    const where: any = {
      userId: dbUser.id,
      ...(search ? { lapsedAddress: { contains: search, mode: 'insensitive' } } : {}),
      ...(pkgFilter > 0 ? { packageNumber: pkgFilter } : {}),
    };

    const [records, total] = await Promise.all([
      prisma.lostIncome.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          lapsedAddress: true,
          redirectedToAddress: true,
          packageNumber: true,
          packageName: true,
          amount: true,
          level: true,
          timestamp: true,
          transactionHash: true,
          createdAt: true,
        },
      }),
      prisma.lostIncome.count({ where }),
    ]);

    // ── "User Id" = the LAPSED party's registered contractRegId ──
    // i.e. whose downline payout lapsed away from this user.
    const lapsedAddresses = records.map(r => r.lapsedAddress);
    const lapsedUsers = await prisma.user.findMany({
      where: { userAddress: { in: lapsedAddresses } },
      select: { userAddress: true, contractRegId: true },
    });
    const regIdByAddress = new Map(lapsedUsers.map(u => [u.userAddress, u.contractRegId]));

    const rows = records.map(r => ({
      id: r.id,
      contractRegId: regIdByAddress.get(r.lapsedAddress) ?? null,
      lapsedAddress: r.lapsedAddress,
      redirectedToAddress: r.redirectedToAddress,
      packageNumber: r.packageNumber,
      packageName: r.packageName,
      amount: parseFloat(r.amount ?? '0'),
      level: r.level,
      missedAt: r.createdAt.toISOString(),
      transactionHash: r.transactionHash,
    }));

    res.status(200).json({
      success: true,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      records: rows,
    });
  } catch (error: any) {
    console.error('getLostIncome error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};