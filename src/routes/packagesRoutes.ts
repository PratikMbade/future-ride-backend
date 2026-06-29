// src/routes/packagebuy.routes.ts
import { Router } from 'express';
import { requireAuth, requireRegistered } from '../middleware/authMiddleware';
import {
  buyPackage,
  getPackageHistory,
  getUserPackages,
  lookupUserPackage,
  buyPackageForUser,
} from '../controller/packagebuy.controller';

const router = Router();

// ─── admin / on-behalf-of routes ──────────────────────────
// These intentionally sit BEFORE the requireRegistered gate below:
// the admin operating this tool may not be a registered matrix
// member themselves, but still needs to look up and activate
// packages on behalf of other users. They still require a valid
// authenticated session via requireAuth.
router.get('/lookup/:address', requireAuth, lookupUserPackage);
router.post('/buy-for', requireAuth, buyPackageForUser);

// all remaining package routes require auth + registration
router.use(requireAuth, requireRegistered);

// GET  /api/packages       — get all packages for current user
router.get('/', getUserPackages);

// POST /api/packages/buy   — record a package buy (fallback if event missed)
router.post('/buy', buyPackage);

router.get('/package-history', getPackageHistory);

export default router;