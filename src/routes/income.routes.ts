// src/routes/income.routes.ts
import { Router } from 'express';
import { requireAuth, requireRegistered } from '../middleware/authMiddleware';
import {
  getDirectIncome,
  getDirectIncomeTable,
  getGenerationIncome,
  getGenerationIncomeTable,
  getLapsIncome,
} from '../controller/income.controller';

const router = Router();
router.use(requireAuth, requireRegistered);

router.get('/direct',     getDirectIncome);
router.get('/generation', getGenerationIncome);
router.get('/laps',       getLapsIncome);
router.get('/direct-income-table',getDirectIncomeTable)
router.get('/generation-income-table',getGenerationIncomeTable)
export default router;