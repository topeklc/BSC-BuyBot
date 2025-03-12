import Web3 from 'web3';
import path from 'path';
import fs from 'fs';
import { WebSocketServer } from './websocketServer';
import {CommonWeb3, WBNB} from '../CommonWeb3/common';
import {getAllActiveTokens, getPrice, insertPool, getPoolsForToken, getAllConfigPools, getTokenInfoFromDB} from '../DB/queries';
import { TokenInfo, BuyMessageData, PoolDetail } from '../types/types';
import Web3WsProvider from 'web3-providers-ws'
import { PoolSwapHandler } from './poolSwapHandler';
import { MemeSwapHandler } from './memeSwapHandler';
import { SubscriptionManager } from './subscriptionManager';
import EventDecoder from './eventDecoder';


// Define an array of RPC providers to use as fallbacks
const rpcProviders = [
    // "wss://rpc.ankr.com/bsc/ws/76932a0c09d0b6ff0405586fdb63e1316b4bddc62345b3eb9dd86822c82753e7",
    process.env.WSS_WEB3_PROVIDER || "",  // Primary provider from environment
    "wss://bsc-rpc.publicnode.com",       // Fallback provider
    // Add more fallback providers here
];

// Update the WebSocket options to better handle reconnection
const options = {
    clientConfig: {
        maxReceivedFrameSize: 100000000,
        maxReceivedMessageSize: 100000000,
        keepalive: true,
        keepaliveInterval: 30000 // 30 seconds
    },
    // Modify reconnect settings to prevent rapid reconnections
    reconnect: {
        autoReconnect: true,
        delay: 2000,
        maxAttempts: 3,
    }
};

class EventFetcher {
    private web3: Web3;
    private fourMemeCA: string;
    private fourMemeContract: any;
    private ws: WebSocketServer;
    private commonWeb3 = new CommonWeb3();
    private isReconnecting = false;
    private eventDecoder: EventDecoder;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private provider: any;
    private poolSwapHandler: PoolSwapHandler;
    private memeSwapHandler: MemeSwapHandler;
    private subscriptionMap: Map<string, any> = new Map();
    private recentMessages: Map<string, number> = new Map();
    private processedTxHashes: Set<string> = new Set();
    private currentProviderIndex = 0;
    private providerFailures: Record<number, number> = {}; // Track failures per provider
    private connectionVerified: boolean = false;
    private connectionVerificationTimeout: NodeJS.Timeout | null = null;
    private checkSubscriptionsCount = 0;
    // New subscription manager to handle all subscription-related functionality
    private subscriptionManager: SubscriptionManager | null = null;

    constructor() {
        this.ws = new WebSocketServer();
        this.initProvider();
        this.fourMemeCA = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
        
        // Initialize handlers
        this.poolSwapHandler = new PoolSwapHandler();
        this.memeSwapHandler = new MemeSwapHandler();
        
        // Initialize failure counts for each provider
        rpcProviders.forEach((_, index) => {
            this.providerFailures[index] = 0;
        });
        
    }
    
