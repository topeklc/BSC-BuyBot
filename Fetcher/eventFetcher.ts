import Web3 from 'web3';
import path from 'path';
import fs from 'fs';
import { WebSocketServer } from './websocketServer';
import {CommonWeb3, WBNB} from '../CommonWeb3/common';
import {getAllActiveTokens, getPrice, insertPool, getPoolsForToken, getAllConfigPools} from '../DB/queries';
import { TokenInfo, BuyMessageData, PoolDetail } from '../types';
import Web3WsProvider from 'web3-providers-ws'
import { PoolSwapHandler } from './poolSwapHandler';

const buyTopic = '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942';
const newPoolTopic = '0xc18aa71171b358b706fe3dd345299685ba21a5316c66ffa9e319268b033c44b0';
const swapV3Topic = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83'
const swapV2Topic = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
// Update the WebSocket options to better handle reconnection
const options = {
    timeout: 60000, // Increase timeout to 60 seconds
    clientConfig: {
        maxReceivedFrameSize: 100000000,
        maxReceivedMessageSize: 100000000,
        keepalive: true,
        keepaliveInterval: 30000 // 30 seconds
    },
    // Modify reconnect settings to prevent rapid reconnections
    reconnect: {
        auto: true,
        delay: 10000, // Increase delay between reconnection attempts to 10 seconds
        maxAttempts: 10,
        onTimeout: false // Don't automatically reconnect on timeout
    }
};

class EventFetcher {
    private web3: Web3;
    private fourMemeCA: string;
    private fourMemeContract: any;
    private ws: WebSocketServer;
    private commonWeb3 = new CommonWeb3();
    private subscriptions: any[] = [];
    private isReconnecting = false;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private provider: any;
    private poolSwapHandler: PoolSwapHandler;
    private poolAbiV3: any;
    private poolAbiV2: any;
    private subscriptionMap: Map<string, any> = new Map();
    private recentMessages: Map<string, number> = new Map();
    private readonly MESSAGE_CACHE_TIMEOUT = 60000; // 60 seconds
    private processedTxHashes: Set<string> = new Set();
    
    constructor() {
        this.ws = new WebSocketServer();
        this.initProvider();
        this.fourMemeCA = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
        this.poolSwapHandler = new PoolSwapHandler();
        
        try {
            // Load the V2 factory ABI
            this.poolAbiV2 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','poolV2.abi'), 'utf-8'));
            
            // Load the dedicated V3 pool events ABI file
            try {
                this.poolAbiV3 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','poolV3.abi'), 'utf-8'));
            } catch (error) {
                console.error("Error loading V3 pool events ABI:", error);
                // Define swap event manually if file can't be loaded
                this.poolAbiV3 = [{
                    "anonymous": false,
                    "inputs": [
                        { "indexed": true, "name": "sender", "type": "address" },
                        { "indexed": true, "name": "recipient", "type": "address" },
                        { "indexed": false, "name": "amount0", "type": "int256" },
                        { "indexed": false, "name": "amount1", "type": "int256" },
                        { "indexed": false, "name": "sqrtPriceX96", "type": "uint160" },
                        { "indexed": false, "name": "liquidity", "type": "uint128" },
                        { "indexed": false, "name": "tick", "type": "int24" }
                    ],
                    "name": "Swap",
                    "type": "event"
                }];
            }
        } catch (error) {
            console.error("Error loading ABIs:", error);
            // Provide fallback definitions
            this.poolAbiV3 = [{
                "anonymous": false,
                "inputs": [
                    { "indexed": true, "name": "sender", "type": "address" },
                    { "indexed": true, "name": "recipient", "type": "address" },
                    { "indexed": false, "name": "amount0", "type": "int256" },
                    { "indexed": false, "name": "amount1", "type": "int256" },
                    { "indexed": false, "name": "sqrtPriceX96", "type": "uint160" },
                    { "indexed": false, "name": "liquidity", "type": "uint128" },
                    { "indexed": false, "name": "tick", "type": "int24" }
                ],
                "name": "Swap",
                "type": "event"
            }];
        }
    }
    
    private initProvider() {
        // Clean up any existing provider
        if (this.provider) {
            try {
                this.provider.disconnect();
            } catch (e) {
                console.log('Error disconnecting from previous provider:', e);
            }
        }
        
        console.log('Initializing Web3 WebSocket provider...');
        this.provider = new Web3WsProvider(process.env.WSS_WEB3_PROVIDER || "", options);
        
        // Set up event handlers with better error handling
        this.provider.on("connect", () => {
            console.log("✅ WebSocket provider connected");
            this.isReconnecting = false;
            
            // Initialize Web3 and contract after successful connection
            this.initWeb3();
        });
        
        this.provider.on("close", (event) => {
            console.log("❌ WebSocket provider closed:", event);
            this.handleDisconnect();
        });
        
        this.provider.on("error", (error) => {
            console.error("⚠️ WebSocket provider error:", error);
            this.handleDisconnect();
        });
        
        return this.provider;
    }
    
