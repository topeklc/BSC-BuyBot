import fs from 'fs';
import path from 'path';
import {TokenInfo, PoolDetail} from "../types/types";
import Web3 from 'web3';
import { upsertToken, getAllActiveTokens, insertPool, getAllPools, getPoolsForToken } from '../DB/queries';


export const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"; // BSC USDC address

export class CommonWeb3{
    private web3: Web3;
    private tokenAbi: any;
    private poolAbi: any;
    private factory: any;
    private router: any;
    private usdcDecimals: number = 18;
    private factoryV2: any;
    private poolAbiV2: any;

    constructor() {
        this.web3 = new Web3(new Web3.providers.HttpProvider(process.env.HTTPS_WEB3_PROVIDER || ""));
        this.tokenAbi = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','Token.abi'), 'utf-8'));
        const factoryAbi = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','factoryV3.abi'), 'utf-8'));
        this.factory = new this.web3.eth.Contract(factoryAbi, process.env.FACTORY_ADDRESS || "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865");
        this.poolAbi = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','poolV3.abi'), 'utf-8'));
        
        // Initialize router contract
        const routerAbi = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','router.abi'), 'utf-8'));
        this.router = new this.web3.eth.Contract(routerAbi, process.env.ROUTER_ADDRESS || "0x10ED43C718714eb63d5aA57B78B54704E256024E"); // PancakeSwap router
        
        // Load correct V2 ABIs
        const factoryAbiV2 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','factoryV2.abi'), 'utf-8'));
        this.factoryV2 = new this.web3.eth.Contract(factoryAbiV2, process.env.FACTORY_ADDRESS_V2 || "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73");
        
        // Fix: Load the correct PancakeSwap V2 Pair ABI instead of using V3 ABI
        try {
            this.poolAbiV2 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','poolV2.abi'), 'utf-8'));
        } catch (error) {
            console.error("Error loading poolV2.abi, falling back to minimal ABI:", error);
            // Fallback to minimal PancakeSwap V2 pair ABI with just the functions we need
            this.poolAbiV2 = [
                { "inputs": [], "name": "token0", "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function" },
                { "inputs": [], "name": "token1", "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function" }
            ];
        }
    }

    /**
     * Get the price of WBNB in USDC
     * @returns The price of 1 WBNB in USDC
     */
    public async getMainPrice(): Promise<number> {
        try {
            // Convert 1 ETH to Wei
            const amount = this.web3.utils.toWei('1', 'ether');
            
            // Get amounts out from router
            const amountsOut = await this.router.methods.getAmountsOut(
                amount,
                [WBNB, USDC]
            ).call();
            
            // Calculate price by dividing by USDC decimals
            const price = Number(amountsOut[1]) / (10 ** this.usdcDecimals);
            
            console.log(`Current WBNB price: ${price} USDC`);
            return price;
        } catch (error) {
            console.error("Error getting WBNB price:", error);
            return 0;
        }
    }

