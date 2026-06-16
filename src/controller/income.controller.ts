// src/controllers/income.controller.ts
import { Request, Response } from 'express';
import { prisma } from '..';

// ─── GET /api/income/direct ───────────────────────────────
export const getDirectIncome = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;

    const records = await prisma.directIncome.findMany({
      where:   { userId: dbUser.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id:              true,
        fromUserAddress: true,
        packageNumber:   true,
        packageName:     true,
        amount:          true,
        timestamp:       true,
        transactionHash: true,
      },
    });

    res.status(200).json({ success: true, records });
  } catch (error: any) {
    console.error('getDirectIncome error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ─── GET /api/income/generation ───────────────────────────
export const getGenerationIncome = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;

    const records = await prisma.generationIncome.findMany({
      where:   { userId: dbUser.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id:              true,
        fromUserAddress: true,
        packageNumber:   true,
        packageName:     true,
        amount:          true,
        timestamp:       true,
        transactionHash: true,
        level:           true,
      },
    });

    res.status(200).json({ success: true, records });
  } catch (error: any) {
    console.error('getGenerationIncome error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ─── GET /api/income/laps ─────────────────────────────────
export const getLapsIncome = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;

    const records = await prisma.lapsIncome.findMany({
      where:   { userId: dbUser.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id:              true,
        fromUserAddress: true,
        packageNumber:   true,
        packageName:     true,
        amount:          true,
        timestamp:       true,
        transactionHash: true,
        level:           true,
      },
    });

    res.status(200).json({ success: true, records });
  } catch (error: any) {
    console.error('getLapsIncome error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};



function getPagination(query: Record<string, any>) {
  const page      = Math.max(1, parseInt(query.page)  || 1);
  const pageSize  = [10, 25, 50, 100].includes(parseInt(query.limit))
    ? parseInt(query.limit) : 10;
  const skip      = (page - 1) * pageSize;
  const search    = (query.search ?? '').toLowerCase().trim();
  const pkgFilter = parseInt(query.package) || 0;
  // level filter — undefined means "all levels"
  const levelFilter = query.level !== undefined && query.level !== ''
    ? parseInt(query.level)
    : undefined;
  return { page, pageSize, skip, search, pkgFilter, levelFilter };
}
 

export const getDirectIncomeTable = async(req:Request,res:Response)=>{
try {
    const dbUser = (req as any).dbUser;
    const { page, pageSize, skip, search, pkgFilter } = getPagination(req.query);
 
    const where: any = {
      userId: dbUser.id,
      ...(search    ? { fromUserAddress: { contains: search, mode: 'insensitive' as const } } : {}),
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

export const getGenerationIncomeTable = async (req:Request,res:Response) =>{
 try {
    const dbUser = (req as any).dbUser;
    const { page, pageSize, skip, search, pkgFilter, levelFilter } = getPagination(req.query);
 
    const where: any = {
      userId: dbUser.id,
      ...(search      ? { fromUserAddress: { contains: search, mode: 'insensitive' as const } } : {}),
      ...(pkgFilter   ? { packageNumber: pkgFilter }   : {}),
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