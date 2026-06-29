

import { Request, Response } from 'express';
import { ethers } from 'ethers';
import { prisma } from '..';
import contractAbi from '../contract/contract-abi.json';
import { registerUserService } from '../services/registeruser.service';
import { generationTreeService } from '../services/generationtree.service';
import { packageBuyService } from '../services/packagebuy.service';
import { directIncomeService } from '../services/directincome.service';
import { generationIncomeService } from '../services/generationincome.service';
import { lapsIncomeService } from '../services/lapsincome.service';
import { upgradeHoldingService } from '../services/upgradeHolding.service';
import * as dotenv from 'dotenv';
dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_HTTP!);
const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS!,
  contractAbi,
  provider
);

// ── decoded-log buckets, one array per event type ──────────────────
interface DecodedLogs {
  register:   ethers.utils.LogDescription[];
  packageBuy: ethers.utils.LogDescription[];
  packageUpgrade: ethers.utils.LogDescription[];
  direct:     ethers.utils.LogDescription[];
  generation: ethers.utils.LogDescription[];
  laps:       ethers.utils.LogDescription[];
  upgradeHolding: ethers.utils.LogDescription[];
}

// ── parse every log in the receipt, bucket by event name ───────────
// Logs from OTHER contracts in the same tx (e.g. USDT Transfer/Approval
// during the auto package-1 purchase) will fail parseLog against our
// ABI — skip those rather than aborting the whole parse.
function decodeReceiptLogs(receipt: ethers.providers.TransactionReceipt): DecodedLogs {
  const buckets: DecodedLogs = {
    register: [], packageBuy: [], packageUpgrade: [],
    direct: [], generation: [], laps: [], upgradeHolding: [],
  };

  for (const log of receipt.logs) {
    let parsed: ethers.utils.LogDescription;
    try {
      parsed = contract.interface.parseLog(log);
    } catch {
      continue; // not one of our contract's events — skip
    }

    switch (parsed.name) {
      case 'RegisterEV':       buckets.register.push(parsed);       break;
      case 'PackageBuyEV':     buckets.packageBuy.push(parsed);     break;
      case 'PackageUpgradeEV': buckets.packageUpgrade.push(parsed); break;
      case 'DirectPayEV':      buckets.direct.push(parsed);         break;
      case 'GenerationPayEV':  buckets.generation.push(parsed);     break;
      case 'LapsPayEV':        buckets.laps.push(parsed);           break;
      case 'UpgradeHolding':   buckets.upgradeHolding.push(parsed); break;
      // unknown event names from our own ABI are silently ignored —
      // forward-compatible with future contract versions that add
      // events this fallback doesn't yet know how to process
    }
  }

  return buckets;
}

