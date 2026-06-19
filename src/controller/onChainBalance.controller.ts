// src/controllers/onChainBalanceController.ts

import { Request, Response } from "express";
import { ethers } from "ethers";
import contractAbi from "../contract/contract-abi.json";
import usdtAbi from "../contract/usdt-abi.json"; // ASSUMPTION: path/filename — adjust to your actual USDT ABI location
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_HTTP!);

const ficonContract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS!,
  contractAbi,
  provider
);

const usdtContract = new ethers.Contract(
  process.env.USDT_CONTRACT_ADDRESS! || '0x55d398326f99059fF775485246999027B3197955', // ASSUMPTION: env var name — adjust if yours differs
  usdtAbi,
  provider
);

const USDT_DECIMALS = 18;

// ─── GET /api/dashboard/on-chain-balances ─────────────────
export const getOnChainBalances = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;
    const userAddress = dbUser.userAddress;

    // Run both RPC calls concurrently — if one fails, the other can
    // still succeed (Promise.allSettled, not Promise.all).
    const [walletResult, holdingResult] = await Promise.allSettled([
      usdtContract.balanceOf(userAddress),
      ficonContract.autoUpgradeHolding(userAddress),
    ]);

    const walletFundBalance = walletResult.status === 'fulfilled'
      ? parseFloat(ethers.utils.formatUnits(walletResult.value, USDT_DECIMALS))
      : 0;

    const upgradeHoldingIncome = holdingResult.status === 'fulfilled'
      ? parseFloat(ethers.utils.formatUnits(holdingResult.value, USDT_DECIMALS))
      : 0;

    if (walletResult.status === 'rejected') {
      console.warn(`⚠️  balanceOf failed for ${userAddress}:`, walletResult.reason?.message);
    }
    if (holdingResult.status === 'rejected') {
      console.warn(`⚠️  autoUpgradeHolding failed for ${userAddress}:`, holdingResult.reason?.message);
    }

    res.status(200).json({
      success: true,
      walletFundBalance,
      upgradeHoldingIncome,
      // flags let the frontend distinguish "genuinely zero" from
      // "RPC failed, this is a fallback zero" if you want to show a
      // subtle warning icon instead of treating both the same
      walletFundBalanceError:    walletResult.status === 'rejected',
      upgradeHoldingIncomeError: holdingResult.status === 'rejected',
    });

  } catch (error: any) {
    console.error('getOnChainBalances error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};