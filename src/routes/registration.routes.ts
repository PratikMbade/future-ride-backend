// src/routes/registration.routes.ts
import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/authMiddleware';
import { prisma } from '..';
import { auth } from '../lib/auth';

const router = Router();

// ─── GET /api/register/validate/:ficonId ─────────────────
// Validate a referral FICON ID and return the referrer's info
// Called live as user types to show referrer details
// src/routes/registration.routes.ts
router.get('/info', async (req: Request, res: Response) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers as any });

    if (!session?.user) {
      res.json({ isRegistered: false, userAddress: null, ficonId: null });
      return;
    }

    // better-auth stores wallet address in the `name` field
    // your prisma middleware copies it to userAddress on create
    const walletAddress = (session.user.name as string)?.toLowerCase();

    if (!walletAddress || !walletAddress.startsWith('0x')) {
      res.json({ isRegistered: false, userAddress: null, ficonId: null });
      return;
    }

    const dbUser = await prisma.user.findUnique({
      where:  { userAddress: walletAddress },   // ← now always defined
      select: { isRegistered: true, userAddress: true, ficonId: true, contractRegId: true },
    });

    res.json({
      isRegistered:  dbUser?.isRegistered  ?? false,
      userAddress:   dbUser?.userAddress   ?? null,
      ficonId:       dbUser?.ficonId       ?? null,
      contractRegId: dbUser?.contractRegId ?? null,
    });

  } catch (err: any) {
    console.error('register/info error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/validate/:ficonId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { ficonId } = req.params ;

    if (!ficonId || ficonId.length < 8) {
      res.status(400).json({ valid: false, error: 'Invalid FICON ID format' });
      return;
    }

    const referrer = await prisma.user.findUnique({
      where:  { ficonId: String(ficonId).trim() },
      select: {
        userAddress:   true,
        ficonId:       true,
        isRegistered:  true,
        contractRegId: true,
        // highest package
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
      ficonId:        referrer.ficonId,
      userAddress:    referrer.userAddress,
      contractRegId:  referrer.contractRegId,
      highestPackage: referrer.packages[0]?.packageNumber ?? 0,
      // show shortened address for display
      displayAddress: `${referrer.userAddress.slice(0, 6)}…${referrer.userAddress.slice(-4)}`,
    });

  } catch (error: any) {
    console.error('validate ficonId error:', error.message);
    res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// ─── GET /api/register/info ───────────────────────────────
// Check if the currently connected wallet is already registered
router.get('/info', requireAuth, async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;

    res.json({
      isRegistered:  dbUser.isRegistered,
      userAddress:   dbUser.userAddress,
      ficonId:       dbUser.ficonId ?? null,
      contractRegId: dbUser.contractRegId ?? null,
    });

  } catch (error: any) {
    console.error('register/info error:', error.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/user/by-address/:address ────────────────────
// Resolves a wallet address to its FICON ID
// Used when navigating with ?referralAddress= in the URL
router.get('/by-address/:address', async (req: Request, res: Response) => {
  try {
    const address = (req.params.address as string).toLowerCase();
    const user = await prisma.user.findUnique({
      where:  { userAddress: address },
      select: { ficonId: true, userAddress: true, isRegistered: true },
    });
    if (!user || !user.ficonId) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ ficonId: user.ficonId, userAddress: user.userAddress, isRegistered: user.isRegistered });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;