// src/routes/royalty.routes.ts
import { Router } from 'express';
import { royaltyClaimFallback } from '../controller/royalty.controller';

// import { requireAuth } from '../middleware/authMiddleware'; // see note below

const router = Router();

router.post('/fallback', royaltyClaimFallback);

export default router;