    private initProvider() {
        // Clean up any existing provider
        if (this.provider) {
            try {
                this.provider.disconnect();
            } catch (e) {
                console.log('Error disconnecting from previous provider:', e);
            }
            // Set to null to ensure garbage collection
            this.provider = null;
        }
        
        // Reset connection verification status
        this.connectionVerified = false;
        if (this.connectionVerificationTimeout) {
            clearTimeout(this.connectionVerificationTimeout);
            this.connectionVerificationTimeout = null;
        }
        
        // Get current provider URL - store it in a local variable to ensure it doesn't change
        const currentProviderIndex = this.currentProviderIndex;
        const currentProviderUrl = rpcProviders[currentProviderIndex] || '';
        
        console.log(`Initializing Web3 WebSocket provider with ${currentProviderUrl} (provider #${currentProviderIndex + 1}/${rpcProviders.length})`);
        
        // Validate provider URL before attempting to connect
        if (!currentProviderUrl || !currentProviderUrl.startsWith('ws')) {
            console.error(`Invalid WebSocket URL: ${currentProviderUrl}`);
            this.providerFailures[currentProviderIndex]++;
            this.selectNextProvider();
            
            // Schedule a retry with the next provider
            this.reconnectTimeout = setTimeout(() => {
                console.log('Retrying with next provider due to invalid URL');
                this.initProvider();
            }, 2000);
            return null;
        }
        
        try {
            // Create provider with the stored URL to avoid URL changing during connection process
            this.provider = new Web3WsProvider(currentProviderUrl, {}, options.reconnect);
            
            // Set up event handlers with better error handling
            this.provider.on("connect", () => {
                console.log(`WebSocket provider #${currentProviderIndex + 1} reported connected - verifying...`);
                
                // Set up verification timeout - if we don't verify in 5 seconds, consider it failed
                this.connectionVerificationTimeout = setTimeout(() => {
                    if (!this.connectionVerified) {
                        console.error(`Connection verification timeout for provider #${currentProviderIndex + 1}`);
                        this.providerFailures[currentProviderIndex]++;
                        this.handleDisconnect();
                    }
                }, 5000);
                
                // Verify connection by making a simple request
                this.verifyConnection(currentProviderUrl, currentProviderIndex);
            });
            
            this.provider.on("close", (event) => {
                console.log(`❌ WebSocket provider #${currentProviderIndex + 1} closed: ${currentProviderUrl}`, event);
                this.connectionVerified = false; // Ensure we know connection failed
                
                // Increment failure count for this provider
                this.providerFailures[currentProviderIndex]++;
                this.handleDisconnect();
            });
            
            this.provider.on("error", (error) => {
                console.error(`⚠️ WebSocket provider #${currentProviderIndex + 1} error: ${currentProviderUrl}`, error);
                this.connectionVerified = false; // Ensure we know connection failed
                
                // Increment failure count for this provider
                this.providerFailures[currentProviderIndex]++;
                this.handleDisconnect();
            });
            
            return this.provider;
        } catch (error) {
            console.error(`Error creating WebSocket provider with URL ${currentProviderUrl}:`, error);
            this.providerFailures[currentProviderIndex]++;
            this.handleDisconnect();
            return null;
        }
    }
    
    /**
     * Verify that the connection is actually working by making a test request
     */
    private async verifyConnection(providerUrl: string, providerIndex: number) {
        try {
            // Check if this is still the current provider index
            // This prevents a race condition where we might verify an old provider
            if (providerIndex !== this.currentProviderIndex) {
                console.log(`Provider index changed during verification (was: ${providerIndex}, now: ${this.currentProviderIndex})`);
                return; // Exit without verification if the provider changed
            }
            
            // Create a temporary Web3 instance for verification
            const tempWeb3 = new Web3(this.provider);
            
            // Try to get the current block number
            const blockNumber = await tempWeb3.eth.getBlockNumber();
            
            // If we get here, the connection is working
            this.connectionVerified = true;
            
            // Clear the verification timeout
            if (this.connectionVerificationTimeout) {
                clearTimeout(this.connectionVerificationTimeout);
                this.connectionVerificationTimeout = null;
            }
            
            console.log(`✅ WebSocket provider #${providerIndex + 1} connection verified: ${providerUrl} (current block: ${blockNumber})`);
            
            // Reset failure count for this provider on verified connection
            this.providerFailures[providerIndex] = 0;
            this.isReconnecting = false;
            
            // Initialize Web3 and contract after successful connection
            this.initWeb3();
            
        } catch (error) {
            console.error(`❌ WebSocket provider #${providerIndex + 1} connection verification failed:`, error);
            
            // Check if this is still the current provider index
            if (providerIndex !== this.currentProviderIndex) {
                console.log('Provider changed during verification, ignoring verification failure');
                return;
            }
            
            this.connectionVerified = false;
            this.providerFailures[providerIndex]++;
            
            // Clear the verification timeout
            if (this.connectionVerificationTimeout) {
                clearTimeout(this.connectionVerificationTimeout);
                this.connectionVerificationTimeout = null;
            }
            
            this.handleDisconnect();
        }
    }
    
