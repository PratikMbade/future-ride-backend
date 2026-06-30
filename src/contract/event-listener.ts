import { reconnectSilent }         from '../utils/reconnectSilent';
import contractAbi                 from '../contract/contract-abi.json';
import { registerUserService }     from '../services/registeruser.service';
import { generationTreeService }   from '../services/generationtree.service';
import { packageBuyService }       from '../services/packagebuy.service';
import { directIncomeService }     from '../services/directincome.service';
import { generationIncomeService } from '../services/generationincome.service';
import { lapsIncomeService }       from '../services/lapsincome.service';
import { ethers }                  from 'ethers';
import * as dotenv from 'dotenv';
import { upgradeHoldingService } from '../services/upgradeHolding.service';
import { queueTxEvent } from '../utils/txEventQueue';
import { royaltyIncomeService } from '../services/royaltyincome.service';
import roayltyContractABI from '../contract/royalty-contract/royalty-abi.json'
dotenv.config();

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS!;
const ALCHEMY_WSS      = process.env.ALCHEMY_WSS!;

// All 6 listeners now route their actual work through queueTxEvent instead
// of running immediately inside the contract.on(...) callback. A single
// registration transaction emits RegisterEV + PackageBuyEV + DirectPayEV +
// GenerationPayEV (and potentially LapsPayEV/UpgradeHolding) all in ONE tx —
// these arrive over the WebSocket as independent, unordered pushes. Without
// the queue, PackageBuyEV's handler could (and did) run before RegisterEV's
// had finished creating the user row, causing "User not found in DB"
// failures. queueTxEvent buffers all events sharing a txHash and runs them
// in a fixed priority order (RegisterEV first, always) once a brief window
// has passed — see utils/txEventQueue.ts for the full explanation.

export const registrationEventListener = () => {
  reconnectSilent({
    wssUrl: ALCHEMY_WSS, contractAddress: CONTRACT_ADDRESS,
    abi: contractAbi, label: 'RegisterEV',
    onReady: (_, contract) => {
      contract.removeAllListeners('RegisterEV');

      contract.on('RegisterEV', async (
        user:     string,
        referral: string,
        time:     ethers.BigNumber,
        regId:    ethers.BigNumber,
        event:    ethers.Event,
      ) => {
        const id = regId.toNumber();
        const timestamp = time.toNumber()
        const txHash = event.transactionHash;
        console.log(`📥 RegisterEV: ${user} ref:${referral} id:${id}`);

        queueTxEvent(txHash, 'RegisterEV', async () => {
          await registerUserService(user, referral, id,String(timestamp));
          // wait 2s — let contract state finalise before reading InternalGenStr
          await new Promise(r => setTimeout(r, 2000));
          await generationTreeService(user);
        });
      });
    },
  });
};

// ─────────────────────────────────────────────────────────
//  PACKAGE BUY EV
//  event PackageBuyEV(
//    address indexed user,
//    uint256 indexed package,
//    uint256 time
//  )
//  Emitted on FIRST buy (registrations auto-buy pkg 1) and manual buys
// ─────────────────────────────────────────────────────────
export const packageBuyEventListener = () => {
  reconnectSilent({
    wssUrl: ALCHEMY_WSS, contractAddress: CONTRACT_ADDRESS,
    abi: contractAbi, label: 'PackageBuyEV',
    onReady: (_, contract) => {
      contract.removeAllListeners('PackageBuyEV');

      contract.on('PackageBuyEV', async (
        user:      string,
        pkg:       ethers.BigNumber,
        time:      ethers.BigNumber,
        currentId: ethers.BigNumber,
        event:     ethers.Event,
      ) => {
        const packageNumber = pkg.toNumber();
        const txHash        = event.transactionHash;
        const timestamp = time.toNumber()
        console.log(`📥 PackageBuyEV: ${user} PKG${packageNumber} tx:${txHash} currentId:${currentId}`);

        queueTxEvent(txHash, 'PackageBuyEV', async () => {
          await packageBuyService(user.toLowerCase(), packageNumber, currentId.toNumber(), txHash,String(timestamp));
        });
      });
    },
  });
};

