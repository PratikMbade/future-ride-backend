// src/routes/chart.routes.ts
import { Router, type Request, type Response } from 'express';
import { requireAuth, requireRegistered } from '../middleware/authMiddleware';
import { prisma } from '..';
import { getBalanceHistoryHandler, getWeeklyIncomeChartHandler } from '../controller/chart.controller';

const router = Router();
router.use(requireAuth, requireRegistered);

// ─────────────────────────────────────────────────────────
//  GET /api/charts/balance-history
//  Returns last 7 days of cumulative income per day
//  Used by the WalletCard area chart
// ─────────────────────────────────────────────────────────
router.get('/balance-history', getBalanceHistoryHandler);

// ─────────────────────────────────────────────────────────
//  GET /api/charts/weekly-income
//  Returns last 6 weeks of income grouped by type
//  Used by the IncomeBreakdown bar chart
// ─────────────────────────────────────────────────────────
router.get('/weekly-income',getWeeklyIncomeChartHandler);

export default router;