    private async initWeb3() {
        try {
            // Don't initialize if connection wasn't verified
            if (!this.connectionVerified) {
                console.error('Cannot initialize Web3 with unverified connection');
                this.handleDisconnect();
                return;
            }
            
            console.log('Initializing Web3...');
            // Create a new Web3 instance with the provider
            try {
                this.web3 = new Web3(this.provider);
            } catch (error) {
                console.error('Error creating Web3 instance:', error);
                this.handleDisconnect();
                return;
            }
            
            // Load ABI and create contract instance
            const fourMemeAbi = JSON.parse(
                fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi', 'TokenManager2.lite.abi'), 'utf-8')
            );
            this.fourMemeContract = new this.web3.eth.Contract(fourMemeAbi, this.fourMemeCA);
            
            console.log('Web3 initialization complete');
            
            // Initialize the EventDecoder
            this.eventDecoder = new EventDecoder(this.web3);
            console.log('EventDecoder initialized');
            
            // Clean up existing SubscriptionManager if it exists
            if (this.subscriptionManager) {
                console.log('Cleaning up existing SubscriptionManager before creating a new one');
                try {
                    // Wait for cleanup to complete with a timeout
                    await Promise.race([
                        this.subscriptionManager.clearSubscriptions() || Promise.resolve(),
                        new Promise(resolve => setTimeout(resolve, 2000)) // 2 second timeout
                    ]);
                    console.log('All subscription tracking data cleared');
                } catch (error) {
                    console.error('Error cleaning up existing SubscriptionManager:', error);
                }
            }
            
            // Initialize the SubscriptionManager with the necessary dependencies
            this.subscriptionManager = new SubscriptionManager(
                this.web3,
                this.fourMemeCA,
                this.fourMemeContract,
            );
            
            // Set up event handlers for the SubscriptionManager
            this.setupSubscriptionManagerHandlers();
            
            // Reset reconnection flag now that we've successfully initialized
            this.isReconnecting = false;
            
            // Set a longer delay before establishing subscriptions to ensure the provider is ready
            // and any previous subscription cleanup has completed
            setTimeout(async () => {
                try {
                    console.log('Establishing subscriptions after reconnect...');
                    if (this.subscriptionManager) {
                        await this.subscriptionManager.initializeSubscriptions();
                        
                        // After successful initialization, check for any duplicate subscriptions
                        try {
                            await this.subscriptionManager.cleanupDuplicateSubscriptions();
                        } catch (cleanupError) {
                            console.error('Error cleaning up duplicate subscriptions:', cleanupError);
                            // Continue even if cleanup fails
                        }
                        
                        console.log(`Successfully established subscriptions via SubscriptionManager`);
                    }
                } catch (error) {
                    console.error('Error establishing subscriptions after reconnect:', error);
                    // If we can't establish subscriptions, try to reconnect again
                    if (!this.isReconnecting) {
                        console.log('Triggering reconnection due to subscription establishment failure');
                        this.handleDisconnect();
                    }
                }
            }, 5000); // Increased delay to 5 seconds for better stability
        } catch (error) {
            console.error('Failed to initialize Web3:', error);
            this.handleDisconnect();
        }
    }
    
    /**
     * Set up event handlers for the SubscriptionManager
     */
    private setupSubscriptionManagerHandlers() {
        if (!this.subscriptionManager) return;
        
        // Set up handlers for SubscriptionManager events
        this.subscriptionManager.onBuyEvent = async (decodedLog, txHash) => {
            try {
                const buy = await this.memeSwapHandler.processBuyEvent(decodedLog, txHash);
                
                // Check for duplicates before broadcasting
                if (buy && !this.subscriptionManager?.isDuplicateMessage(buy, txHash)) {
                    this.ws.broadcast('NewBuy', buy);
                } else {
                    console.log(`Skipping duplicate buy broadcast for ${buy?.gotToken.name}`);
                }
            } catch (error) {
                console.error('Error processing buy event from SubscriptionManager:', error);
            }
        };
        
        this.subscriptionManager.onNewPoolEvent = (decodedLog) => {
            this.handleNewPoolEvent(decodedLog);
        };
        
        this.subscriptionManager.onPoolV2Event = async (poolAddress, log, txHash) => {
            try {
                // Process V2 pool events
                // Decode the log data for V2 pools using the EventDecoder
                const decodedData = this.eventDecoder.decodeSwapEventV2(log.data, log.topics);
                if (decodedData) {
                    // Process the V2 swap event
                    const poolDetail = await this.commonWeb3.getPoolDetailsV2(poolAddress);
                    if (poolDetail) {
                        decodedData.token0Address = poolDetail.token0_address;
                        decodedData.token1Address = poolDetail.token1_address;
                        const buyMessage = await this.poolSwapHandler.processSwapEventV2(poolAddress, decodedData, txHash);
                        if (buyMessage && !this.subscriptionManager?.isDuplicateMessage(buyMessage, txHash)) {
                            this.ws.broadcast('NewBuy', buyMessage);
                        } else {
                            console.log(`Skipping duplicate buy broadcast for ${buyMessage?.gotToken.name}`);
                        }
                    }
                }
            } catch (error) {
                console.error(`Error processing V2 pool event for ${poolAddress}:`, error);
            }
        };
        
        this.subscriptionManager.onPoolV3Event = async (poolAddress, log, txHash) => {
            try {
                // Process V3 pool events
                // Decode the log data for V3 pools using the EventDecoder
                const decodedData = this.eventDecoder.decodeSwapEvent(log.data, log.topics);
                if (decodedData) {
                    // Add token addresses to the decoded data
                    const poolDetail = await this.commonWeb3.getPoolDetails(poolAddress);
                    if (poolDetail) {
                        decodedData.token0Address = poolDetail.token0_address;
                        decodedData.token1Address = poolDetail.token1_address;
                        // Process the V3 swap event
                        const buyMessage = await this.poolSwapHandler.processSwapEvent(poolAddress, decodedData, txHash);
                        if (buyMessage && !this.subscriptionManager?.isDuplicateMessage(buyMessage, txHash)) {
                            this.ws.broadcast('NewBuy', buyMessage);
                        } else {
                            console.log(`Skipping duplicate buy broadcast for ${buyMessage?.gotToken.name}`);
                        }
                    }
                }
            } catch (error) {
                console.error(`Error processing V3 pool event for ${poolAddress}:`, error);
            }
        };
    }
    
