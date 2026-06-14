
import { ethers } from 'ethers';
import contractABI from '../contract/contract-abi.json';
import * as dotenv from 'dotenv';
dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_HTTP!);

export const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS!,
  contractABI,
  provider
);