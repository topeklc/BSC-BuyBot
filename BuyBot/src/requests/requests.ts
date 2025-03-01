import axios from 'axios';
import { getTokenInfoFromDB } from '../../../DB/queries';
import { logInfo } from '../libs/logger';
export interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  owner: string;
  poolAddresses?: string[] | undefined;
  holders?: number;
  timestamp?: string;
}

const FETCHER_HOST = process.env.FETCHER_HOST || 'localhost';
const FETCHER_PORT = process.env.FETCHER_PORT || 3000;

export const fetchTokenInfoFetcher = async (address: string): Promise<TokenInfo | undefined> => {
  try {
    const response = await axios.get(`http://${FETCHER_HOST}:${FETCHER_PORT}/api/tokens/${address}`);
    if (response.data && response.data.error) {
      console.error('Error in token info response:', response.data.error);
      return undefined;
    }
    return response.data;
  } catch (error) {
    console.error('Error fetching token info:', error);
    throw error;
  }
};