    private async handleDisconnect() {
        // Prevent multiple concurrent reconnection attempts
        if (this.isReconnecting) {
            console.log('Already reconnecting, ignoring duplicate disconnect event');
            return;
        }
        this.isReconnecting = true;
        
        // Clear the verification timeout if it exists
        if (this.connectionVerificationTimeout) {
            clearTimeout(this.connectionVerificationTimeout);
            this.connectionVerificationTimeout = null;
        }
        
        console.log('Handling provider disconnect...');
        
        // Clear local subscription tracking immediately
        this.subscriptionMap.clear();
        this.recentMessages.clear(); // Clear message cache
        this.processedTxHashes.clear();
        
        // Properly clean up existing SubscriptionManager if it exists
        let cleanupPromise: Promise<unknown> = Promise.resolve();
        if (this.subscriptionManager) {
            console.log('Cleaning up existing SubscriptionManager...');
            try {
                // Store the cleanup promise to await it
                const result = this.subscriptionManager.clearSubscriptions();
                // No need to check if result exists, as we're using type Promise<unknown>
                cleanupPromise = result || Promise.resolve();
            } catch (error) {
                console.error('Error initiating SubscriptionManager cleanup:', error);
                // Continue with reconnection even if cleanup fails
            }
        }
        
        // Implement exponential backoff for reconnection attempts
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        
        // Check if we should switch to a different provider
        if (this.providerFailures[this.currentProviderIndex] >= 1) { // After 1 failure, try next provider
            this.selectNextProvider();
        }
        
        // Set a timeout for reconnection, but wait for cleanup to finish first (with a maximum wait time)
        const reconnectDelay = 5000; // 5 seconds
        
        // Use Promise.race to ensure we don't wait too long for cleanup
        Promise.race([
            cleanupPromise,
            new Promise(resolve => setTimeout(resolve, 3000)) // Max 3 seconds wait for cleanup
        ]).finally(() => {
            this.reconnectTimeout = setTimeout(() => {
                console.log('Attempting to reconnect WebSocket provider...');
                this.initProvider();
                this.reconnectTimeout = null;
                // Note: We'll initialize the SubscriptionManager in initWeb3 after successful connection
            }, reconnectDelay);
        });
    }
    
