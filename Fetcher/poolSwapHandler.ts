import { BuyMessageData } from '../types/types';
import { CommonWeb3, WBNB } from '../CommonWeb3/common';
import { getPrice, getTokenInfoFromDB } from '../DB/queries';

/**
 * Processes swap events from Uniswap V3 style pools and converts them to BuyMessageData
 */
export class PoolSwapHandler {
    private commonWeb3: CommonWeb3;

    constructor() {
        this.commonWeb3 = new CommonWeb3();
    }
    
    /**
     * Process a pool swap event and convert it to BuyMessageData format
     * @param poolAddress The address of the pool where the swap occurred
     * @param data The swap event data
     */
    public async processSwapEvent(poolAddress: string, data: {
        sender: string;
        recipient: string;
        amount0: any;
        amount1: any;
        sqrtPriceX96: string;
        liquidity: string;
        tick: string;
        token0Address: string;
        token1Address: string;
    }): Promise<BuyMessageData | null> {
        try {
            console.log('Processing swap event:', data);
            console.log('Raw amount0 type:', typeof data.amount0, 'value:', data.amount0);
            console.log('Raw amount1 type:', typeof data.amount1, 'value:', data.amount1);
            
            // Convert values to numbers using safer method
            const amount0 = this.safeConvertToNumber(data.amount0);
            const amount1 = this.safeConvertToNumber(data.amount1);
            
            console.log(`Converted amounts - amount0: ${amount0}, amount1: ${amount1}`);
            
            // Determine which token was bought and which was sold
            let boughtTokenAddress: string;
            let soldTokenAddress: string;
            let boughtAmount: number;
            let soldAmount: number;
            
            if (amount0 > 0 && amount1 < 0) {
                // Token0 was bought with Token1
                boughtTokenAddress = data.token0Address;
                soldTokenAddress = data.token1Address;
                boughtAmount = amount0;
                soldAmount = Math.abs(amount1); // Convert negative to positive
                console.log(`Buy direction: Bought ${boughtTokenAddress} with ${soldTokenAddress}`);
            } else if (amount0 < 0 && amount1 > 0) {
                // Token1 was bought with Token0
                boughtTokenAddress = data.token1Address;
                soldTokenAddress = data.token0Address;
                boughtAmount = amount1;
                soldAmount = Math.abs(amount0); // Convert negative to positive
                console.log(`Buy direction: Bought ${boughtTokenAddress} with ${soldTokenAddress}`);
            } else {
                console.log('Not a standard buy/sell swap (maybe add/remove liquidity):', { amount0, amount1 });
                return null;
            }
            
            // Get token information
            console.log(`Fetching token details - bought: ${boughtTokenAddress}, sold: ${soldTokenAddress}`);
            const boughtTokenInfo = await this.getTokenDetails(boughtTokenAddress);
            const soldTokenInfo = await this.getTokenDetails(soldTokenAddress);
            
            if (!boughtTokenInfo || !soldTokenInfo) {
                console.error('Could not fetch token info');
                return null;
            }
            
            console.log('Token info retrieved:', {
                boughtToken: { name: boughtTokenInfo.name, decimals: boughtTokenInfo.decimals },
                soldToken: { name: soldTokenInfo.name, decimals: soldTokenInfo.decimals }
            });
            
            // Convert amounts to human-readable format accounting for decimals
            const boughtAmountFormatted = this.formatTokenAmount(boughtAmount, boughtTokenInfo.decimals);
            const soldAmountFormatted = this.formatTokenAmount(soldAmount, soldTokenInfo.decimals);
            
            console.log('Formatted amounts:', {
                boughtAmountFormatted,
                soldAmountFormatted
            });
            
            // Get price of WBNB in USD
            const priceData = await getPrice();
            console.log('WBNB price data:', priceData);
            
            const wbnbPrice = priceData?.price_usd || 0;
            console.log(`WBNB price: $${wbnbPrice}`);
            
            // Calculate dollar amount
            let spentDollars = 0;
            if (soldTokenAddress.toLowerCase() === WBNB.toLowerCase()) {
                spentDollars = soldAmountFormatted * wbnbPrice;
            } else {
                // If sold token is not WBNB, we would need to get its price
                // This implementation is simplified and assumes sold token is WBNB
                spentDollars = soldAmountFormatted; // Placeholder, would need price
            }
            console.log(`Spent dollars: $${spentDollars}`);
            
            // Calculate token price from swap
            const tokenPrice = spentDollars / boughtAmountFormatted;
            console.log(`Token price: $${tokenPrice}`);
            
            // Calculate marketcap (simplified)
            const totalSupplyInTokens = parseFloat(boughtTokenInfo.totalSupply) / (10 ** boughtTokenInfo.decimals);
            const marketcap = totalSupplyInTokens * tokenPrice;
            console.log(`Market cap: $${marketcap}`);
            
            // Create BuyMessageData object
            const buyMessage: BuyMessageData = {
                spentToken: {
                    address: soldTokenAddress,
                    name: soldTokenInfo.name,
                    symbol: soldTokenInfo.symbol,
                    amount: soldAmountFormatted,
                    priceUSD: soldTokenAddress.toLowerCase() === WBNB.toLowerCase() ? wbnbPrice : 0,
                    pricePairToken: soldAmountFormatted / boughtAmountFormatted
                },
                gotToken: {
                    address: boughtTokenAddress,
                    name: boughtTokenInfo.name,
                    symbol: boughtTokenInfo.symbol,
                    amount: boughtAmountFormatted,
                    priceUSD: tokenPrice,
                    pricePairToken: boughtAmountFormatted / soldAmountFormatted
                },
                holderWallet: data.recipient,
                pairAddress: poolAddress,
                spentDollars: spentDollars,
                holderIncrease: '0',
                marketcap: marketcap,
                dex: 'PancakeSwapV3'
            };
            
            console.log('Created buy message data:', buyMessage);
            return buyMessage;
        } catch (error) {
            console.error('Error processing swap event:', error);
            return null;
        }
    }
    
