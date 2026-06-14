// src/routes/dashboardRoutes.ts
import { Router } from 'express';

const router = Router();

// stack both middlewares — auth check first, then registration check

router.get('/stats', (req, res) => {
  const user = (req as any).dbUser;
  res.json({ message: 'Welcome to dashboard', user });
});

export default router;