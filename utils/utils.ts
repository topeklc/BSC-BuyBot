import { TokenInfo } from '../types';
import { getTokenInfoFromDB } from '../DB/queries';
import { CommonWeb3 } from '../CommonWeb3/common';

export const commonWeb3 = new CommonWeb3();

export const fetchTokenInfo = async (address: string): Promise<TokenInfo | undefined> => {
    try {
      // First try to get token from database
      const dbToken = await getTokenInfoFromDB(address);
      
      if (dbToken) {
        // Check if token was updated in the last 5 minutes
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        if (dbToken.updatedAt > fiveMinutesAgo) {
          return {
            address: dbToken.address,
            decimals: dbToken.decimals,
            name: dbToken.name,
            symbol: dbToken.symbol,
            totalSupply: dbToken.totalSupply,
            poolAddresses: dbToken.poolAddresses,
            owner: dbToken.owner
          };
        }
      }
  
      // If token not in DB or older than 5 minutes, fetch from Fetcher service
      try {
      return await commonWeb3.getTokenInfo(address);
      } catch (error) {
        console.error('Error in getTokenInfo:', error);
        // FALLBACK TO DB
        if (dbToken) {
        return {
          address: dbToken.address,
          decimals: dbToken.decimals,
          name: dbToken.name,
          symbol: dbToken.symbol,
          totalSupply: dbToken.totalSupply,
          owner: dbToken.owner
        };
      }}
    } catch (error) {
      console.error('Error in fetchTokenInfo:', error);
    }
  };