    public async getTokenInfo(ca: string): Promise<TokenInfo> {
        try {
            console.log(`Fetching token info for ${ca}`);
            
            // First check if the contract address is valid
            const code = await this.web3.eth.getCode(ca);
            if (code === '0x' || code === '0x0') {
                console.error(`No contract found at address ${ca}`);
                return { address: ca, name: 'Unknown', symbol: 'UNKNOWN', decimals: 18, totalSupply: '0', owner: 'Unknown' };
            }
            
            // Create contract instance with proper error handling
            const tokenContract = new this.web3.eth.Contract(this.tokenAbi, ca);
            
            // Get each property with individual try-catch
            let name = 'Unknown', symbol = 'UNKNOWN', decimals = 18, totalSupply = '0', owner = 'Unknown';
            
            try {
                name = await tokenContract.methods.name().call();
                console.log(`Token name: ${name}`);
            } catch (err) {
                console.error(`Failed to get name for ${ca}:`, err);
            }
            
            try {
                symbol = await tokenContract.methods.symbol().call();
                console.log(`Token symbol: ${symbol}`);
            } catch (err) {
                console.error(`Failed to get symbol for ${ca}:`, err);
            }
            
            try {
                decimals = await tokenContract.methods.decimals().call();
                console.log(`Token decimals: ${decimals}`);
            } catch (err) {
                console.error(`Failed to get decimals for ${ca}:`, err);
                // Default to 18 decimals
                decimals = 18;
            }
            
            try {
                totalSupply = await tokenContract.methods.totalSupply().call();
                console.log(`Token totalSupply: ${totalSupply}`);
            } catch (err) {
                console.error(`Failed to get totalSupply for ${ca}:`, err);
            }
            
            try {
                owner = await tokenContract.methods.owner().call();
                console.log(`Token owner: ${owner}`);
            } catch (err) {
                console.error(`Failed to get owner for ${ca} (this is normal for many tokens):`, err);
            }
            
            // Check if we got the minimum required info
            if (!name || !symbol) {
                console.warn('Token info incomplete, using fallback values');
                name = name || `Token_${ca.substring(0, 8)}`;
                symbol = symbol || 'TKN';
            }
            
            const poolAddressesV3 = await this.getPoolAddresses(ca) || [];
            const poolAddressesV2 = await this.getPoolAddressesV2(ca) || [];
            const poolAddresses = poolAddressesV3.concat(poolAddressesV2);
            
            console.log(`Token info complete: ${name} (${symbol}) - ${ca} - ${decimals} decimals - ${totalSupply} total supply - ${owner}`);
            
            // Save to DB
            await upsertToken({address: ca, decimals, name, symbol, totalSupply, owner, poolAddresses});
            
            return {
                address: ca,
                name,
                symbol,
                decimals,
                totalSupply,
                owner,
                poolAddresses
            };
        } catch (error) {
            console.error(`Failed to get token info for ${ca}:`, error);
            // Retry fetching token info with max 10 retries every 10 seconds
            for (let attempt = 1; attempt <= 10; attempt++) {
                try {
                    return await this.getTokenInfo(ca);
                } catch (retryError) {
                    console.error(`Retry ${attempt}/10 failed for ${ca}:`, retryError);
                    if (attempt < 10) {
                        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 10 seconds before retrying
                    }
                }
            }
            console.error(`Failed to get token info for ${ca} after 10 retries`);
            return  { address: ca, name: 'Unknown', symbol: 'UNKNOWN', decimals: 18, totalSupply: '0', owner: 'Unknown' };
        }
    }
    public async getPoolAddressesV2(ca: string): Promise<string[]> {
        var poolAddresses: string[] = [];
        const mainTokens = [WBNB];
        mainTokens.forEach(async (token) => {
            try {

                const poolAddress = await this.factoryV2.methods.getPair(ca, token).call();
                // Only add non-zero addresses
                if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
                    poolAddresses.push(poolAddress);
        } else {
            const poolAddress = await this.factoryV2.methods.getPair(token, ca).call();
            if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
                poolAddresses.push(poolAddress);}
        }
    } catch (error) {
        console.error("Error getting pool address", error); }
    }
    );
    return poolAddresses;
    }
    public async getPoolDetailsV2(ca: string): Promise<PoolDetail> {
        try {
            console.log(`Fetching V2 pool details for ${ca}`);
            
            // Check if we already have this pool in the database
            const cachedPools = await getPoolsForToken(ca);
            const cachedPool = cachedPools.find(pool => pool.address.toLowerCase() === ca.toLowerCase());
            
            if (cachedPool) {
                console.log(`Found cached V2 pool details for ${ca}`);
                return {
                    address: cachedPool.address,
                    token0_address: cachedPool.token0,
                    token1_address: cachedPool.token1,
                    fee: cachedPool.fee,
                    tickSpacing: cachedPool.tickSpacing,
                    version: cachedPool.version
                };
            }
            
            // If not in database, proceed with blockchain calls
            console.log(`No cached data found, fetching V2 pool details from blockchain for ${ca}`);
            
            // Check if the contract address is valid
            const code = await this.web3.eth.getCode(ca);
            if (code === '0x' || code === '0x0') {
                throw new Error(`No contract found at address ${ca}`);
            }
            
            // Create contract with proper V2 pool ABI
            const poolContract = new this.web3.eth.Contract(this.poolAbiV2, ca);
            
            // Get each property with individual try-catch
            let token0, token1;
            
            try {
                token0 = String(await poolContract.methods.token0().call());
                console.log(`Pool ${ca} token0: ${token0}`);
            } catch (err) {
                console.error(`Failed to get token0 for pool ${ca}:`, err);
                throw new Error(`Invalid pool contract at ${ca}: missing token0`);
            }
            
            try {
                token1 = String(await poolContract.methods.token1().call());
                console.log(`Pool ${ca} token1: ${token1}`);
            } catch (err) {
                console.error(`Failed to get token1 for pool ${ca}:`, err);
                throw new Error(`Invalid pool contract at ${ca}: missing token1`);
            }
            
            // For V2 pools, hardcode fee and tickSpacing since they're not part of the contract
            const fee = 2500; // 0.25%
            const tickSpacing = 0;
            
            // Always set version to 2 for this method - V2 pools
            const version = 2;
            
            console.log(`Pool details complete for ${ca}: Token0=${token0}, Token1=${token1}, Fee=${fee}, TickSpacing=${tickSpacing}, Version=${version}`);
            
            return {
                address: ca,
                token0_address: token0,
                token1_address: token1,
                fee,
                tickSpacing,
                version
            };
        } catch (error) {
            console.error(`Failed to get V2 pool details for ${ca}:`, error);
            throw error;
        }
    }
    public async getPoolAddresses(ca: string): Promise<string[]> {
        const bips = [100, 500, 2500, 10000]; //0.01%, 0.05%, 0.25%, or 1%
        var poolAddresses: string[] = [];
            try {
                for (let i = 0; i < bips.length; i++) {
                    const poolAddress = await this.factory.methods.getPool(ca, WBNB, bips[i]).call();
                    // Only add non-zero addresses
                    if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
                        poolAddresses.push(poolAddress);
                    }
                }
                return poolAddresses;
            } catch (error) {
                console.error("Error getting pool address", error);
                return [];
            }
    }

    public async getPoolDetails(ca: string): Promise<PoolDetail> {
        try {
            console.log(`Fetching V3 pool details for ${ca}`);
            
            // Check if we already have this pool in the database
            const cachedPools = await getPoolsForToken(ca);
            const cachedPool = cachedPools.find(pool => pool.address.toLowerCase() === ca.toLowerCase());
            
            if (cachedPool) {
                console.log(`Found cached V3 pool details for ${ca}`);
                return {
                    address: cachedPool.address,
                    token0_address: cachedPool.token0,
                    token1_address: cachedPool.token1,
                    fee: cachedPool.fee,
                    tickSpacing: cachedPool.tickSpacing,
                    version: cachedPool.version
                };
            }
            
            // If not in database, proceed with blockchain calls
            console.log(`No cached data found, fetching V3 pool details from blockchain for ${ca}`);
            
            // Check if the contract address is valid
            const code = await this.web3.eth.getCode(ca);
            if (code === '0x' || code === '0x0') {
                throw new Error(`No contract found at address ${ca}`);
            }
            
            const poolContract = new this.web3.eth.Contract(this.poolAbi, ca);
            
            // Get each property with individual try-catch
            let token0, token1, fee, tickSpacing;
            
            try {
                token0 = String(await poolContract.methods.token0().call());
                console.log(`Pool ${ca} token0: ${token0}`);
            } catch (err) {
                console.error(`Failed to get token0 for pool ${ca}:`, err);
                throw new Error(`Invalid pool contract at ${ca}: missing token0`);
            }
            
            try {
                token1 = String(await poolContract.methods.token1().call());
                console.log(`Pool ${ca} token1: ${token1}`);
            } catch (err) {
                console.error(`Failed to get token1 for pool ${ca}:`, err);
                throw new Error(`Invalid pool contract at ${ca}: missing token1`);
            }
            
            try {
                fee = Number(await poolContract.methods.fee().call());
                console.log(`Pool ${ca} fee: ${fee}`);
            } catch (err) {
                console.error(`Failed to get fee for pool ${ca}:`, err);
                fee = 0; // Default
            }
            
            try {
                tickSpacing = Number(await poolContract.methods.tickSpacing().call());
                console.log(`Pool ${ca} tickSpacing: ${tickSpacing}`);
            } catch (err) {
                console.error(`Failed to get tickSpacing for pool ${ca}:`, err);
                tickSpacing = 0; // Default
            }
            
            // Always set version to 3 for this method - V3 pools
            const version = 3;
            
            console.log(`Pool details complete for ${ca}: Token0=${token0}, Token1=${token1}, Fee=${fee}, TickSpacing=${tickSpacing}, Version=${version}`);
            
            return {
                address: ca,
                token0_address: token0,
                token1_address: token1,
                fee,
                tickSpacing,
                version
            };
        } catch (error) {
            console.error(`Failed to get pool details for ${ca}:`, error);
            throw error;
        }
    }

    public async runPoolsManager() {
        console.log('Starting pools manager...');
        
        // Run once immediately on startup
        try {
            const activeTokens = await getAllActiveTokens();
            console.log(`Running pool manager for ${activeTokens.length} active tokens`);
            
            for (const token of activeTokens) {
                try {
                    await this.updatePools(token);
                } catch (error) {
                    console.error(`Error updating pools for token ${token}:`, error);
                    // Continue with other tokens even if one fails
                }
            }
        } catch (error) {
            console.error("Error in initial pools manager run:", error);
        }
        
        // Then set up the interval
        setInterval(async () => {
            try {
                console.log('Running periodic pool update check...');
                const activeTokens = await getAllActiveTokens();
                
                for (const token of activeTokens) {
                    try {
                        
                        await this.updatePools(token);
                    } catch (error) {
                        console.error(`Error updating pools for token ${token}:`, error);
                        // Continue with other tokens even if one fails
                    }
                }
            } catch (error) {
                console.error("Error running pools manager:", error);
            }
        }, 60000 * 5); // Run every 5 minutes
    }

    public async updatePools(ca: string) {
        try {
            const poolAddressesV2 = await this.getPoolAddressesV2(ca);
            const poolAddressesV3 = await this.getPoolAddresses(ca);
            const allPools = await getAllPools(ca);
            
            // Log the count of pools found
            console.log(`Found ${poolAddressesV3.length} pools for token ${ca}`);
            
            // Process each valid pool address
            for (const poolAddress of poolAddressesV3) {
                try {
                    // Skip if already in database
                    if (allPools.some(pool => pool.address === poolAddress)) {
                        console.log(`Pool ${poolAddress} already exists in database, skipping`);
                        continue;
                    }
                    
                    // Extra safety check - skip zero addresses
                    if (!poolAddress || poolAddress === '0x0000000000000000000000000000000000000000') {
                        console.log(`Skipping invalid pool address: ${poolAddress}`);
                        continue;
                    }
                    
                    // Get pool details and insert into database
                    console.log(`Processing new pool: ${poolAddress}`);
                    const poolDetails = await this.getPoolDetails(poolAddress);
                    
                    // Add extra validation before insertion
                    if (!poolDetails || !poolDetails.token0_address || !poolDetails.token1_address) {
                        console.error(`Invalid pool details for ${poolAddress}, skipping`);
                        continue;
                    }
                    
                    // Verify that version is explicitly set
                    if (poolDetails.version === undefined || poolDetails.version === null) {
                        console.error(`Pool ${poolAddress} has no version set, skipping`);
                        continue;
                    }
                    
                    console.log(`Pool ${poolAddress} validation passed, inserting with version ${poolDetails.version}`);
                    await insertPool(poolDetails);
                } catch (error) {
                    // Catch errors for individual pools to prevent the whole process from failing
                    console.error(`Error processing pool ${poolAddress}:`, error);
                }
            }

            for (const poolAddress of poolAddressesV2) {
                try {
                    // Skip if already in database
                    if (allPools.some(pool => pool.address === poolAddress)) {
                        console.log(`Pool ${poolAddress} already exists in database, skipping`);
                        continue;
                    }
                    
                    // Extra safety check - skip zero addresses
                    if (!poolAddress || poolAddress === '0x0000000000000000000000000000000000000000') {
                        console.log(`Skipping invalid pool address: ${poolAddress}`);
                        continue;
                    }
                    
                    // Get pool details and insert into database
                    console.log(`Processing new pool: ${poolAddress}`);
                    const poolDetails = await this.getPoolDetailsV2(poolAddress);
                    
                    // Add extra validation before insertion
                    if (!poolDetails || !poolDetails.token0_address || !poolDetails.token1_address) {
                        console.error(`Invalid pool details for ${poolAddress}, skipping`);
                        continue;
                    }
                    
                    // Verify that version is explicitly set
                    if (poolDetails.version === undefined || poolDetails.version === null) {
                        console.error(`Pool ${poolAddress} has no version set, skipping`);
                        continue;
                    }
                    
                    console.log(`Pool ${poolAddress} validation passed, inserting with version ${poolDetails.version}`);
                    await insertPool(poolDetails);
                } catch (error) {
                    // Catch errors for individual pools to prevent the whole process from failing
                    console.error(`Error processing pool ${poolAddress}:`, error);
                }
            }
        } catch (error) {
            console.error(`Error in updatePools for ${ca}:`, error);
        }
    }
}
