// src/middleware/authMiddleware.ts
import { NextFunction,Request,Response } from "express";
import { prisma } from "..";
import { auth } from "../lib/auth";
export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers as any });

    if (!session) {
      res.status(401).json({ error: 'Unauthorized — no session' });
      return;
    }

    (req as any).session = session;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Unauthorized' });
  }
};
export const requireRegistered = async (req: Request, res: Response, next: NextFunction) => {
  const session = (req as any).session;

  const walletEntry = await prisma.walletAddress.findFirst({
    where: { userId: session.user.id },
    include: { user: true },
  });

  if (!walletEntry || !walletEntry.user.isRegistered) {
    res.status(403).json({ error: 'Not registered on contract' });
    return;
  }

  (req as any).dbUser = walletEntry.user;
  next();
};