    /**
     * Process a PancakeSwap V2 swap event and convert it to BuyMessageData format
     */
    public async processSwapEventV2(poolAddress: string, data: any): Promise<BuyMessageData | null> {
        try {
            console.log('Processing V2 swap event data:', data);
            
            // First, validate that we have the necessary fields
            if (!data || !data.token0Address || !data.token1Address) {
                console.error('V2 swap missing token addresses:', data);
                return null;
            }
            
            // Extract and normalize the amounts with better safety
            const amount0In = this.safeConvertToNumber(data.amount0In);
            const amount1In = this.safeConvertToNumber(data.amount1In);
            const amount0Out = this.safeConvertToNumber(data.amount0Out);
            const amount1Out = this.safeConvertToNumber(data.amount1Out);
            
            console.log(`Normalized V2 amounts - in: [${amount0In}, ${amount1In}], out: [${amount0Out}, ${amount1Out}]`);
            
            // We need to determine the buy direction
            // In PancakeSwap V2, trades are identified by:
            // - amount0In > 0 && amount1Out > 0: selling token0 for token1 (buying token1)
            // - amount1In > 0 && amount0Out > 0: selling token1 for token0 (buying token0)
            
            let boughtTokenAddress: string;
            let soldTokenAddress: string;
            let boughtAmount: number;
            let soldAmount: number;
            
            if (amount0In > 0 && amount1Out > 0) {
                // Token0 was sold to buy Token1
                soldTokenAddress = data.token0Address;
                boughtTokenAddress = data.token1Address;
                soldAmount = amount0In;
                boughtAmount = amount1Out;
                console.log(`V2 buy direction: Sold ${soldTokenAddress} (token0) for ${boughtTokenAddress} (token1)`);
            } else if (amount1In > 0 && amount0Out > 0) {
                // Token1 was sold to buy Token0
                soldTokenAddress = data.token1Address;
                boughtTokenAddress = data.token0Address;
                soldAmount = amount1In;
                boughtAmount = amount0Out;
                console.log(`V2 buy direction: Sold ${soldTokenAddress} (token1) for ${boughtTokenAddress} (token0)`);
            } else {
                console.log(`V2 swap doesn't look like a standard buy. Amounts: in0=${amount0In}, in1=${amount1In}, out0=${amount0Out}, out1=${amount1Out}`);
                
                // Try one more approach - check which amounts are largest
                if (amount0Out > amount1Out && amount1In > amount0In) {
                    // More likely getting token0 by spending token1
                    soldTokenAddress = data.token1Address;
                    boughtTokenAddress = data.token0Address;
                    soldAmount = amount1In;
                    boughtAmount = amount0Out;
                    console.log(`V2 fallback direction: Sold ${soldTokenAddress} for ${boughtTokenAddress}`);
                } else if (amount1Out > amount0Out && amount0In > amount1In) {
                    // More likely getting token1 by spending token0
                    soldTokenAddress = data.token0Address;
                    boughtTokenAddress = data.token1Address;
                    soldAmount = amount0In;
                    boughtAmount = amount1Out;
                    console.log(`V2 fallback direction: Sold ${soldTokenAddress} for ${boughtTokenAddress}`);
                } else {
                    console.log('Could not determine V2 swap direction, may be add/remove liquidity');
                    return null;
                }
            }
            
            // Get token information for both tokens
            console.log(`Fetching token details - bought: ${boughtTokenAddress}, sold: ${soldTokenAddress}`);
            const boughtTokenInfo = await this.getTokenDetails(boughtTokenAddress);
            const soldTokenInfo = await this.getTokenDetails(soldTokenAddress);
            
            if (!boughtTokenInfo || !soldTokenInfo) {
                console.error('Could not fetch token info for one or both tokens');
                return null;
            }
            
            console.log('Token info retrieved:', {
                boughtToken: { 
                    name: boughtTokenInfo.name, 
                    symbol: boughtTokenInfo.symbol,
                    decimals: boughtTokenInfo.decimals 
                },
                soldToken: { 
                    name: soldTokenInfo.name, 
                    symbol: soldTokenInfo.symbol,
                    decimals: soldTokenInfo.decimals 
                }
            });
            
            // Convert amounts to human-readable format accounting for decimals
            const boughtAmountFormatted = this.formatTokenAmount(boughtAmount, boughtTokenInfo.decimals);
            const soldAmountFormatted = this.formatTokenAmount(soldAmount, soldTokenInfo.decimals);
            
            console.log('Formatted amounts:', {
                boughtAmountFormatted,
                soldAmountFormatted
            });
            
            // Get price of WBNB in USD
            const priceData = await getPrice();
            console.log('WBNB price data:', priceData);
            
            const wbnbPrice = priceData?.price_usd || 0;
            console.log(`WBNB price: $${wbnbPrice}`);
            
            // Calculate dollar amount
            let spentDollars = 0;
            if (soldTokenAddress.toLowerCase() === WBNB.toLowerCase()) {
                spentDollars = soldAmountFormatted * wbnbPrice;
            } else {
                spentDollars = soldAmountFormatted;
            }
            console.log(`Spent dollars: $${spentDollars}`);
            
            // Calculate token price from swap
            const tokenPrice = spentDollars / boughtAmountFormatted;
            console.log(`Token price: $${tokenPrice}`);
            
            // Calculate marketcap (simplified)
            const totalSupplyInTokens = parseFloat(boughtTokenInfo.totalSupply) / (10 ** boughtTokenInfo.decimals);
            const marketcap = totalSupplyInTokens * tokenPrice;
            console.log(`Market cap: $${marketcap}`);
            
            // Create BuyMessageData object in the same format as processSwapEvent
            const buyMessage: BuyMessageData = {
                spentToken: {
                    address: soldTokenAddress,
                    name: soldTokenInfo.name,
                    symbol: soldTokenInfo.symbol,
                    amount: soldAmountFormatted,
                    priceUSD: soldTokenAddress.toLowerCase() === WBNB.toLowerCase() ? wbnbPrice : 0,
                    pricePairToken: soldAmountFormatted / boughtAmountFormatted
                },
                gotToken: {
                    address: boughtTokenAddress,
                    name: boughtTokenInfo.name,
                    symbol: boughtTokenInfo.symbol,
                    amount: boughtAmountFormatted,
                    priceUSD: tokenPrice,
                    pricePairToken: boughtAmountFormatted / soldAmountFormatted
                },
                holderWallet: data.to,
                pairAddress: poolAddress,
                spentDollars: spentDollars,
                holderIncrease: '0', // Placeholder, would need additional data to calculate
                marketcap: marketcap,
                dex: 'PancakeSwapV2' // Indicate this is from PancakeSwap V2
            };
            
            console.log('Created buy message data:', buyMessage);
            return buyMessage;
        } catch (error) {
            console.error('Error processing V2 swap event:', error);
            return null;
        }
    }
    