// ─────────────────────────────────────────────────────────
//  PACKAGE UPGRADE EV  ← auto-upgrade triggered by contract
//  event PackageUpgradeEV(
//    address indexed user,
//    uint256 indexed package,
//    uint256 time
//  )
//  Same DB action as PackageBuyEV — just a different code path in contract
// ─────────────────────────────────────────────────────────
export const packageUpgradeEventListener = () => {
  reconnectSilent({
    wssUrl: ALCHEMY_WSS, contractAddress: CONTRACT_ADDRESS,
    abi: contractAbi, label: 'PackageUpgradeEV',
    onReady: (_, contract) => {
      contract.removeAllListeners('PackageUpgradeEV');

      contract.on('PackageUpgradeEV', async (
        user:      string,
        pkg:       ethers.BigNumber,
        time:      ethers.BigNumber,
        currentId: ethers.BigNumber,
        event:     ethers.Event,
      ) => {
        const packageNumber = pkg.toNumber();
        const txHash        = event.transactionHash;
        const timestamp = time.toNumber()
        console.log(`📥 PackageUpgradeEV (auto): ${user} PKG${packageNumber} tx:${txHash} currentId:${currentId}`);

        queueTxEvent(txHash, 'PackageUpgradeEV', async () => {
          // same service — packageBuyService is idempotent
          await packageBuyService(user.toLowerCase(), packageNumber, currentId.toNumber(), txHash,String(timestamp));
        });
      });
    },
  });
};

// ─────────────────────────────────────────────────────────
//  DIRECT PAY EV
//  event DirectPayEV(
//    address indexed from,
//    address indexed to,
//    uint256 indexed amount,
//    uint256 package,
//    uint256 time
//  )
//  50% of fee → referral address (direct sponsor)
// ─────────────────────────────────────────────────────────
export const directIncomeEventListener = () => {
  reconnectSilent({
    wssUrl: ALCHEMY_WSS, contractAddress: CONTRACT_ADDRESS,
    abi: contractAbi, label: 'DirectPayEV',
    onReady: (_, contract) => {
      contract.removeAllListeners('DirectPayEV');

      contract.on('DirectPayEV', async (
        from:   string,
        to:     string,
        amount: ethers.BigNumber,
        pkg:    ethers.BigNumber,
        time:   ethers.BigNumber,
        event:  ethers.Event,
      ) => {
        const packageNumber = pkg.toNumber();
        const amountUsdt    = ethers.utils.formatUnits(amount, 18);
        const timestamp     = time.toNumber();
        const txHash        = event.transactionHash;
        console.log(`📥 DirectPayEV: ${from}→${to} PKG${packageNumber} ${amountUsdt} USDT`);

        queueTxEvent(txHash, 'DirectPayEV', async () => {
          await directIncomeService(from, to, amountUsdt, packageNumber, timestamp, txHash);
        });
      });
    },
  });
};

// ─────────────────────────────────────────────────────────
//  GENERATION PAY EV
//  event GenerationPayEV(
//    address indexed from,
//    address indexed to,
//    uint256 indexed amount,
//    uint256 package,
//    uint256 time,
//    uint256 lvlpay,   ← generation level (how many tree levels up)
//    address user      ← original buyer who triggered distribution
//  )
//  Emitted when i==0 in distributeFee loop (first eligible upline)
// ─────────────────────────────────────────────────────────
export const generationEventListener = () => {
  reconnectSilent({
    wssUrl: ALCHEMY_WSS, contractAddress: CONTRACT_ADDRESS,
    abi: contractAbi, label: 'GenerationPayEV',
    onReady: (_, contract) => {
      contract.removeAllListeners('GenerationPayEV');

      contract.on('GenerationPayEV', async (
        from:         string,
        to:           string,
        amount:       ethers.BigNumber,
        pkg:          ethers.BigNumber,
        time:         ethers.BigNumber,
        lvlpay:       ethers.BigNumber,  // ← level in tree
        originalUser: string,            // ← buyer who triggered it
        event:        ethers.Event,
      ) => {
        const packageNumber = pkg.toNumber();
        const level         = lvlpay.toNumber();
        const amountUsdt    = ethers.utils.formatUnits(amount, 18);
        const timestamp     = time.toNumber();
        const txHash        = event.transactionHash;
        console.log(`📥 GenerationPayEV: ${originalUser}→${to} PKG${packageNumber} LVL${level} ${amountUsdt} USDT`);

        queueTxEvent(txHash, 'GenerationPayEV', async () => {
          await generationIncomeService(
            from,          // contract address (address(this))
            to,            // recipient upline
            amountUsdt,
            packageNumber,
            level,
            timestamp,
            txHash,
            originalUser,  // actual buyer
          );
        });
      });
    },
  });
};