    private async initWeb3() {
        try {
            console.log('Initializing Web3...');
            // Create a new Web3 instance with the provider
            this.web3 = new Web3(this.provider);
            
            // Load ABI and create contract instance
            const fourMemeAbi = JSON.parse(
                fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi', 'TokenManager2.lite.abi'), 'utf-8')
            );
            this.fourMemeContract = new this.web3.eth.Contract(fourMemeAbi, this.fourMemeCA);
            
            console.log('Web3 initialization complete');
            
            // Set a short delay before establishing subscriptions to ensure the provider is ready
            setTimeout(async () => {
                try {
                    console.log('Establishing subscriptions after reconnect...');
                    await this.subscribeToNewPools();
                    await this.subscribeToBuys();
                    await this.initDBPoolsSubscriptions();
                    console.log(`Successfully established ${this.subscriptions.length} subscriptions`);
                } catch (error) {
                    console.error('Error establishing subscriptions after reconnect:', error);
                }
            }, 2000);
        } catch (error) {
            console.error('Failed to initialize Web3:', error);
            this.handleDisconnect();
        }
    }
    
    private handleDisconnect() {
        if (this.isReconnecting) return;
        this.isReconnecting = true;
        
        console.log('Handling provider disconnect...');
        // Clear subscriptions array - we'll resubscribe after reconnection
        this.subscriptions = [];
        this.subscriptionMap.clear();
        this.recentMessages.clear(); // Clear message cache
        this.processedTxHashes.clear();
        
        // Implement exponential backoff for reconnection attempts
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        
        this.reconnectTimeout = setTimeout(() => {
            console.log('Attempting to reconnect WebSocket provider...');
            this.initProvider();
            this.reconnectTimeout = null;
        }, 15000); // Wait 15 seconds before reconnecting
    }

    public async start() {
        try {
            // Wait for Web3 initialization to complete
            await this.waitForWeb3();
            await this.commonWeb3.runPoolsManager();
            // Start subscriptions - no need to call these here since they're established in initWeb3
            console.log('Starting event subscriptions...');
            
            // Set up subscription monitoring with two phases:
            // 1. Frequent checks initially after startup
            const initialInterval = setInterval(() => {
                this.checkSubscriptions();
                
                // After 5 minutes, switch to less frequent checks
                clearInterval(initialInterval);
                setInterval(() => this.checkSubscriptions(), 5 * 60 * 1000); // Every 5 minutes
            }, 60 * 1000); // Check every 1 minute initially
            
            console.log('EventFetcher started successfully');
        } catch (error) {
            console.error('Error starting EventFetcher:', error);
            this.handleDisconnect();
            throw error;
        }
    }
    
