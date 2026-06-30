
import { ethers } from 'ethers';
import royaltyContractAbi from '../royalty-contract/royalty-abi.json';
import * as dotenv from 'dotenv';
dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_HTTP!);

export const royaltyContract = new ethers.Contract(
  process.env.ROYALTY_CONTRACT_ADDRESS!,
  royaltyContractAbi,
  provider
);