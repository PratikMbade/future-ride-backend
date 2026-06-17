// src/routes/treeRoutes.ts
import { Router } from 'express';
import { getGenerationTree } from '../controller/generationTree.controller';
import { requireAuth, requireRegistered } from '../middleware/authMiddleware';
// import {  requireRegistered } from '../middleware/authMiddleware';

const router = Router();

router.get('/:userAddress', getGenerationTree);

export default router;