// ── POST /api/register/fallback ─────────────────────────────────────
export const registrationFallback = async (req: Request, res: Response) => {
  try {
    const { transactionHash } = req.body as { transactionHash: string };

    if (!transactionHash || !/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) {
      res.status(400).json({ error: 'Valid transactionHash is required' });
      return;
    }

    const normalizedTxHash = transactionHash.toLowerCase();

    const receipt = await provider.getTransactionReceipt(normalizedTxHash);
    if (!receipt) {
      res.status(404).json({
        error: 'Transaction not found or not yet mined. Try again in a moment.',
      });
      return;
    }

    const logs = decodeReceiptLogs(receipt);

    if (logs.register.length === 0) {
      res.status(400).json({
        error: 'No RegisterEV found in this transaction — is this a registration tx?',
      });
      return;
    }

    const results = {
      registered:        false,
      packagesBought:     0,
      packagesUpgraded:   0,
      directPayouts:      0,
      generationPayouts:  0,
      lapsPayouts:        0,
      upgradeHoldings:    0,
      errors:             [] as string[],
    };

    // ── STEP 1: RegisterEV — must run first, everything else depends
    //    on the user row existing ────────────────────────────────────
    for (const log of logs.register) {
      const userAddress = (log.args.user as string).toLowerCase();
      const referral     = (log.args.referal as string).toLowerCase();
      const regId         = (log.args.id as ethers.BigNumber).toNumber();
      const timestamp     = (log.args.time as ethers.BigNumber).toNumber()
      try {
        // idempotent — registerUserService throws if already
        // registered, which we treat as "fine, already handled" rather
        // than a hard failure, since the event listener may have
        // already processed this in the background
        const existing = await prisma.user.findUnique({
          where:  { userAddress },
          select: { isRegistered: true },
        });

        if (!existing?.isRegistered) {
          await registerUserService(userAddress, referral, regId,String(timestamp));
          // wait for contract state to finalize before reading
          // InternalGenStr, same delay event-listener.ts uses
          await new Promise(r => setTimeout(r, 2000));
          await generationTreeService(userAddress);
        }
        results.registered = true;
      } catch (err: any) {
        results.errors.push(`RegisterEV: ${err.message}`);
      }
    }

    // ── STEP 2: PackageBuyEV / PackageUpgradeEV ─────────────────────
    for (const log of logs.packageBuy) {
      const userAddress          = (log.args.user as string).toLowerCase();
      const packageNumber        = (log.args.package as ethers.BigNumber).toNumber();
      const packageContractBuyId = (log.args.currentId as ethers.BigNumber).toNumber();
      const timestamp            = (log.args.time as ethers.BigNumber).toNumber()

      try {
        const result = await packageBuyService(userAddress, packageNumber, packageContractBuyId, normalizedTxHash,String(timestamp));
        if (result) results.packagesBought++;
      } catch (err: any) {
        results.errors.push(`PackageBuyEV PKG${packageNumber}: ${err.message}`);
      }
    }

    for (const log of logs.packageUpgrade) {
      const userAddress          = (log.args.user as string).toLowerCase();
      const packageNumber        = (log.args.package as ethers.BigNumber).toNumber();
      const packageContractBuyId = (log.args.currentId as ethers.BigNumber).toNumber();
      const timestamp            = (log.args.time as ethers.BigNumber).toNumber()

      try {
        // same service — packageBuyService is idempotent, matches
        // event-listener.ts's own handling of PackageUpgradeEV
        const result = await packageBuyService(userAddress, packageNumber, packageContractBuyId, normalizedTxHash,String(timestamp));
        if (result) results.packagesUpgraded++;
      } catch (err: any) {
        results.errors.push(`PackageUpgradeEV PKG${packageNumber}: ${err.message}`);
      }
    }

    // ── STEP 3: DirectPayEV ──────────────────────────────────────────
    for (const log of logs.direct) {
      const from          = (log.args.from as string).toLowerCase();
      const to            = (log.args.to as string).toLowerCase();
      const packageNumber = (log.args.package as ethers.BigNumber).toNumber();
      const amountUsdt    = ethers.utils.formatUnits(log.args.amount as ethers.BigNumber, 18);
      const timestamp     = (log.args.time as ethers.BigNumber).toNumber();

      try {
        const result = await directIncomeService(from, to, amountUsdt, packageNumber, timestamp, normalizedTxHash);
        if (result) results.directPayouts++;
      } catch (err: any) {
        results.errors.push(`DirectPayEV: ${err.message}`);
      }
    }

    // ── STEP 4: GenerationPayEV — can fire multiple times per tx,
    //    one per eligible upline level ────────────────────────────────
    for (const log of logs.generation) {
      const from          = (log.args.from as string).toLowerCase();
      const to            = (log.args.to as string).toLowerCase();
      const packageNumber = (log.args.package as ethers.BigNumber).toNumber();
      const level         = (log.args.lvlpay as ethers.BigNumber).toNumber();
      const amountUsdt    = ethers.utils.formatUnits(log.args.amount as ethers.BigNumber, 18);
      const timestamp     = (log.args.time as ethers.BigNumber).toNumber();
      const originalBuyer = (log.args.user as string).toLowerCase();

      try {
        const result = await generationIncomeService(
          from, to, amountUsdt, packageNumber, level, timestamp, normalizedTxHash, originalBuyer,
        );
        if (result) results.generationPayouts++;
      } catch (err: any) {
        results.errors.push(`GenerationPayEV L${level}: ${err.message}`);
      }
    }

    // ── STEP 5: LapsPayEV — can also fire multiple times per tx ──────
    for (const log of logs.laps) {
      const from          = (log.args.from as string).toLowerCase();
      const to            = (log.args.to as string).toLowerCase();
      const packageNumber = (log.args.package as ethers.BigNumber).toNumber();
      const level         = (log.args.lvlpay as ethers.BigNumber).toNumber();
      const amountUsdt    = ethers.utils.formatUnits(log.args.amount as ethers.BigNumber, 18);
      const timestamp     = (log.args.time as ethers.BigNumber).toNumber();
      const lapsedAddress = (log.args.lapAdd as string).toLowerCase();

      try {
        const result = await lapsIncomeService(
          from, to, amountUsdt, packageNumber, level, timestamp, normalizedTxHash, lapsedAddress,
        );
        if (result) results.lapsPayouts++;
      } catch (err: any) {
        results.errors.push(`LapsPayEV L${level}: ${err.message}`);
      }
    }

    // ── STEP 6: UpgradeHolding — unlikely on a fresh registration
    //    (no prior holding balance exists yet) but handled for
    //    completeness, matching sync.service.ts's full processBatch ──
    for (const log of logs.upgradeHolding) {
      const userAddress     = (log.args.user as string).toLowerCase();
      const fromUserAddress = (log.args.fromUser as string).toLowerCase();
      const packageNumber   = (log.args.package as ethers.BigNumber).toNumber();
      const amountWei        = log.args.amount as ethers.BigNumber;
      const timestamp        = (log.args.time as ethers.BigNumber).toNumber();
      const level             = (log.args.lvlPay as ethers.BigNumber).toNumber();

      try {
        const result = await upgradeHoldingService(
          userAddress, fromUserAddress, packageNumber, amountWei, timestamp, level, normalizedTxHash,
        );
        if (result) results.upgradeHoldings++;
      } catch (err: any) {
        results.errors.push(`UpgradeHolding: ${err.message}`);
      }
    }

    console.log(
      `✅ [Fallback] Registration tx ${normalizedTxHash} processed:`,
      JSON.stringify(results),
    );

    res.status(200).json({
      success: true,
      message: 'Registration and related events processed from transaction logs',
      ...results,
    });

  } catch (error: any) {
    console.error('registrationFallback error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};