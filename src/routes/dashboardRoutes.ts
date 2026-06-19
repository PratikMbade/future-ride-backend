// src/routes/dashboardRoutes.ts
import { Router } from 'express';
import { requireAuth, requireRegistered } from '../middleware/authMiddleware';
import { getOnChainBalances } from '../controller/onChainBalance.controller';

const router = Router();

// stack both middlewares — auth check first, then registration check
router.get('/stats', requireAuth,requireRegistered,(req, res) => {
  const user = (req as any).dbUser;
  res.json({ message: 'Welcome to dashboard', user });
});

router.get('/on-chain-balances',requireAuth,requireRegistered,getOnChainBalances)

export default router;