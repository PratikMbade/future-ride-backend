// src/controllers/royaltyFallback.controller.ts
//
// Second-layer fallback for RoyaltyClaim if royaltyClaimEventListener
// (the live WSS listener in royaltyEventListener.ts) misses the event.
// Frontend calls this right after claimReward() confirms on-chain,
// sending ONLY the transactionHash — exactly the same trust model as
// registrationFallback.controller.ts: nothing about the claim amount,
// pool number, or recipient is taken from the client. Everything is
// derived from the transaction's own RoyaltyClaim log, parsed against
// the RoyaltyTest contract's ABI.
//
// Idempotency is enforced by royaltyincome.service.ts itself (a
// findFirst check on userId + transactionHash + poolNumber before
// create), so calling this when the live listener already processed
// the same tx is a safe no-op — same pattern as the registration
// fallback's relationship to event-listener.ts.

import { Request, Response } from 'express';
import { ethers } from 'ethers';
import royaltyContractAbi from '../contract/royalty-contract/royalty-abi.json' // ASSUMPTION: same path used in royaltyEventListener.ts/royaltySync.service.ts — adjust if your actual file lives elsewhere
import { royaltyIncomeService } from '../services/royaltyincome.service';
import * as dotenv from 'dotenv';
dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_HTTP!);
const contract = new ethers.Contract(
  process.env.ROYALTY_CONTRACT_ADDRESS!,
  royaltyContractAbi,
  provider
);

// ── POST /api/royalty/fallback ──────────────────────────────────────
export const royaltyClaimFallback = async (req: Request, res: Response) => {
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

    // ── find the RoyaltyClaim log in this transaction's receipt ──────
    // Same defensive pattern as packageController.ts's
    // getPackageContractBuyIdFromTx: logs from OTHER contracts in the
    // same tx (e.g. the distributionToken's own Transfer event, fired
    // internally by claimReward's IERC20(distributionToken).transfer()
    // call) will fail to parse against THIS contract's ABI — skip
    // those rather than aborting on the first unrelated log.
    let claimLog: ethers.utils.LogDescription | null = null;

    for (const log of receipt.logs) {
      let parsed: ethers.utils.LogDescription;
      try {
        parsed = contract.interface.parseLog(log);
      } catch {
        continue;
      }
      if (parsed.name === 'RoyaltyClaim') {
        claimLog = parsed;
        break; // claimReward only ever emits RoyaltyClaim once per call
      }
    }

    if (!claimLog) {
      res.status(400).json({
        error: 'No RoyaltyClaim event found in this transaction — is this a valid claim tx?',
      });
      return;
    }

    // ── extract and verify against the ACTUAL on-chain event, not
    //    anything the client claimed ───────────────────────────────
    const userAddress = (claimLog.args.user    as string).toLowerCase();
    const amount       = (claimLog.args.amount  as ethers.BigNumber);
    const poolNumber   = (claimLog.args.package as ethers.BigNumber).toNumber();
    const timestamp    = (claimLog.args.time    as ethers.BigNumber).toNumber();

    const amountClaim = ethers.utils.formatUnits(amount, 18);

    const result = await royaltyIncomeService(
      userAddress, amountClaim, poolNumber, timestamp, normalizedTxHash,
    );

    if (!result) {
      // royaltyIncomeService returns null in two cases: the user
      // wasn't found in the DB (genuine data problem, not a normal
      // retry case), or a P2002 concurrent-write race (the live
      // listener won the race to insert first) — either way, from the
      // caller's perspective the claim is accounted for or the system
      // is in a state this endpoint can't unilaterally fix, so this
      // isn't treated as a hard failure.
      res.status(200).json({
        success: true,
        alreadyRecorded: true,
        message: 'Claim already recorded or could not be matched to a known user',
      });
      return;
    }

    console.log(
      `✅ [Fallback] RoyaltyClaim tx ${normalizedTxHash} recorded: ${userAddress} PKG${poolNumber} +${amountClaim}`,
    );

    res.status(201).json({
      success: true,
      alreadyRecorded: false,
      message: `Royalty claim for pool ${poolNumber} recorded successfully`,
      royaltyIncome: result,
    });

  } catch (error: any) {
    console.error('royaltyClaimFallback error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};