    /**
     * Get token details either from DB or blockchain
     */
    private async getTokenDetails(tokenAddress: string) {
        // First try to get from DB
        const dbInfo = await getTokenInfoFromDB(tokenAddress);
        if (dbInfo) {
            return dbInfo;
        }
        
        // If not in DB, fetch from blockchain
        try {
            const tokenInfo = await this.commonWeb3.getTokenInfo(tokenAddress);
            return tokenInfo;
        } catch (error) {
            console.error(`Failed to get token info for ${tokenAddress}:`, error);
            return null;
        }
    }
    
    /**
     * Format token amount based on decimals
     */
    private formatTokenAmount(amount: number, decimals: number): number {
        return amount / (10 ** decimals);
    }
    
    /**
     * Convert hex value to number, handling negative values properly
     */
    private convertHexValue(hexValue: any): number {
        try {
            // First ensure we're working with a string
            if (hexValue === null || hexValue === undefined) {
                console.warn('Null or undefined hexValue provided to convertHexValue');
                return 0;
            }
            
            // Convert to string if it's not already
            const hexString = String(hexValue);
            console.log('In convertHexValue - converted to string:', hexString);
            
            // Ensure it's a proper hex string
            const properHexString = hexString.startsWith('0x') ? hexString : '0x' + hexString;
            
            // Check for zero values
            if (properHexString === '0x' || properHexString === '0x0') {
                return 0;
            }
            
            // Check if it's a negative value (first bit is 1)
            const isNegative = properHexString.length >= 3 && 
                              parseInt(properHexString.substring(2, 3), 16) >= 8;
            
            if (isNegative) {
                // Calculate two's complement
                const complement = (BigInt(properHexString) ^ ((BigInt(1) << BigInt(256)) - BigInt(1))) + BigInt(1);
                return -Number(complement);
            } else {
                // Positive number
                return Number(BigInt(properHexString));
            }
        } catch (error) {
            console.error('Error converting hex value:', error, 'hexValue:', hexValue);
            return 0;
        }
    }

