// src/routes/registration.routes.ts
import { Router, type Request, type Response } from 'express';
import { requireAuth, requireRegistered } from '../middleware/authMiddleware';
import { prisma } from '..';
import { auth } from '../lib/auth';

const router = Router();

// ─── GET /api/register/info ───────────────────────────────
// Check if the currently connected wallet is already registered
router.get('/info', requireAuth,requireRegistered, async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;
    res.json({
      isRegistered:  dbUser.isRegistered,
      userAddress:   dbUser.userAddress,
      contractRegId: dbUser.contractRegId ?? null,
    });

  } catch (error: any) {
    console.error('register/info error:', error.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/register/validate/:contractRegId ────────────
// Validate a referral by their on-chain contractRegId
// Called live as user types to show referrer details
router.get('/validate/:contractRegId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { contractRegId } = req.params;

    const parsedRegId = parseInt(contractRegId as string, 10);

    if (!contractRegId || !Number.isFinite(parsedRegId) || parsedRegId <= 0) {
      res.status(400).json({ valid: false, error: 'Invalid referral ID format' });
      return;
    }

    const referrer = await prisma.user.findFirst({
      where:  { contractRegId: parsedRegId },
      select: {
        userAddress:   true,
        isRegistered:  true,
        contractRegId: true,
        packages: {
          orderBy: { packageNumber: 'desc' },
          take:    1,
          select:  { packageNumber: true },
        },
      },
    });

    if (!referrer || !referrer.isRegistered) {
      res.status(404).json({ valid: false, error: 'Referral ID not found or not registered' });
      return;
    }

    res.json({
      valid:          true,
      userAddress:    referrer.userAddress,
      contractRegId:  referrer.contractRegId,
      highestPackage: referrer.packages[0]?.packageNumber ?? 0,
      displayAddress: `${referrer.userAddress.slice(0, 6)}…${referrer.userAddress.slice(-4)}`,
    });

  } catch (error: any) {
    console.error('validate contractRegId error:', error.message);
    res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// ─── GET /api/user/by-address/:address ────────────────────
// Resolves a wallet address to its contractRegId
// Used when navigating with ?referralAddress= in the URL
router.get('/by-address/:address', async (req: Request, res: Response) => {
  try {
    const address = (req.params.address as string).toLowerCase();
    const user = await prisma.user.findUnique({
      where:  { userAddress: address },
      select: { userAddress: true, isRegistered: true, contractRegId: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({
      userAddress:   user.userAddress,
      isRegistered:  user.isRegistered,
      contractRegId: user.contractRegId,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;