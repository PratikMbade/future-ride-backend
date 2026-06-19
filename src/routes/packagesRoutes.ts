
import { Router } from 'express';
import {  requireAuth, requireRegistered } from '../middleware/authMiddleware';
import { buyPackage, getPackageHistory, getUserPackages } from '../controller/packagebuy.controller';

const router = Router();

// all package routes require auth + registration
router.use(requireAuth,requireRegistered);

// GET  /api/packages       — get all packages for current user
router.get('/', getUserPackages);

// POST /api/packages/buy   — record a package buy (fallback if event missed)
router.post('/buy', buyPackage);

router.get('/package-history',getPackageHistory);

export default router;