    /**
     * Helper function to safely normalize any amount to a number
     */
    private normalizeAmount(value: any): number {
        if (value === undefined || value === null) {
            return 0;
        }
        
        try {
            // Handle different types
            if (typeof value === 'string') {
                // Remove any non-numeric characters for safety
                const numericValue = value.replace(/[^\d.-]/g, '');
                return parseFloat(numericValue) || 0;
            } else if (typeof value === 'number') {
                return value;
            } else if (typeof value === 'bigint') {
                return Number(value);
            } else if (typeof value === 'object') {
                // Handle BN or similar objects with toString
                const str = String(value);
                return parseFloat(str) || 0;
            }
            return 0;
        } catch (error) {
            console.error('Error normalizing amount:', error);
            return 0;
        }
    }

    /**
     * Safe method to convert any value to a number
     */
    private safeConvertToNumber(value: any): number {
        try {
            console.log('Converting value to number:', value, 'type:', typeof value);
            
            // Handle null/undefined
            if (value === null || value === undefined) {
                return 0;
            }
            
            // Handle strings - could be hex or decimal
            if (typeof value === 'string') {
                if (value.startsWith('0x')) {
                    return this.convertHexValue(value);
                }
                // Handle negative numbers
                if (value.startsWith('-0x')) {
                    return -this.convertHexValue(value.substring(1)); // Remove the minus sign
                }
                return parseFloat(value) || 0;
            }
            
            // Handle numbers directly
            if (typeof value === 'number') {
                return value;
            }
            
            // Handle BigInt
            if (typeof value === 'bigint') {
                return Number(value);
            }
            
            // Handle objects with toString methods (like BN)
            if (typeof value === 'object' && value !== null) {
                if (value.toString) {
                    const str = value.toString();
                    if (str.startsWith('0x') || str.startsWith('-0x')) {
                        return this.convertHexValue(str);
                    }
                    return parseFloat(str) || 0;
                }
            }
            
            console.warn('Unknown value type, returning 0:', value);
            return 0;
        } catch (error) {
            console.error('Error in safeConvertToNumber:', error);
            return 0;
        }
    }
}
