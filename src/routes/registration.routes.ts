// src/routes/registration.routes.ts
import { Router, type Request, type Response } from 'express';
import { requireAuth, requireRegistered } from '../middleware/authMiddleware';
import { prisma } from '..';
import { auth } from '../lib/auth';
import { registrationFallback } from '../controller/registerFallback.controller';

const router = Router();

router.post('/fallback', registrationFallback);

// ─── futureRideId normalization ───────────────────────────
// Accepted shape: "FR" + 8+ hex chars, case-insensitive on input,
// stored/compared as "FR" (upper) + lowercase hex tail, e.g. FR76b85b17.
// Returns null if the raw string doesn't match the expected shape.
function normalizeFutureRideId(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^fr([a-f0-9]{6,})$/i.exec(trimmed);
  if (!match) return null;
  return `FR${match[1].toLowerCase()}`;
}

// ─── GET /api/register/info ───────────────────────────────
// Check if the currently connected wallet is already registered
router.get('/info', requireAuth, requireRegistered, async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;
    res.json({
      isRegistered: dbUser.isRegistered,
      userAddress:  dbUser.userAddress,
      futureRideId: dbUser.futureRideId ?? null,
    });

  } catch (error: any) {
    console.error('register/info error:', error.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/register/validate/:futureRideId ─────────────
// Validate a referral by their futureRideId (e.g. FR76b85b17)
// Called live as user types to show referrer details
router.get('/validate/:futureRideId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { futureRideId } = req.params;

    const normalized = normalizeFutureRideId(futureRideId as string);

    if (!normalized) {
      res.status(400).json({ valid: false, error: 'Invalid referral ID format' });
      return;
    }

    const referrer = await prisma.user.findFirst({
      where:  { futureRideId: normalized },
      select: {
        userAddress:  true,
        isRegistered: true,
        futureRideId: true,
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
      futureRideId:   referrer.futureRideId,
      highestPackage: referrer.packages[0]?.packageNumber ?? 0,
      displayAddress: `${referrer.userAddress.slice(0, 6)}…${referrer.userAddress.slice(-4)}`,
    });

  } catch (error: any) {
    console.error('validate futureRideId error:', error.message);
    res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// ─── GET /api/user/by-address/:address ────────────────────
// Resolves a wallet address to its futureRideId
// Used when navigating with ?referralAddress= in the URL
router.get('/by-address/:address', async (req: Request, res: Response) => {
  try {
    const address = (req.params.address as string).toLowerCase();
    const user = await prisma.user.findUnique({
      where:  { userAddress: address },
      select: { userAddress: true, isRegistered: true, futureRideId: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({
      userAddress:  user.userAddress,
      isRegistered: user.isRegistered,
      futureRideId: user.futureRideId,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;