    private async waitForWeb3() {
        // Wait for Web3 to be initialized before proceeding
        let attempts = 0;
        while (!this.web3 && attempts < 10) {
            console.log('Waiting for Web3 initialization...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            attempts++;
        }
        
        if (!this.web3) {
            throw new Error('Web3 initialization timed out');
        }
    }
    
    private async checkSubscriptions() {
        try {
            console.log(`Checking ${this.subscriptions.length} subscriptions...`);
            
            // Check if provider is connected
            if (!this.provider.connected) {
                console.log('Provider disconnected, reconnecting...');
                this.handleDisconnect();
                return;
            }
            
            // Don't try to resubscribe if we're in the middle of reconnecting
            if (this.isReconnecting) {
                console.log('Currently reconnecting, skipping subscription check');
                return;
            }
            
            // Get all pools from active configurations to determine what we should be subscribed to
            const activeConfigPools = await getAllConfigPools();
            const activePoolAddresses = new Set(activeConfigPools.map(pool => pool.address.toLowerCase()));
            
            console.log(`Found ${activePoolAddresses.size} pools in active configurations`);
            
            // Check for subscription health and manage pool subscriptions
            if (this.subscriptions.length === 0) {
                console.log('No active subscriptions, resubscribing to everything...');
                
                // Clear our subscription map to start fresh
                this.subscriptionMap.clear();
                
                await this.subscribeToNewPools();
                await this.subscribeToBuys();
                await this.initDBPoolsSubscriptions();
            } else {
                // Check health of existing subscriptions
                console.log(`Checking health of ${this.subscriptions.length} subscriptions`);
                
                try {
                    await this.web3.eth.getBlockNumber();
                    console.log('Web3 connection is healthy');
                    
                    // Filter for pool subscriptions (V2 and V3)
                    const poolSubscriptions = this.subscriptions.filter(sub => {
                        if (!sub.options || !sub.options.address || !sub.options.topics || !sub.options.topics[0]) {
                            return false;
                        }
                        const topic = sub.options.topics[0];
                        return topic === swapV2Topic || topic === swapV3Topic;
                    });
                    
                    console.log(`Found ${poolSubscriptions.length} pool subscriptions to evaluate`);
                    
                    // Identify pool subscriptions that should be removed
                    const poolsToUnsubscribe = poolSubscriptions.filter(sub => {
                        const address = sub.options.address.toLowerCase();
                        return !activePoolAddresses.has(address);
                    });
                    
                    // Unsubscribe from pools that aren't in active configs
                    if (poolsToUnsubscribe.length > 0) {
                        console.log(`Unsubscribing from ${poolsToUnsubscribe.length} pools no longer in active configurations`);
                        
                        for (const sub of poolsToUnsubscribe) {
                            const address = sub.options.address.toLowerCase();
                            const topic = sub.options.topics[0];
                            const key = `${address}-${topic}`;
                            
                            try {
                                sub.unsubscribe();
                                console.log(`Unsubscribed from pool: ${address}`);
                                
                                // Remove from our tracking
                                this.subscriptionMap.delete(key);
                                const index = this.subscriptions.indexOf(sub);
                                if (index > -1) {
                                    this.subscriptions.splice(index, 1);
                                }
                            } catch (error) {
                                console.error(`Error unsubscribing from pool ${address}:`, error);
                            }
                        }
                    }
                    
                    // Identify new pools that need subscriptions
                    const currentPoolAddresses = new Set(
                        poolSubscriptions.map(sub => sub.options.address.toLowerCase())
                    );
                    
                    const poolsToAdd = activeConfigPools.filter(pool => 
                        !currentPoolAddresses.has(pool.address.toLowerCase())
                    );
                    
                    // Subscribe to new pools
                    if (poolsToAdd.length > 0) {
                        console.log(`Subscribing to ${poolsToAdd.length} new pools from active configurations`);
                        
                        let addedCount = 0;
                        for (const pool of poolsToAdd) {
                            try {
                                if (pool.version === 3) {
                                    await this.subscribeToPool(pool.address);
                                    console.log(`Added subscription to pool V3: ${pool.address}`);
                                    addedCount++;
                                } else if (pool.version === 2) {
                                    await this.subscribeToPoolV2(pool.address);
                                    console.log(`Added subscription to pool V2: ${pool.address}`);
                                    addedCount++;
                                }
                            } catch (error) {
                                console.error(`Error subscribing to pool ${pool.address}:`, error);
                            }
                        }
                        
                        console.log(`Successfully added ${addedCount} new pool subscriptions`);
                    }
                    
                    // Clean up duplicate subscriptions
                    this.cleanupDuplicateSubscriptions();
                    
                } catch (error) {
                    console.error('Web3 connection test failed, reconnecting:', error);
                    this.handleDisconnect();
                    return;
                }
            }
            
            console.log(`Subscription check complete, now tracking ${this.subscriptions.length} subscriptions`);
        } catch (error) {
            console.error('Error checking subscriptions:', error);
        }
    }
    
    /**
     * Helper method to clean up duplicate subscriptions
     */
    private cleanupDuplicateSubscriptions(): void {
        const uniqueKeys = new Set<string>();
        const duplicateKeys = new Set<string>();
        const validSubs: any[] = [];
        
        // Reorganize our subscription tracking
        for (const sub of this.subscriptions) {
            // Extract the key info if available
            if (sub.options && sub.options.address && sub.options.topics && sub.options.topics[0]) {
                const address = sub.options.address.toLowerCase();
                const topic = sub.options.topics[0];
                const key = `${address}-${topic}`;
                
                if (uniqueKeys.has(key)) {
                    console.log(`Found duplicate subscription for ${address} with topic ${topic}`);
                    duplicateKeys.add(key);
                    
                    try {
                        // Keep the existing one in our map and unsubscribe from the duplicate
                        sub.unsubscribe();
                        console.log(`Unsubscribed from duplicate: ${key}`);
                    } catch (unsubError) {
                        console.error(`Error unsubscribing from duplicate: ${unsubError}`);
                    }
                } else {
                    uniqueKeys.add(key);
                    validSubs.push(sub);
                    
                    // Update our subscription map
                    this.subscriptionMap.set(key, sub);
                }
            } else {
                // If we can't identify the subscription, keep it but log a warning
                console.warn('Found subscription without proper identification:', 
                    sub.id || 'unknown');
                validSubs.push(sub);
            }
        }
        
        console.log(`Found ${duplicateKeys.size} duplicate subscriptions`);
        
        // Update our subscriptions array to only include valid ones
        this.subscriptions = validSubs;
        
        console.log(`After cleanup: ${this.subscriptions.length} active subscriptions`);
    }

    private async initDBPoolsSubscriptions() {
        try {
            console.log('Initializing pool subscriptions from active group configs...');
            
            // Get all pools from active group configurations
            const configPools = await getAllConfigPools();
            console.log(`Found ${configPools.length} pools in active group configurations`);
            
            if (configPools.length === 0) {
                console.warn('No pools found in any active group configurations');
                
                // Fall back to token-based subscription as a safety measure
                const activeTokens = await getAllActiveTokens();
                console.log(`Falling back to ${activeTokens.length} active tokens for pool subscriptions`);
                
                if (activeTokens.length === 0) {
                    console.warn('No active tokens found for pool subscriptions');
                    return;
                }
                
                let subscriptionCount = 0;
                
                for (const token of activeTokens) {
                    try {
                        const pools = await getPoolsForToken(token);
                        
                        if (pools.length > 0) {
                            console.log(`Subscribing to ${pools.length} pools for token: ${token}`);
                            
                            for (const pool of pools) {
                                try {
                                    if (pool.version === 3) {
                                        await this.subscribeToPool(pool.address);
                                        console.log(`Subscribed to pool V3: ${pool.pairName} (${pool.address})`);
                                        subscriptionCount++;
                                    }
                                    if (pool.version === 2) {
                                        await this.subscribeToPoolV2(pool.address);
                                        console.log(`Subscribed to pool: ${pool.pairName} (${pool.address})`);
                                        subscriptionCount++;
                                    }
                                } catch (poolError) {
                                    console.error(`Failed to subscribe to pool ${pool.address}:`, poolError);
                                }
                            }
                        } else {
                            console.log(`No pools found for token: ${token}`);
                        }
                    } catch (tokenError) {
                        console.error(`Error processing pools for token ${token}:`, tokenError);
                    }
                }
                
                console.log(`Successfully established ${subscriptionCount} pool subscriptions (token-based)`);
                return;
            }
            
            // Subscribe to each pool from active configurations
            let subscriptionCount = 0;
            
            for (const pool of configPools) {
                try {
                    if (pool.version === 3) {
                        await this.subscribeToPool(pool.address);
                        console.log(`Subscribed to pool V3: ${pool.pairName || pool.address} (${pool.address})`);
                        subscriptionCount++;
                    }
                    if (pool.version === 2) {
                        await this.subscribeToPoolV2(pool.address);
                        console.log(`Subscribed to pool V2: ${pool.pairName || pool.address} (${pool.address})`);
                        subscriptionCount++;
                    }
                } catch (poolError) {
                    console.error(`Failed to subscribe to pool ${pool.address}:`, poolError);
                }
            }
            
            console.log(`Successfully established ${subscriptionCount} pool subscriptions (config-based)`);
        } catch (error) {
            console.error('Error initializing DB pool subscriptions:', error);
        }
    }
    

    private async subscribeToBuys() {
        try {
            console.log('Subscribing to buy events...');
            
            // Check if already subscribed
            const key = `${this.fourMemeCA.toLowerCase()}-${buyTopic}`;
            if (this.subscriptionMap.has(key)) {
                console.log(`Already subscribed to buy events on ${this.fourMemeCA}`);
                return this.subscriptionMap.get(key);
            }
            
            const fourMemeBuySub = await this.web3.eth.subscribe('logs', {
                address: this.fourMemeCA,
                topics: [buyTopic]
            });
            
            // Track this subscription
            this.trackSubscription(fourMemeBuySub, this.fourMemeCA, buyTopic);
            
            fourMemeBuySub.on('data', async (log) => {
                try {
                    console.log('Raw log:', log);
                    
                    const eventAbi = this.fourMemeContract.options.jsonInterface.find(
                        (item: any) => item.signature === log.topics[0]
                    );
                    
                    if (!eventAbi) {
                        console.error('Event ABI not found for signature:', log.topics[0]);
                        return;
                    }
                    
                    const decodedLog = this.web3.eth.abi.decodeLog(eventAbi.inputs, log.data, log.topics.slice(1));
                    console.log('Decoded log:', decodedLog);
                    
                    const activeTokens = await getAllActiveTokens();
                    console.log('Active tokens:', activeTokens);
                    
                    if (!activeTokens.includes(String(decodedLog.token))) {
                        console.log('Token is not active:', decodedLog.token);
                        return;
                    }
                    const txHash = String(log.transactionHash);
                    const buy = await this.getBuyMessageData(decodedLog, txHash);
                    
                    // Check for duplicates before broadcasting
                    if (!this.isDuplicateMessage(buy)) {
                        this.ws.broadcast('NewBuy', buy);
                    } else {
                        console.log(`Skipping duplicate buy broadcast for ${buy.gotToken.name}`);
                    }
                } catch (error) {
                    console.error('Error processing buy event:', error);
                }
            });
            
            fourMemeBuySub.on('error', (error) => {
                console.error('Error in buy subscription:', error);
                // Remove the faulty subscription from our array
                const index = this.subscriptions.indexOf(fourMemeBuySub);
                if (index > -1) {
                    this.subscriptions.splice(index, 1);
                }
            });
            
            console.log('Successfully subscribed to buy events');
            return fourMemeBuySub;
        } catch (error) {
            console.error('Failed to subscribe to buy events:', error);
            throw error;
        }
    }

    private async subscribeToNewPools() {
        const fourMemeNewPoolsSub = await this.web3.eth.subscribe('logs', {
            address: this.fourMemeCA,
            topics: [newPoolTopic]
        });
        this.subscriptions.push(fourMemeNewPoolsSub);
        fourMemeNewPoolsSub.on('data', async (log) => {
            console.log('Raw log:', log);

            const eventAbi = this.fourMemeContract.options.jsonInterface.find((item: any) => item.signature === log.topics[0]);
            if (eventAbi) {
                const decodedLog = this.web3.eth.abi.decodeLog(eventAbi.inputs, log.data, log.topics.slice(1));
                console.log('Decoded log:', decodedLog);
                await this.handleNewPoolEvent(decodedLog);
            } else {
                console.error('Event ABI not found for signature:', log.topics[0]);
            }
        });
        fourMemeNewPoolsSub.on('error', (error) => {
            console.error('Error fetching new pool events:', error);
        });
    }
    private async handleNewPoolEvent(decodedLog: any) {
        const tokenCA = String(decodedLog.base)
        const pools = await this.commonWeb3.getPoolAddresses(tokenCA);
        pools.forEach(async (poolAddress) => {
            let attempts = 0;
            const maxAttempts = 10;
            const retryDelay = 5000; // 5 seconds

            while (attempts < maxAttempts) {
                try {
                    const poolDetails = await this.commonWeb3.getPoolDetails(poolAddress);
                    await insertPool(poolDetails);
                    await this.subscribeToPool(poolAddress);
                    await this.commonWeb3.updateGroupConfigsWithNewPools(tokenCA, [poolDetails.address]);
                    // TODO add here sending to websocket and then to telegram info about bonding
                    break; // Exit loop if successful
                } catch (error) {
                    attempts++;
                    console.error(`Error processing new pool event (attempt ${attempts}):`, error);
                    if (attempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                    } else {
                        console.error('Max retry attempts reached for processing new pool event');
                    }
                }
            }
        });
    }

    private async subscribeToPoolV2(poolAddress: string) {
        try {
            console.log(`Subscribing to V2 pool: ${poolAddress}`);
            
            // Check if already subscribed to avoid duplicates
            const key = `${poolAddress.toLowerCase()}-${swapV2Topic}`;
            if (this.subscriptionMap.has(key)) {
                console.log(`Already subscribed to pool ${poolAddress} for V2 swaps`);
                return this.subscriptionMap.get(key);
            }
            
            const poolSub = await this.web3.eth.subscribe('logs', {
                address: poolAddress,
                topics: [swapV2Topic] // Swap event
            });
            
            // Store subscription ID for better tracking
            console.log(`Subscribed to V2 pool ${poolAddress} with ID: ${poolSub.id}`);
            
            // Track this subscription
            this.trackSubscription(poolSub, poolAddress, swapV2Topic);
            
            poolSub.on('data', async (log) => {
                try {
                    console.log(`V2 pool event received for ${poolAddress}:`, log);
                    
                    // Get the transaction hash from the log for deduplication
                    const txHash = String(log.transactionHash);
                    console.log(`V2 Transaction hash: ${txHash}`);
                    
                    try {
                        // Get pool details to know token0 and token1
                        const poolDetails = await this.commonWeb3.getPoolDetailsV2(poolAddress);
                        console.log(`V2 pool details received:`, poolDetails);
                        
                        // Decode the log data - now passing topics as well
                        const decodedLog = this.decodeSwapEventV2(log.data, log.topics);
                        if (!decodedLog) {
                            console.error('Failed to decode V2 swap event');
                            return;
                        }
                        console.log(`Full V2 decoded swap event:`, decodedLog);
                        
                        // Add token addresses to the decoded data
                        const swapData = {
                            ...decodedLog,
                            token0Address: poolDetails.token0_address,
                            token1Address: poolDetails.token1_address
                        };
                        
                        // Process the swap event
                        console.log(`Processing V2 swap data:`, swapData);
                        const buyMessage = await this.poolSwapHandler.processSwapEventV2(
                            poolAddress,
                            swapData,
                            txHash
                        );
                        
                        if (buyMessage) {
                            // Check if this token is in our active tokens list
                            const activeTokens = await getAllActiveTokens();
                            
                            if (activeTokens.includes(buyMessage.gotToken.address)) {
                                // Check for duplicates before broadcasting using txHash for stronger deduplication
                                if (!this.isDuplicateMessage(buyMessage, txHash)) {
                                    // Add txHash to the message for client-side deduplication
                                    const messageWithTxHash = {
                                        ...buyMessage,
                                        txHash
                                    };
                                    
                                    // Broadcast the buy message
                                    console.log('Broadcasting pool swap as buy event:', messageWithTxHash);
                                    this.ws.broadcast('NewBuy', messageWithTxHash);
                                } else {
                                    console.log(`Skipping duplicate broadcast for ${buyMessage.gotToken.name} (txHash: ${txHash})`);
                                }
                            } else {
                                console.log(`Token ${buyMessage.gotToken.address} not in active list, skipping broadcast`);
                            }
                        }
                    }
                    catch (error) {
                        console.error(`Error processing V2 pool event for ${poolAddress}:`, error);
                    }
                } catch (error) {
                    console.error(`Error processing V2 pool event for ${poolAddress}:`, error);
                }
            });
            
            poolSub.on('error', (error) => {
                console.error(`Error in pool subscription for ${poolAddress}:`, error);
                // Remove the faulty subscription from our array
                const index = this.subscriptions.indexOf(poolSub);
                if (index > -1) {
                    this.subscriptions.splice(index, 1);
                }
            });
            
            return poolSub;
        } catch (error) {
            console.error(`Failed to subscribe to V2 pool ${poolAddress}:`, error);
            throw error;
        }
    }

    private async subscribeToPool(poolAddress: string) {
        try {
            console.log(`Subscribing to pool: ${poolAddress}`);
            
            // Check if already subscribed to avoid duplicates
            const key = `${poolAddress.toLowerCase()}-${swapV3Topic}`;
            if (this.subscriptionMap.has(key)) {
                console.log(`Already subscribed to pool ${poolAddress} for V3 swaps`);
                return this.subscriptionMap.get(key);
            }
            
            const poolSub = await this.web3.eth.subscribe('logs', {
                address: poolAddress,
                topics: [swapV3Topic] // Swap event
            });
            

            console.log(`Subscribed to pool ${poolAddress} with ID: ${poolSub.id}`);
            
            // Track this subscription
            this.trackSubscription(poolSub, poolAddress, swapV3Topic);
            
            poolSub.on('data', async (log) => {
                try {
                    console.log(`Pool event received for ${poolAddress}:`, log);
                    
                    // Get the transaction hash from the log for deduplication
                    const txHash = String(log.transactionHash);
                    console.log(`Transaction hash: ${txHash}`);
                    
                    // Get pool details to know token0 and token1
                    const poolDetails = await this.commonWeb3.getPoolDetails(poolAddress);
                    
                    // Decode the log data - now passing topics as well
                    const decodedLog = this.decodeSwapEvent(log.data, log.topics);
                    if (!decodedLog) {
                        console.error('Failed to decode swap event');
                        return;
                    }
                    
                    // Add token addresses to the decoded data
                    const swapData = {
                        ...decodedLog,
                        token0Address: poolDetails.token0_address,
                        token1Address: poolDetails.token1_address
                    };
                    
                    // Process the swap event
                    const buyMessage = await this.poolSwapHandler.processSwapEvent(
                        poolAddress,
                        swapData,
                        txHash
                    );
                    
                    if (buyMessage) {
                        // Check if this token is in our active tokens list
                        const activeTokens = await getAllActiveTokens();
                        
                        if (activeTokens.includes(buyMessage.gotToken.address)) {
                            // Check for duplicates before broadcasting using txHash for most accurate deduplication
                            if (!this.isDuplicateMessage(buyMessage, txHash)) {
                                // Add txHash to the message for client-side deduplication
                                const messageWithTxHash = {
                                    ...buyMessage,
                                    txHash
                                };
                                
                                // Broadcast the buy message
                                console.log('Broadcasting pool swap as buy event:', messageWithTxHash);
                                this.ws.broadcast('NewBuy', messageWithTxHash);
                            } else {
                                console.log(`Skipping duplicate broadcast for ${buyMessage.gotToken.name} (txHash: ${txHash})`);
                            }
                        } else {
                            console.log(`Token ${buyMessage.gotToken.address} not in active list, skipping broadcast`);
                        }
                    }
                } catch (error) {
                    console.error(`Error processing pool event for ${poolAddress}:`, error);
                }
            });
            
            poolSub.on('error', (error) => {
                console.error(`Error in pool subscription for ${poolAddress}:`, error);
                // Remove the faulty subscription from our array
                const index = this.subscriptions.indexOf(poolSub);
                if (index > -1) {
                    this.subscriptions.splice(index, 1);
                }
            });
            
            return poolSub;
        } catch (error) {
            console.error(`Failed to subscribe to pool ${poolAddress}:`, error);
            throw error;
        }
    }

    /**
     * Decode Uniswap V3 Swap event data using Web3 ABI decoder
     */
    private decodeSwapEvent(data: string, topics: string[]): any {
        try {
            console.log('Decoding V3 swap event data using ABI decoder');
            console.log('Topics:', topics);
            console.log('Data length:', data?.length || 0);
            
            // Define the Swap event ABI directly here to ensure it's correct
            const swapEventABI = [{
                "indexed": true,
                "name": "sender",
                "type": "address"
            }, {
                "indexed": true,
                "name": "recipient",
                "type": "address"
            }, {
                "indexed": false,
                "name": "amount0",
                "type": "int256"
            }, {
                "indexed": false,
                "name": "amount1",
                "type": "int256"
            }, {
                "indexed": false,
                "name": "sqrtPriceX96", 
                "type": "uint160"
            }, {
                "indexed": false,
                "name": "liquidity",
                "type": "uint128"
            }, {
                "indexed": false,
                "name": "tick",
                "type": "int24"
            }];
            
            // Use Web3's ABI decoder with the exact ABI structure
            const decodedLog = this.web3.eth.abi.decodeLog(
                swapEventABI,
                data,
                topics.slice(1) // Skip the event signature, keep indexed params
            );
            
            console.log('Successfully decoded V3 swap event:', decodedLog);
            console.log('amount0 type:', typeof decodedLog.amount0);
            console.log('amount1 type:', typeof decodedLog.amount1);
            
            // Ensure we have the expected fields
            if (typeof decodedLog.amount0 === 'undefined' || typeof decodedLog.amount1 === 'undefined') {
                console.error('Decoded swap event missing amount fields:', decodedLog);
                throw new Error('Incomplete swap event data');
            }
            
            return decodedLog;
        } catch (error) {
            console.error('Error decoding V3 swap event:', error);
            
            // Fall back to manual decoding
            console.log('Falling back to manual decoding for V3 swap event');
            return this.manualDecodeSwapEvent(data, topics);
        }
    }

    /**
     * Manual decoding as fallback method
     */
    private manualDecodeSwapEvent(data: string, topics: string[] = []): any {
        try {
            console.log('Manually decoding swap event data:', data);
            console.log('Topics for manual decode:', topics);
            
            // Validate input
            if (!data || data.length < 64 * 5) {
                console.error('Invalid swap event data length:', data?.length);
                return null;
            }
            
            // Remove 0x prefix if present
            const cleanData = data.startsWith('0x') ? data.slice(2) : data;
            
            // Get sender and recipient from topics (they're indexed)
            let sender = '0x0000000000000000000000000000000000000000';
            let recipient = '0x0000000000000000000000000000000000000000';
            
            if (topics && topics.length >= 3) {
                sender = topics[1].toLowerCase();
                recipient = topics[2].toLowerCase();
            }
            
            // Extract data values (non-indexed parameters)
            const amount0 = '0x' + cleanData.slice(0, 64);
            const amount1 = '0x' + cleanData.slice(64, 128);
            const sqrtPriceX96 = '0x' + cleanData.slice(128, 192);
            const liquidity = '0x' + cleanData.slice(192, 256);
            const tick = '0x' + cleanData.slice(256, 320);
            
            const decoded = {
                sender,
                recipient,
                amount0,
                amount1,
                sqrtPriceX96,
                liquidity,
                tick
            };
            
            console.log('Successfully manually decoded swap event:', decoded);
            return decoded;
        } catch (error) {
            console.error('Error in manual decoding of swap event:', error);
            return null;
        }
    }

    /**
     * Decode PancakeSwap V2 Swap event data using Web3 ABI decoder
     */
    private decodeSwapEventV2(data: string, topics: string[]): any {
        try {
            console.log('Decoding V2 swap event data using ABI decoder');
            console.log('Topics:', topics);
            console.log('Raw data:', data);
            
            // Use a hardcoded and correct V2 Swap event definition - this is more reliable
            const swapEventInputs = [
                { "indexed": true, "name": "sender", "type": "address" },
                { "indexed": false, "name": "amount0In", "type": "uint256" },
                { "indexed": false, "name": "amount1In", "type": "uint256" },
                { "indexed": false, "name": "amount0Out", "type": "uint256" },
                { "indexed": false, "name": "amount1Out", "type": "uint256" },
                { "indexed": true, "name": "to", "type": "address" }
            ];
            
            // Always use the hardcoded definition instead of trying to find it in the ABI
            const decodedLog = this.web3.eth.abi.decodeLog(
                swapEventInputs,
                data,
                topics.slice(1) // Skip the event signature topic
            );
            
            console.log('Successfully decoded V2 swap event:', decodedLog);
            console.log('Decoded fields:', Object.keys(decodedLog));
            
            // Validate we have the necessary fields
            if (!decodedLog.amount0In || !decodedLog.amount1In || 
                !decodedLog.amount0Out || !decodedLog.amount1Out) {
                console.log('Missing amount fields in decoded event. Trying manual decode');
                return this.manualDecodeSwapEventV2(data, topics);
            }
            
            return decodedLog;
        } catch (error) {
            console.error('Error decoding V2 swap event:', error);
            
            // Fall back to manual decoding if ABI decoding fails
            console.log('Falling back to manual decoding for V2 swap event');
            return this.manualDecodeSwapEventV2(data, topics);
        }
    }

    /**
     * Manual decoding as fallback method for V2 events
     * This is more reliable when the ABI decoder fails
     */
    private manualDecodeSwapEventV2(data: string, topics: string[]): any {
        try {
            console.log('Manually decoding V2 swap event data:', data);
            console.log('Topics:', topics);
            
            if (!data || data.length < 64 * 4) {
                console.error('Invalid V2 swap event data length:', data?.length);
                return null;
            }
            
            // Remove 0x prefix if present
            const cleanData = data.startsWith('0x') ? data.slice(2) : data;
            
            // Get sender and to from topics
            const sender = topics.length > 1 ? topics[1] : '0x0000000000000000000000000000000000000000';
            const to = topics.length > 2 ? topics[2] : '0x0000000000000000000000000000000000000000';
            
            // Parse amount values from data - these are all uint256 (64 chars/32 bytes each)
            const amount0In = this.parseHexValue(cleanData.slice(0, 64));
            const amount1In = this.parseHexValue(cleanData.slice(64, 128));
            const amount0Out = this.parseHexValue(cleanData.slice(128, 192));
            const amount1Out = this.parseHexValue(cleanData.slice(192, 256));
            
            console.log('Manual decoded values:', {
                amount0In,
                amount1In,
                amount0Out,
                amount1Out
            });
            
            const decoded = {
                sender,
                amount0In,
                amount1In,
                amount0Out,
                amount1Out,
                to
            };
            
            console.log('Successfully manually decoded V2 swap event:', decoded);
            return decoded;
        } catch (error) {
            console.error('Error in manual decoding of V2 swap event:', error);
            // Return a minimal object with empty values that won't crash the app
            return {
                sender: '0x0000000000000000000000000000000000000000',
                amount0In: '0',
                amount1In: '0',
                amount0Out: '0', 
                amount1Out: '0',
                to: '0x0000000000000000000000000000000000000000'
            };
        }
    }

    /**
     * Helper function to parse hex values correctly
     */
    private parseHexValue(hexSubstring: string): string {
        try {
            // Ensure it's a proper hex value
            const hexValue = '0x' + hexSubstring.replace(/^0+/, '');
            // Check if it's an empty or zero value
            if (hexValue === '0x' || hexValue === '0x0') {
                return '0';
            }
            // Convert to BigInt and then to string for safe handling of large numbers
            return BigInt(hexValue).toString();
        } catch (error) {
            console.error('Error parsing hex value:', error, hexSubstring);
            return '0';
        }
    }

    private async getBuyMessageData(decodedLog: any, txHash: string): Promise<BuyMessageData> {
        // handle Springboard buys.
        const tokenInfo = await this.commonWeb3.getTokenInfo(String(decodedLog.token));
        const WBNBPrice = (await getPrice()).price_usd //get price of WBNB in usd
        const spentAmount = (Number(decodedLog.cost) + Number(decodedLog.fee)) / 10**18
        const spentDollars = spentAmount * WBNBPrice
        const price = spentDollars / (Number(decodedLog.amount) / 10**18)
        const holderIncrease = '0' //get holder increase
        const marketcap = (Number(tokenInfo.totalSupply) / 10**18) * price //get marketcap TODO check burned tokens
        const dex = 'Springboard' 
        const buy: BuyMessageData = {
            spentToken: {address: WBNB, name: 'Wrapped BNB', symbol: 'WBNB', amount: spentAmount, priceUSD: WBNBPrice, pricePairToken: Number(decodedLog.price) / 10**18},
            gotToken: {amount: Number(decodedLog.amount) / 10**18, address: tokenInfo.address, name: tokenInfo.name, symbol: tokenInfo.symbol, priceUSD: price, pricePairToken: Number(decodedLog.price) / 10**18},
            holderWallet: String(decodedLog.account),
            pairAddress: tokenInfo.poolAddresses ? tokenInfo.poolAddresses[0] : '',
            spentDollars: spentDollars,
            holderIncrease: holderIncrease,
            marketcap: marketcap,
            poolAddress: tokenInfo.address,
            dex: dex,
            txHash: txHash,
            bondingStatus: Number(decodedLog.funds)

        }
        return buy;
    }

    /**
     * Add a subscription with duplicate checking
     * @param subscription The WebSocket subscription to add
     * @param address The contract address for the subscription
     * @param topic The topic for the subscription
     * @returns The active subscription (either existing or new)
     */
    private trackSubscription(subscription: any, address: string, topic: string): any {
        if (!address || !topic) {
            console.log('Cannot track subscription without address and topic');
            this.subscriptions.push(subscription);
            return subscription;
        }
        
        const key = `${address.toLowerCase()}-${topic}`;
        
        // Check if we already have this subscription
        if (this.subscriptionMap.has(key)) {
            console.log(`Already subscribed to ${address} for topic ${topic}`);
            
            try {
                // Unsubscribe from the new one since we already have it
                subscription.unsubscribe();
                console.log(`Unsubscribed from duplicate: ${key}`);
                
                // Return the existing subscription
                return this.subscriptionMap.get(key);
            } catch (error) {
                console.error(`Error unsubscribing from duplicate: ${error}`);
                // If unsubscribe failed, continue with the new one
            }
        }
        
        // Store the new subscription in our map and array
        this.subscriptionMap.set(key, subscription);
        this.subscriptions.push(subscription);
        console.log(`Tracking new subscription for ${address} with topic ${topic}`);
        
        return subscription;
    }

    /**
     * Check if a message is a duplicate with more robust checking
     */
    private isDuplicateMessage(message: BuyMessageData, txHash?: string): boolean {
        if (!message) return false;
        
        // If we have a transaction hash, use that for strongest deduplication
        if (txHash) {
            if (this.processedTxHashes.has(txHash)) {
                console.log(`Detected duplicate transaction: ${txHash}`);
                return true;
            }
            // Add to processed tx hashes with a cleanup mechanism
            this.processedTxHashes.add(txHash);
            
            // Clean up tx hash set periodically (keep last 1000 tx hashes max)
            if (this.processedTxHashes.size > 1000) {
                // Convert to array, sort by oldest first (would need to track timestamps)
                // and remove oldest entries
                const oldestEntries = Array.from(this.processedTxHashes).slice(0, 100);
                oldestEntries.forEach(hash => this.processedTxHashes.delete(hash));
                console.log(`Cleaned up ${oldestEntries.length} old transaction hashes`);
            }
        }
        
        // Create multiple unique keys for this message using different combinations
        const messageKeys = [
            // Standard key with all values
            `${message.holderWallet}-${message.gotToken.address}-${message.gotToken.amount}-${message.spentToken.amount}`,
            
            // Key with token addresses and amounts only (catches different wallets buying same amount)
            `${message.gotToken.address}-${message.gotToken.amount}-${message.spentToken.amount}`,
            
            // Key with wallet and token only (catches rapid multiple buys by same wallet)
            `${message.holderWallet}-${message.gotToken.address}-${Math.floor(Date.now()/1000/10)}` // 10-second window
        ];
        
        const now = Date.now();
        
        // Clean up old entries in the message cache
        for (const [key, timestamp] of this.recentMessages.entries()) {
            if (now - timestamp > this.MESSAGE_CACHE_TIMEOUT) {
                this.recentMessages.delete(key);
            }
        }
        
        // Check each potential key for a match
        for (const key of messageKeys) {
            if (this.recentMessages.has(key)) {
                console.log(`Detected duplicate message with key: ${key}`);
                return true;
            }
        }
        
        // Store all keys in the cache
        for (const key of messageKeys) {
            this.recentMessages.set(key, now);
        }
        
        return false;
    }
}

export default EventFetcher;