    private selectNextProvider() {
        const previousProvider = this.currentProviderIndex;
        
        // Find the provider with the least failures
        let minFailures = Infinity;
        let bestProviderIndex = 0;
        
        for (let i = 0; i < rpcProviders.length; i++) {
            const failures = this.providerFailures[i] || 0;
            if (failures < minFailures && i !== previousProvider) {
                minFailures = failures;
                bestProviderIndex = i;
            }
        }
        
        // If all providers have similar failure counts, just go to the next one
        if (minFailures === Infinity || (minFailures > 0 && rpcProviders.length > 2)) {
            bestProviderIndex = (previousProvider + 1) % rpcProviders.length;
        }
        
        this.currentProviderIndex = bestProviderIndex;
        
        console.log(`Switching from provider #${previousProvider + 1} to provider #${this.currentProviderIndex + 1} due to connection issues`);
        console.log(`Provider failure counts: ${JSON.stringify(this.providerFailures)}`);
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
            }, 60 * 1000); // Check every 1 minute initially
            
            console.log('EventFetcher started successfully');
        } catch (error) {
            console.error('Error starting EventFetcher:', error);
            this.handleDisconnect();
            throw error;
        }
    }
    
    private async waitForWeb3() {
        console.log('Waiting for Web3 initialization...');
        
        const maxTotalAttempts = 12; // Total connection attempts across all providers
        let totalAttempts = 0;
        const delayBetweenAttempts = 5000; // 5 seconds
        
        // Try to connect until we succeed or exhaust all attempts
        while (!this.web3 && totalAttempts < maxTotalAttempts) {
            totalAttempts++;
            console.log(`Connection attempt ${totalAttempts}/${maxTotalAttempts}...`);
            
            // Wait for the current connection attempt to either succeed or fail
            await new Promise(resolve => setTimeout(resolve, delayBetweenAttempts));
            
            // If we don't have a connection and we're not in the reconnecting state,
            // explicitly try the next provider
            if (!this.web3 && !this.isReconnecting) {
                // Select next provider
                this.selectNextProvider();
                console.log(`No connection established, trying provider #${this.currentProviderIndex + 1}`);
                
                // Reset states to prevent issues
                this.isReconnecting = false;
                this.connectionVerified = false;
                
                // Initialize the new provider
                this.initProvider();
            }
        }
        
        // Check if we managed to connect to any provider
        if (!this.web3) {
            console.error('Failed to connect to any provider after multiple attempts');
            throw new Error('Web3 initialization timed out - could not connect to any provider');
        }
        
        console.log('Web3 successfully initialized with provider #' + (this.currentProviderIndex + 1));
        return this.web3;
    }
    
    private async checkSubscriptions() {
        try {
            // Check if provider is connected
            this.checkSubscriptionsCount++;
            
            try {
                const isHealthy = await this.web3.eth.net.isListening();
                console.log("Is healthy: ", isHealthy);
                if (!isHealthy) {
                    this.checkSubscriptionsCount = 0;
                    console.log('Provider disconnected, reconnecting...');
                    this.handleDisconnect();
                    return;
                }
            } catch (error) {
                console.error('Error checking provider connection:', error);
                this.handleDisconnect();
                return;
            }
            
            // Don't try to resubscribe if we're in the middle of reconnecting
            if (this.isReconnecting) {
                console.log('Currently reconnecting, skipping subscription check');
                return;
            }
            
            // Use the SubscriptionManager to check and manage subscriptions
            if (this.subscriptionManager) {
                await this.subscriptionManager.checkSubscriptions();
                console.log(`Subscription check complete via SubscriptionManager`);
            } else {
                console.error('SubscriptionManager not initialized, cannot check subscriptions');
            }
        } catch (error) {
            console.error('Error checking subscriptions:', error);
        }
    }
    
    private async handleNewPoolEvent(decodedLog: any) {
        const tokenCA = String(decodedLog.base);
        const pools = await this.commonWeb3.getPoolAddresses(tokenCA);
        
        pools.forEach(async (poolAddress) => {
            let attempts = 0;
            const maxAttempts = 10;
            const retryDelay = 5000; // 5 seconds

            while (attempts < maxAttempts) {
                try {
                    const poolDetails = await this.commonWeb3.getPoolDetails(poolAddress);
                    await insertPool(poolDetails);
                    // Use SubscriptionManager instead of direct subscription
                    if (this.subscriptionManager) {
                        await this.subscriptionManager.subscribeToPool(poolAddress);
                    }
                    await this.commonWeb3.updateGroupConfigsWithNewPools(tokenCA, [poolDetails.address]);
                    
                    // Get token information from database
                    const tokenInfo = await getTokenInfoFromDB(tokenCA);
                    if (tokenInfo) {
                        // Broadcast new pool message with token name and pool details
                        console.log(`Broadcasting NewPool message for token ${tokenInfo.name}, pool ${poolAddress}`);
                        this.ws.broadcast('NewPool', {
                            tokenName: tokenInfo.name,
                            tokenAddress: tokenCA,
                            poolDetail: poolDetails
                        });
                    } else {
                        console.log(`Token info not found for ${tokenCA}, getting from blockchain`);
                        // Fallback to blockchain query if not in DB
                        const chainTokenInfo = await this.commonWeb3.getTokenInfo(tokenCA);
                        if (chainTokenInfo) {
                            this.ws.broadcast('NewPool', {
                                tokenName: chainTokenInfo.name,
                                tokenAddress: tokenCA,
                                poolDetail: poolDetails
                            });
                        }
                    }
                    
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



}

export default EventFetcher;