// ─────────────────────────────────────────────────────────
//  LAPS PAY EV
//  event LapsPayEV(
//    address indexed from,
//    address indexed to,
//    uint256 indexed amount,
//    uint256 package,
//    uint256 time,
//    uint256 lvlpay,   ← level where laps occurred
//    address lapAdd    ← the address that was skipped/lapsed
//  )
//  Emitted when i>0 (after first iteration, upline is ineligible)
//  OR when fallback to owner after 9 iterations
// ─────────────────────────────────────────────────────────
export const lapsIncomeEventListener = () => {
  reconnectSilent({
    wssUrl: ALCHEMY_WSS, contractAddress: CONTRACT_ADDRESS,
    abi: contractAbi, label: 'LapsPayEV',
    onReady: (_, contract) => {
      contract.removeAllListeners('LapsPayEV');

      contract.on('LapsPayEV', async (
        from:       string,
        to:         string,
        amount:     ethers.BigNumber,
        pkg:        ethers.BigNumber,
        time:       ethers.BigNumber,
        lvlpay:     ethers.BigNumber,  // ← level where laps happened
        lapAdd:     string,            // ← address that was lapsed
        event:      ethers.Event,
      ) => {
        const packageNumber = pkg.toNumber();
        const level         = lvlpay.toNumber();
        const amountUsdt    = ethers.utils.formatUnits(amount, 18);
        const timestamp     = time.toNumber();
        const txHash        = event.transactionHash;
        console.log(`📥 LapsPayEV: ${lapAdd} lapsed → paid ${to} PKG${packageNumber} LVL${level} ${amountUsdt} USDT`);

        queueTxEvent(txHash, 'LapsPayEV', async () => {
          await lapsIncomeService(
            from,           // contract address
            to,             // who actually received the payment
            amountUsdt,
            packageNumber,
            level,
            timestamp,
            txHash,
            lapAdd,         // who was skipped
          );
        });
      });
    },
  });
};


export const upgradeHoldingEventListener = () => {
  reconnectSilent({
    wssUrl:           ALCHEMY_WSS,
    contractAddress:  CONTRACT_ADDRESS,
    abi:              contractAbi,
    label:            'UpgradeHolding',
    onReady: (_, contract) => {
      contract.removeAllListeners('UpgradeHolding');

      contract.on('UpgradeHolding', async (
        user:      string,           // indexed — genUpline (receiver)
        fromUser:  string,           // not indexed — the buyer
        pkg:       ethers.BigNumber, // indexed — package number
        amount:    ethers.BigNumber, // indexed — holding amount in wei
        time:      ethers.BigNumber, // block.timestamp
        lvlPay:    ethers.BigNumber, // tree level
        event:     ethers.Event,
      ) => {
        const packageNumber = pkg.toNumber();
        const level         = lvlPay.toNumber();
        const timestamp     = time.toNumber();
        const txHash        = event.transactionHash;

        console.log(
          `📥 UpgradeHolding: ${user} ← ${fromUser} PKG${packageNumber} LVL${level} ` +
          `+${ethers.utils.formatUnits(amount, 18)} USDT tx:${txHash}`
        );

        queueTxEvent(txHash, 'UpgradeHolding', async () => {
          await upgradeHoldingService(
            user,        // genUpline — who gets the holding
            fromUser,    // buyer who triggered it
            packageNumber,
            amount,      // BigNumber in wei — service converts to string
            timestamp,
            level,
            txHash,
          );
        });
      });
    },
  });
};


export const royaltyClaimEventListener = () => {
  reconnectSilent({
    wssUrl: ALCHEMY_WSS, contractAddress: process.env.ROYALTY_CONTRACT_ADDRESS!,
    abi: roayltyContractABI, label: 'RoyaltyClaim',
    onReady: (_, contract) => {
      contract.removeAllListeners('RoyaltyClaim');
 
      contract.on('RoyaltyClaim', async (
        user:    string,
        amount:  ethers.BigNumber,
        pkg:     ethers.BigNumber,
        time:    ethers.BigNumber,
        event:   ethers.Event,
      ) => {
        const poolNumber  = pkg.toNumber();
        const amountClaim = ethers.utils.formatUnits(amount, 18);
        const timestamp   = time.toNumber();
        const txHash      = event.transactionHash;
 
        console.log(`📥 RoyaltyClaim: ${user} PKG${poolNumber} +${amountClaim} tx:${txHash}`);
 
        try {
          await royaltyIncomeService(user, amountClaim, poolNumber, timestamp, txHash);
        } catch (err: any) {
          console.error('RoyaltyClaim error:', err.message);
        }
      });
    },
  });
};