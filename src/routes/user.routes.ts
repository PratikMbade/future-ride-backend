// src/routes/user.routes.ts
import { Router } from 'express';
import { requireAuth, requireRegistered } from '../middleware/authMiddleware';
import { getDirectTeam, getMe } from '../controller/userInfo.controller';
import { getGenerationTeam } from '../controller/generationTeam.controller';

const router = Router();

// GET /api/user/me
router.get('/me', requireAuth, requireRegistered, getMe);

//GET /api/user/direct-team
router.get('/direct-team',requireAuth,requireRegistered,getDirectTeam)

//GET /api/user/generation-team
router.get('/generation-team', requireAuth,requireRegistered, getGenerationTeam);

export default router;