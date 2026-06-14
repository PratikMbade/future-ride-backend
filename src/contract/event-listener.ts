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
dotenv.config();

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS!;
const ALCHEMY_WSS      = process.env.ALCHEMY_WSS!;


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
      ) => {
        const id = regId.toNumber();
        console.log(`📥 RegisterEV: ${user} ref:${referral} id:${id}`);
        try {
          await registerUserService(user, referral, id);
          // wait 2s — let contract state finalise before reading InternalGenStr
          await new Promise(r => setTimeout(r, 2000));
          await generationTreeService(user);
        } catch (err: any) {
          console.error('RegisterEV error:', err.message);
        }
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
        user:  string,
        pkg:   ethers.BigNumber,
        time:  ethers.BigNumber,
        event: ethers.Event,
      ) => {
        const packageNumber = pkg.toNumber();
        const txHash        = event.transactionHash;
        console.log(`📥 PackageBuyEV: ${user} PKG${packageNumber} tx:${txHash}`);
        try {
          await packageBuyService(user, packageNumber, txHash);
        } catch (err: any) {
          console.error('PackageBuyEV error:', err.message);
        }
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
        user:  string,
        pkg:   ethers.BigNumber,
        time:  ethers.BigNumber,
        event: ethers.Event,
      ) => {
        const packageNumber = pkg.toNumber();
        const txHash        = event.transactionHash;
        console.log(`📥 PackageUpgradeEV (auto): ${user} PKG${packageNumber} tx:${txHash}`);
        try {
          // same service — packageBuyService is idempotent
          await packageBuyService(user, packageNumber, txHash);
        } catch (err: any) {
          console.error('PackageUpgradeEV error:', err.message);
        }
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
        try {
          await directIncomeService(from, to, amountUsdt, packageNumber, timestamp, txHash);
        } catch (err: any) {
          console.error('DirectPayEV error:', err.message);
        }
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
        try {
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
        } catch (err: any) {
          console.error('GenerationPayEV error:', err.message);
        }
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
        try {
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
        } catch (err: any) {
          console.error('LapsPayEV error:', err.message);
        }
      });
    },
  });
};