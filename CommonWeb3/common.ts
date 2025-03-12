import fs from 'fs';
import path from 'path';
import {TokenInfo, PoolDetail} from "../types/types";
import Web3 from 'web3';
import { upsertToken, getAllActiveTokens, insertPool, getAllPools, getPoolsForToken } from '../DB/queries';


export const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"; // BSC USDC address

export class CommonWeb3{
    private web3!: Web3;
    private tokenAbi: any;
    private poolAbi: any;
    private factory: any;
    private router: any;
    private usdcDecimals: number = 18;
    private factoryV2: any;
    private poolAbiV2: any;
    
    // List of RPC providers to use as fallbacks
    private providers: string[] = [];
    private currentProviderIndex: number = 0;
    private maxRetries: number = 3;

    constructor() {
        // Initialize providers list with the main provider first
        this.providers = [
            process.env.HTTPS_WEB3_PROVIDER || "",
            process.env.BACKUP_WEB3_PROVIDER1 || "https://bsc-rpc.publicnode.com",
            process.env.BACKUP_WEB3_PROVIDER2 || "https://bsc-mainnet.public.blastapi.io",
        ].filter(provider => provider !== ""); // Filter out empty providers
        
        // Initialize web3 with the first provider
        this.initializeWeb3WithCurrentProvider();
        
        // Load ABIs
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
        } catch (error: any) {
            console.error("Error loading poolV2.abi, falling back to minimal ABI:", error);
            // Fallback to minimal PancakeSwap V2 pair ABI with just the functions we need
            this.poolAbiV2 = [
                { "inputs": [], "name": "token0", "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function" },
                { "inputs": [], "name": "token1", "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function" }
            ];
        }
    }
    
    /**
     * Initialize Web3 with the current provider
     */
    private initializeWeb3WithCurrentProvider(): void {
        const provider = this.providers[this.currentProviderIndex];
        console.log(`Initializing Web3 with provider ${this.currentProviderIndex + 1}/${this.providers.length}: ${provider}`);
        
        try {
            this.web3 = new Web3(new Web3.providers.HttpProvider(provider));
            
            // Reinitialize contracts with the new Web3 instance if they exist
            if (this.factory) {
                const factoryAbi = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','factoryV3.abi'), 'utf-8'));
                this.factory = new this.web3.eth.Contract(factoryAbi, process.env.FACTORY_ADDRESS || "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865");
            }
            
            if (this.router) {
                const routerAbi = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','router.abi'), 'utf-8'));
                this.router = new this.web3.eth.Contract(routerAbi, process.env.ROUTER_ADDRESS || "0x10ED43C718714eb63d5aA57B78B54704E256024E");
            }
            
            if (this.factoryV2) {
                const factoryAbiV2 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','factoryV2.abi'), 'utf-8'));
                this.factoryV2 = new this.web3.eth.Contract(factoryAbiV2, process.env.FACTORY_ADDRESS_V2 || "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73");
            }
        } catch (error: any) {
            console.error(`Failed to initialize Web3 with provider ${provider}:`, error);
            // If initialization fails, try the next provider
            this.switchToNextProvider();
        }
    }
    
    /**
     * Switch to the next provider in the list
     * @returns true if switched successfully, false if no more providers available
     */
    private switchToNextProvider(): boolean {
        if (this.currentProviderIndex < this.providers.length - 1) {
            this.currentProviderIndex++;
            this.initializeWeb3WithCurrentProvider();
            return true;
        } else {
            // Reset to the first provider for next time
            this.currentProviderIndex = 0;
            console.error("All providers have been tried and failed");
            return false;
        }
    }
    
    /**
     * Execute a Web3 method with automatic provider switching on failure
     * @param operation Function that performs the Web3 operation
     * @param methodName Name of the method for logging
     * @param retries Number of retries left
     * @returns Result of the operation
     */
    private async executeWithProviderFailover<T>(operation: () => Promise<T>, methodName: string, retries: number = this.maxRetries): Promise<T> {
        try {
            return await operation();
        } catch (error: any) {
            console.error(`Error in ${methodName}:`, error);
            
            // If we have retries left, try switching provider and retry
            if (retries > 0 && this.switchToNextProvider()) {
                console.log(`Retrying ${methodName} with new provider. Retries left: ${retries-1}`);
                return this.executeWithProviderFailover(operation, methodName, retries - 1);
            } else {
                // No more retries or providers, throw the error
                throw error;
            }
        }
    }

    /**
     * Get the price of WBNB in USDC
     * @returns The price of 1 WBNB in USDC
     */
    public async getMainPrice(): Promise<number> {
        return this.executeWithProviderFailover(async () => {
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
        }, 'getMainPrice').catch((error: any) => {
            console.error("All provider attempts failed getting WBNB price:", error);
            return 0;
        });
    }
    
    /**
     * Get the balance of a token for a specific holder address
     * @param tokenAddress The token contract address
     * @param holderAddress The address holding the tokens
     * @returns The token balance as a number, or undefined if an error occurs
     */
    public async getBalanceOf(tokenAddress: string, holderAddress: string): Promise<number | undefined> {
        return this.executeWithProviderFailover(async () => {
            const tokenContract = new this.web3.eth.Contract(this.tokenAbi, tokenAddress);
            const balance = Number(await tokenContract.methods.balanceOf(holderAddress).call());
            return balance;
        }, `getBalanceOf(${tokenAddress}, ${holderAddress})`).catch((error: any) => {
            console.error(`All provider attempts failed getting balance for ${holderAddress} of token ${tokenAddress}:`, error);
            return undefined;
        });
    }
    
    /**
     * Get detailed information about a token
     * @param ca The token contract address
     * @returns TokenInfo object containing token details
     */
    public async getTokenInfo(ca: string): Promise<TokenInfo> {
        return this.executeWithProviderFailover(async () => {
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
        }, `getTokenInfo(${ca})`).catch(async (error: any) => {
            console.error(`Failed to get token info for ${ca} after trying all providers:`, error);
            // Return default values after all providers have been tried
            return { address: ca, name: 'Unknown', symbol: 'UNKNOWN', decimals: 18, totalSupply: '0', owner: 'Unknown', poolAddresses: [] };
        });
    }

    /**
     * Get V2 pool addresses for a token
     * @param ca The token contract address
     * @returns Array of pool addresses
     */
    public async getPoolAddressesV2(ca: string): Promise<string[]> {
        return this.executeWithProviderFailover(async () => {
            const poolAddresses: string[] = [];
            const mainTokens = [WBNB];
            
            // Use Promise.all to properly wait for all async operations
            await Promise.all(mainTokens.map(async (token) => {
                try {
                    const poolAddress = await this.factoryV2.methods.getPair(ca, token).call();
                    // Only add non-zero addresses
                    if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
                        poolAddresses.push(poolAddress);
                    } else {
                        const reversedPoolAddress = await this.factoryV2.methods.getPair(token, ca).call();
                        if (reversedPoolAddress && reversedPoolAddress !== '0x0000000000000000000000000000000000000000') {
                            poolAddresses.push(reversedPoolAddress);
                        }
                    }
                } catch (error) {
                    console.error(`Error getting pool address for ${ca} and ${token}:`, error);
                }
            }));
            
            return poolAddresses;
        }, `getPoolAddressesV2(${ca})`).catch((error: any) => {
            console.error(`All provider attempts failed getting pool addresses V2 for ${ca}:`, error);
            return [];
        });
    }
    /**
     * Get detailed information about a V2 pool
     * @param ca The pool contract address
     * @returns PoolDetail object containing pool information
     */
    public async getPoolDetailsV2(ca: string): Promise<PoolDetail> {
        return this.executeWithProviderFailover(async () => {
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
        }, `getPoolDetailsV2(${ca})`).catch((error: any) => {
            console.error(`All provider attempts failed getting V2 pool details for ${ca}:`, error);
            throw error;
        });
    }

    /**
     * Get V3 pool addresses for a token
     * @param ca The token contract address
     * @returns Array of pool addresses
     */
    public async getPoolAddresses(ca: string): Promise<string[]> {
        return this.executeWithProviderFailover(async () => {
            const bips = [100, 500, 2500, 10000]; //0.01%, 0.05%, 0.25%, or 1%
            const poolAddresses: string[] = [];
            
            for (let i = 0; i < bips.length; i++) {
                const poolAddress = await this.factory.methods.getPool(ca, WBNB, bips[i]).call();
                // Only add non-zero addresses
                if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
                    poolAddresses.push(poolAddress);
                }
            }
            return poolAddresses;
        }, `getPoolAddresses(${ca})`).catch((error: any) => {
            console.error(`All provider attempts failed getting pool addresses for ${ca}:`, error);
            return [];
        });
    }

    /**
     * Get detailed information about a V3 pool
     * @param ca The pool contract address
     * @returns PoolDetail object containing pool information
     */
    public async getPoolDetails(ca: string): Promise<PoolDetail> {
        return this.executeWithProviderFailover(async () => {
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
        }, `getPoolDetails(${ca})`).catch(error => {
            console.error(`All provider attempts failed getting pool details for ${ca}:`, error);
            throw error;
        });
    }

    /**
     * Run the pools manager to periodically update pool information
     */
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

    /**
     * Update pools for a specific token
     * @param ca The token contract address
     */
    public async updatePools(ca: string) {
        try {
            const poolAddressesV2 = await this.getPoolAddressesV2(ca);
            const poolAddressesV3 = await this.getPoolAddresses(ca);
            const allPools = await getAllPools(ca);
            
            // Track newly inserted pools to update group configs later
            const newlyInsertedPools: string[] = [];
            
            // Log the count of pools found
            console.log(`Found ${poolAddressesV3.length} V3 pools and ${poolAddressesV2.length} V2 pools for token ${ca}`);
            
            // Process each valid V3 pool address
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
                    
                    // Add to newly inserted pools list
                    newlyInsertedPools.push(poolAddress);
                    
                } catch (error) {
                    // Catch errors for individual pools to prevent the whole process from failing
                    console.error(`Error processing pool ${poolAddress}:`, error);
                }
            }

            // Process each valid V2 pool address
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
                    
                    // Add to newly inserted pools list
                    newlyInsertedPools.push(poolAddress);
                    
                } catch (error) {
                    // Catch errors for individual pools to prevent the whole process from failing
                    console.error(`Error processing pool ${poolAddress}:`, error);
                }
            }

            // Update group configs with newly inserted pools
            if (newlyInsertedPools.length > 0) {
                await this.updateGroupConfigsWithNewPools(ca, newlyInsertedPools);
            }
        } catch (error) {
            console.error(`Error in updatePools for ${ca}:`, error);
        }
    }

    /**
     * Update all group configurations for a token with newly found pools
     * @param tokenAddress The token address
     * @param newPoolAddresses Array of new pool addresses to add
     */
    public async updateGroupConfigsWithNewPools(tokenAddress: string, newPoolAddresses: string[]): Promise<void> {
        try {
            if (newPoolAddresses.length === 0) return;
            
            console.log(`Updating group configs with ${newPoolAddresses.length} new pools for token ${tokenAddress}`);
            
            // Get all group configurations that use this token
            const { getGroupConfigByField, updateGroupConfig } = await import('../DB/queries');
            const affectedConfigs = await getGroupConfigByField('address', tokenAddress);
            
            console.log(`Found ${affectedConfigs.length} group configs for token ${tokenAddress}`);
            
            // Update each config with the new pools
            for (const config of affectedConfigs) {
                try {
                    // Skip inactive configs
                    if (!config.active) {
                        console.log(`Skipping inactive config for group ${config.group_id}`);
                        continue;
                    }
                    
                    // Get current pools
                    const currentPools = Array.isArray(config.pools) ? config.pools : [];
                    
                    // Check for pools already in the config
                    const newPools = newPoolAddresses.filter(newPool => {
                        // Check if this pool is already in the config
                        return !currentPools.some((existingPool: any) => {
                            if (typeof existingPool === 'string') {
                                try {
                                    // Try parsing as JSON if stored that way
                                    const parsed = JSON.parse(existingPool);
                                    return parsed.address === newPool || parsed.tokenAddress === newPool;
                                } catch {
                                    // If not valid JSON, compare directly
                                    return existingPool === newPool;
                                }
                            }
                            return false;
                        });
                    });
                    
                    if (newPools.length === 0) {
                        console.log(`No new pools to add for group ${config.group_id}`);
                        continue;
                    }
                    
                    console.log(`Adding ${newPools.length} new pools to group ${config.group_id}`);
                    
                    // Add new pools to the config
                    const updatedPools = [...currentPools, ...newPools];
                    await updateGroupConfig(config.group_id, 'pools', updatedPools);
                    
                    console.log(`Successfully updated pools for group ${config.group_id}`);
                } catch (error) {
                    console.error(`Error updating pools for group ${config.group_id}:`, error);
                    // Continue with other configs even if one fails
                }
            }
            
            console.log(`Finished updating group configs with new pools`);
        } catch (error) {
            console.error(`Error updating group configs with new pools:`, error);
        }
    }
}
