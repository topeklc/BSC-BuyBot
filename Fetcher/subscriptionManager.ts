import Web3 from 'web3';
import { BuyMessageData } from '../types/types';

import { getAllActiveTokens, getAllConfigPools, getPoolsForToken } from '../DB/queries';

// Define topics as constants
const buyTopic = '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942';
const newPoolTopic = '0xc18aa71171b358b706fe3dd345299685ba21a5316c66ffa9e319268b033c44b0';
const swapV3Topic = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
const swapV2Topic = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

export class SubscriptionManager {
    private web3: Web3;
    private subscriptions: any[] = [];
    private subscriptionMap: Map<string, any> = new Map();
    private recentMessages: Map<string, number> = new Map();
    private readonly MESSAGE_CACHE_TIMEOUT = 60000; // 60 seconds
    private processedTxHashes: Map<string, number> = new Map(); // Map of tx hash to timestamp
    private fourMemeCA: string;
    private fourMemeContract: any;
    
    // Event handlers are defined at the end of the file

    constructor(web3: Web3, fourMemeCA: string, fourMemeContract: any) {
        this.web3 = web3;
        this.fourMemeCA = fourMemeCA;
        this.fourMemeContract = fourMemeContract;
    }

    /**
     * Initialize all subscriptions
     */
    public async initializeSubscriptions() {
        try {
            console.log('Establishing subscriptions...');
            await this.subscribeToNewPools();
            await this.subscribeToBuys();
            await this.initDBPoolsSubscriptions();
            await this.subscribeToNewBlockHeaders();
            console.log(`Successfully established ${this.subscriptions.length} subscriptions`);
        } catch (error) {
            console.error('Error establishing subscriptions:', error);
            throw error;
        }
    }

    /**
     * Clear all subscriptions
     */
    public clearSubscriptions() {
        console.log(`Clearing ${this.subscriptions.length} active subscriptions...`);
        
        // Unsubscribe from all active subscriptions first
        const unsubscribePromises: Promise<void>[] = [];
        
        for (const sub of this.subscriptions) {
            try {
                if (sub && typeof sub.unsubscribe === 'function') {
                    // Unsubscribe and add to promises array
                    const unsubPromise = new Promise<void>((resolve) => {
                        try {
                            sub.unsubscribe((error: any, success: boolean) => {
                                if (error) {
                                    // Check for "subscription not found" error - this is expected during reconnection
                                    if (error.data === 'subscription not found') {
                                        console.log(`Subscription ${sub.id || 'unknown'} already cleared on provider side`);
                                    } else {
                                        console.error('Error unsubscribing:', error);
                                    }
                                } else if (success) {
                                    console.log(`Successfully unsubscribed from subscription ID: ${sub.id || 'unknown'}`);
                                }
                                resolve(); // Resolve regardless of success/failure
                            });
                        } catch (innerError) {
                            console.error('Exception during unsubscribe call:', innerError);
                            resolve(); // Resolve to prevent hanging promises
                        }
                    });
                    unsubscribePromises.push(unsubPromise);
                }
            } catch (error) {
                console.error('Error during unsubscribe process:', error);
            }
        }
        
        // Wait for all unsubscribe operations to complete (with timeout)
        const cleanupPromise = Promise.race([
            Promise.all(unsubscribePromises).catch(err => {
                // Catch any errors in the Promise.all to prevent unhandled rejections
                console.error('Error in unsubscribe promises:', err);
                return []; // Return empty array to continue execution
            }),
            new Promise<void>((resolve) => setTimeout(() => resolve(), 2000)) // 2 second timeout
        ]);
        
        cleanupPromise.then(() => {
            console.log('Unsubscribe operations completed or timed out');
        }).catch(err => {
            // This shouldn't happen due to the inner catch, but just in case
            console.error('Unexpected error during subscription cleanup:', err);
        });
        
        // Clear all tracking data immediately - don't wait for unsubscribe to complete
        // This ensures we don't try to use stale subscriptions
        this.subscriptions = [];
        this.subscriptionMap.clear();
        this.recentMessages.clear();
        this.processedTxHashes.clear();
        this.lastSeenBlocks.clear();
        this.blockHeaderSubscription = null;
        
        console.log('All subscription tracking data cleared');
        
        // Return the promise for callers that want to wait for completion
        return cleanupPromise;
    }

    /**
     * Get all active subscriptions
     */
    public getSubscriptions() {
        return this.subscriptions;
    }

    /**
     * Check subscriptions health and manage them
     * Resubscribes to each subscription immediately after unsubscribing to ensure connection health
     */
    public async checkSubscriptions() {
        try {
            console.log(`Checking ${this.subscriptions.length} subscriptions...`);
            console.log('Current subs:', this.web3.subscriptionManager.subscriptions)
            // Get all pools from active configurations to determine what we should be subscribed to
            const activeConfigPools = await getAllConfigPools();
            const activePoolAddresses = new Set(activeConfigPools.map(pool => pool.address.toLowerCase()));
            
            console.log(`Found ${activePoolAddresses.size} pools in active configurations`);
            
            // Create a map to track which subscriptions we've processed
            const processedSubs = new Map<string, boolean>();
            const newSubscriptions: any[] = [];
            
            // 1. Handle core subscriptions - buys and new pools
            console.log('Refreshing core subscriptions...');
            
            // Buy subscription
            const buySubscription = this.subscriptions.find(sub => 
                sub.args?.topics?.[0] === buyTopic
            );
            
            if (buySubscription) {
                try {
                    // Unsubscribe from existing buy subscription
                    await buySubscription.unsubscribe();
                    console.log('Unsubscribed from buy subscription');
                    
                    // Remove from tracking
                    const index = this.subscriptions.indexOf(buySubscription);
                    if (index > -1) {
                        this.subscriptions.splice(index, 1);
                    }
                    this.subscriptionMap.delete(`${this.fourMemeCA}-${buyTopic}`);
                } catch (error) {
                    console.error('Error unsubscribing from buy subscription:', error);
                }
            }
            
            // Immediately resubscribe to buys
            try {
                await this.subscribeToBuys();
                console.log('Resubscribed to buy events');
            } catch (error) {
                console.error('Error subscribing to buy events:', error);
            }
            
            // New pool subscription
            const newPoolSubscription = this.subscriptions.find(sub => 
                sub.args?.topics?.[0] === newPoolTopic
            );
            
            if (newPoolSubscription) {
                try {
                    // Unsubscribe from existing new pool subscription
                    await newPoolSubscription.unsubscribe();
                    console.log('Unsubscribed from new pool subscription');
                    
                    // Remove from tracking
                    const index = this.subscriptions.indexOf(newPoolSubscription);
                    if (index > -1) {
                        this.subscriptions.splice(index, 1);
                    }
                    this.subscriptionMap.delete(`${this.fourMemeCA}-${newPoolTopic}`);
                } catch (error) {
                    console.error('Error unsubscribing from new pool subscription:', error);
                }
            }
            
            // Immediately resubscribe to new pools
            try {
                await this.subscribeToNewPools();
                console.log('Resubscribed to new pool events');
            } catch (error) {
                console.error('Error subscribing to new pool events:', error);
            }
            
            // Refresh block header subscription
            try {
                await this.subscribeToNewBlockHeaders();
                console.log('Refreshed block header subscription');
            } catch (error) {
                console.error('Error refreshing block header subscription:', error);
            }
            
            // 2. Handle pool subscriptions - unsubscribe and immediately resubscribe for each pool
            console.log('Refreshing pool subscriptions...');
            let poolSubscriptionCount = 0;
            
            // Process active pools from config
            for (const pool of activeConfigPools) {
                const poolAddress = pool.address.toLowerCase();
                const topic = pool.version === 2 ? swapV2Topic : swapV3Topic;
                const key = `${poolAddress}-${topic}`;
                
                // Find existing subscription for this pool
                const existingSub = this.subscriptions.find(sub => 
                    sub.args?.address?.toLowerCase() === poolAddress && 
                    sub.args?.topics?.[0] === topic
                );
                
                // Unsubscribe if there's an existing subscription
                if (existingSub) {
                    try {
                        await existingSub.unsubscribe();
                        console.log(`Unsubscribed from pool: ${poolAddress}`);
                        
                        // Remove from tracking
                        const index = this.subscriptions.indexOf(existingSub);
                        if (index > -1) {
                            this.subscriptions.splice(index, 1);
                        }
                        this.subscriptionMap.delete(key);
                    } catch (error) {
                        console.error(`Error unsubscribing from pool ${poolAddress}:`, error);
                    }
                }
                
                // Immediately resubscribe
                try {
                    if (pool.version === 3) {
                        await this.subscribeToPool(poolAddress);
                        console.log(`Resubscribed to pool V3: ${poolAddress}`);
                        poolSubscriptionCount++;
                    } else if (pool.version === 2) {
                        await this.subscribeToPoolV2(poolAddress);
                        console.log(`Resubscribed to pool V2: ${poolAddress}`);
                        poolSubscriptionCount++;
                    }
                    
                    // Mark as processed
                    processedSubs.set(key, true);
                } catch (error) {
                    console.error(`Error subscribing to pool ${poolAddress}:`, error);
                }
            }
            
            // 3. Find and unsubscribe from any pools that are no longer in active config
            const poolsToRemove = this.subscriptions.filter(sub => {
                if (!sub.args?.address || !sub.args?.topics?.[0]) return false;
                
                const address = sub.args.address.toLowerCase();
                const topic = sub.args.topics[0];
                const key = `${address}-${topic}`;
                
                // If it's a pool subscription (V2 or V3) and not processed yet
                return (topic === swapV2Topic || topic === swapV3Topic) && 
                       !processedSubs.has(key) && 
                       !activePoolAddresses.has(address);
            });
            
            // Remove pools no longer in config
            for (const sub of poolsToRemove) {
                try {
                    const address = sub.args.address.toLowerCase();
                    const topic = sub.args.topics[0];
                    const key = `${address}-${topic}`;
                    
                    await sub.unsubscribe();
                    console.log(`Unsubscribed from inactive pool: ${address}`);
                    
                    // Remove from tracking
                    const index = this.subscriptions.indexOf(sub);
                    if (index > -1) {
                        this.subscriptions.splice(index, 1);
                    }
                    this.subscriptionMap.delete(key);
                } catch (error) {
                    console.error('Error unsubscribing from inactive pool:', error);
                }
            }
            
            console.log(`Successfully refreshed ${poolSubscriptionCount} pool subscriptions`);
            console.log(`Total active subscriptions: ${this.subscriptions.length}`);
            
            // Verify no duplicates exist
            this.cleanupDuplicateSubscriptions();
            
            // Log current subscription map for debugging
            console.log('Current subscriptionMap entries:');
            for (const [key, value] of this.subscriptionMap.entries()) {
                console.log(`Key: ${key}, Value: ${value ? value.id || 'unknown id' : 'undefined'}`);
            }
            
            console.log(`Subscription refresh complete, now tracking ${this.subscriptions.length} subscriptions`);
        } catch (error) {
            console.error('Error during subscription refresh:', error);
            throw error;
        }
    }
    
    /**
     * Helper method to clean up duplicate subscriptions
     * Returns a promise that resolves when cleanup is complete
     */
    public async cleanupDuplicateSubscriptions(): Promise<void> {
        console.log(`Starting duplicate subscription cleanup for ${this.subscriptions.length} subscriptions...`);
        
        // First, check for subscriptions that are no longer valid in web3's subscription manager
        const invalidSubs: any[] = [];
        const validSubs: any[] = [];
        
        // Check each subscription for validity
        for (const sub of this.subscriptions) {
            try {
                // Check if the subscription is still valid in web3's subscription manager
                const isValid = sub && sub.id && 
                    this.web3.subscriptionManager?.subscriptions?.has(sub.id);
                
                if (!isValid) {
                    console.log(`Found invalid subscription ID: ${sub.id || 'unknown'}`);
                    invalidSubs.push(sub);
                } else {
                    validSubs.push(sub);
                }
            } catch (error) {
                console.error('Error checking subscription validity:', error);
                // If we can't determine validity, assume it's invalid
                invalidSubs.push(sub);
            }
        }
        
        // Remove invalid subscriptions from our tracking
        if (invalidSubs.length > 0) {
            console.log(`Removing ${invalidSubs.length} invalid subscriptions from tracking`);
            this.subscriptions = validSubs;
            
            // Also remove from subscriptionMap
            for (const [key, sub] of this.subscriptionMap.entries()) {
                if (invalidSubs.includes(sub)) {
                    this.subscriptionMap.delete(key);
                }
            }
        }
        
        // Now check for duplicate subscriptions by address and topic
        const uniqueKeys = new Map<string, any>();
        const duplicateKeys = new Set<string>();
        const finalSubs: any[] = [];
        const unsubPromises: Promise<void>[] = [];
        
        // Reorganize our subscription tracking
        for (const sub of this.subscriptions) {
            // Extract the key info if available
            if (sub.args && sub.args.address && sub.args.topics && sub.args.topics[0]) {
                const address = sub.args.address.toLowerCase();
                const topic = sub.args.topics[0];
                const key = `${address}-${topic}`;
                
                if (uniqueKeys.has(key)) {
                    console.log(`Found duplicate subscription for ${address} with topic ${topic}`);
                    duplicateKeys.add(key);
                    
                    // Create a promise for this unsubscribe operation
                    const unsubPromise = new Promise<void>((resolve) => {
                        try {
                            // Unsubscribe from the duplicate
                            sub.unsubscribe((error: any, success: boolean) => {
                                if (error) {
                                    // Check if this is a "subscription not found" error, which is actually ok
                                    if (error.message && error.message.includes('not found')) {
                                        console.log(`Subscription ${sub.id || 'unknown'} was already cleared`);
                                    } else {
                                        console.error(`Error unsubscribing from duplicate: ${error}`);
                                    }
                                } else if (success) {
                                    console.log(`Successfully unsubscribed from duplicate for ${key}`);
                                }
                                resolve(); // Always resolve, even on error
                            });
                        } catch (unsubError) {
                            console.error(`Error initiating unsubscribe from duplicate: ${unsubError}`);
                            resolve(); // Resolve even if there's an exception
                        }
                    });
                    
                    unsubPromises.push(unsubPromise);
                    // Keep the original subscription in our tracking
                } else {
                    uniqueKeys.set(key, sub);
                    finalSubs.push(sub);
                }
            } else {
                // If we can't identify the subscription, keep it but log a warning
                console.warn('Found subscription without proper identification:', 
                    sub.id || 'unknown');
                finalSubs.push(sub);
            }
        }
        
        console.log(`Found ${duplicateKeys.size} duplicate subscriptions`);
        
        // Wait for all unsubscribe operations to complete
        if (unsubPromises.length > 0) {
            console.log(`Waiting for ${unsubPromises.length} unsubscribe operations to complete...`);
            try {
                await Promise.all(unsubPromises);
                console.log('All unsubscribe operations completed');
            } catch (error) {
                console.error('Error during unsubscribe operations:', error);
                // Continue with cleanup even if some unsubscribes failed
            }
        }
        
        // Update our subscriptions array to only include valid ones
        this.subscriptions = finalSubs;
        
        // Rebuild the subscription map to ensure consistency
        this.subscriptionMap.clear();
        for (const [key, sub] of uniqueKeys.entries()) {
            this.subscriptionMap.set(key, sub);
        }
        
        console.log(`After cleanup: ${this.subscriptions.length} active subscriptions`);
    }

    /**
     * Initialize pool subscriptions from database
     */
    public async initDBPoolsSubscriptions() {
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
            throw error;
        }
    }

    /**
     * Subscribe to buy events
     */
    public async subscribeToBuys() {
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
                    
                    // Check if log is undefined or missing topics
                    if (!log || !log.topics || !log.topics.length) {
                        console.error('Received invalid log object in buy event:', log);
                        return;
                    }
                    
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

                    // This method should be passed to the event fetcher to handle
                    // as it requires additional logic specific to the EventFetcher class
                    // We'll emit an event or call a callback function that EventFetcher provides
                    this.emitBuyEvent(decodedLog, txHash);
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

    /**
     * Subscribe to new pool events
     */
    public async subscribeToNewPools() {
        try {
            const fourMemeNewPoolsSub = await this.web3.eth.subscribe('logs', {
                address: this.fourMemeCA,
                topics: [newPoolTopic]
            });
            
            this.subscriptions.push(fourMemeNewPoolsSub);
            
            fourMemeNewPoolsSub.on('data', async (log) => {
                try {
                    console.log('Raw log:', log);
                    
                    // Check if log is undefined or missing topics
                    if (!log || !log.topics || !log.topics.length) {
                        console.error('Received invalid log object in new pool event:', log);
                        return;
                    }

                    const eventAbi = this.fourMemeContract.options.jsonInterface.find((item: any) => item.signature === log.topics[0]);
                    if (eventAbi) {
                        const decodedLog = this.web3.eth.abi.decodeLog(eventAbi.inputs, log.data, log.topics.slice(1));
                        console.log('Decoded log:', decodedLog);
                        
                        // This method should be passed to the event fetcher to handle
                        // as it requires additional logic specific to the EventFetcher class
                        this.emitNewPoolEvent(decodedLog);
                    } else {
                        console.error('Event ABI not found for signature:', log.topics[0]);
                    }
                } catch (error) {
                    console.error('Error processing new pool event:', error);
                }
            });
            
            fourMemeNewPoolsSub.on('error', (error) => {
                console.error('Error fetching new pool events:', error);
            });
            
            return fourMemeNewPoolsSub;
        } catch (error) {
            console.error('Failed to subscribe to new pool events:', error);
            throw error;
        }
    }

    /**
     * Subscribe to V2 pool events
     */
    public async subscribeToPoolV2(poolAddress: string) {
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
                    
                    // Check if log is undefined or missing transactionHash
                    if (!log) {
                        console.error(`Received undefined log object in V2 pool event for ${poolAddress}`);
                        return;
                    }
                    
                    if (!log.transactionHash) {
                        console.error(`Missing transactionHash in V2 pool event for ${poolAddress}:`, log);
                        return;
                    }
                    
                    // Get the transaction hash from the log for deduplication
                    const txHash = String(log.transactionHash);
                    console.log(`V2 Transaction hash: ${txHash}`);
                    
                    // This method should be passed to the event fetcher to handle
                    // as it requires additional logic specific to the EventFetcher class
                    this.emitPoolV2Event(poolAddress, log, txHash);
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

    /**
     * Subscribe to V3 pool events
     */
    public async subscribeToPool(poolAddress: string) {
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
                    
                    // Check if log is undefined or missing transactionHash
                    if (!log) {
                        console.error(`Received undefined log object in V3 pool event for ${poolAddress}`);
                        return;
                    }
                    
                    if (!log.transactionHash) {
                        console.error(`Missing transactionHash in V3 pool event for ${poolAddress}:`, log);
                        return;
                    }
                    
                    // Get the transaction hash from the log for deduplication
                    const txHash = String(log.transactionHash);
                    console.log(`Transaction hash: ${txHash}`);
                    
                    // This method should be passed to the event fetcher to handle
                    // as it requires additional logic specific to the EventFetcher class
                    this.emitPoolV3Event(poolAddress, log, txHash);
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
     * Add a subscription with duplicate checking
     * @param subscription The WebSocket subscription to add
     * @param address The contract address for the subscription
     * @param topic The topic for the subscription
     * @returns The active subscription (either existing or new)
     */
    public trackSubscription(subscription: any, address: string, topic: string): any {
        if (!address || !topic) {
            console.log('Cannot track subscription without address and topic');
            this.subscriptions.push(subscription);
            return subscription;
        }
        
        const key = `${address.toLowerCase()}-${topic}`;
        
        // Check if we already have this subscription
        if (this.subscriptionMap.has(key)) {
            console.log(`Already subscribed to ${address} for topic ${topic}`);
            
            // Get the existing subscription
            const existingSub = this.subscriptionMap.get(key);
            
            // Check if the existing subscription is still valid
            let existingSubValid = false;
            try {
                // Attempt to check if the subscription is still valid
                // This is a basic check - the subscription object should have an id
                existingSubValid = existingSub && existingSub.id && 
                    // Check if it's in the web3 subscription manager
                    this.web3.subscriptionManager?.subscriptions?.has(existingSub.id);
            } catch (error) {
                console.error(`Error checking existing subscription validity: ${error}`);
                existingSubValid = false;
            }
            
            if (existingSubValid) {
                try {
                    // Unsubscribe from the new one since we already have a valid one
                    subscription.unsubscribe((error: any, success: boolean) => {
                        if (error) {
                            console.error(`Error unsubscribing from duplicate: ${error}`);
                        } else if (success) {
                            console.log(`Successfully unsubscribed from duplicate: ${key}`);
                        }
                    });
                    
                    // Return the existing subscription
                    return existingSub;
                } catch (error) {
                    console.error(`Error unsubscribing from duplicate: ${error}`);
                    // If unsubscribe failed, we'll replace the existing one with the new one
                }
            } else {
                console.log(`Existing subscription for ${key} is invalid, replacing it`);
                // Remove the invalid subscription from our tracking
                const index = this.subscriptions.indexOf(existingSub);
                if (index > -1) {
                    this.subscriptions.splice(index, 1);
                }
                // Continue with the new subscription
            }
        }
        
        // Store the new subscription in our map and array
        this.subscriptionMap.set(key, subscription);
        this.subscriptions.push(subscription);
        console.log(`Tracking new subscription for ${address} with topic ${topic}, ID: ${subscription.id || 'unknown'}`);
        
        return subscription;
    }

    /**
     * Check if a message is a duplicate with more robust checking
     */
    public isDuplicateMessage(message: BuyMessageData, txHash?: string): boolean {
        if (!message) return false;
        
        // If we have a transaction hash, use that for strongest deduplication
        if (txHash) {
            const now = Date.now();
            if (this.processedTxHashes.has(txHash)) {
                console.log(`Detected duplicate transaction: ${txHash}`);
                return true;
            }
            
            // Only add to processed tx hashes if it's not a duplicate
            this.processedTxHashes.set(txHash, now);
            
            // Clean up tx hash map periodically based on time (older than 10 minutes) and size
            const TEN_MINUTES = 10 * 60 * 1000;
            if (this.processedTxHashes.size > 1000) {
                let cleanupCount = 0;
                // Remove entries older than 10 minutes
                for (const [hash, timestamp] of this.processedTxHashes.entries()) {
                    if (now - timestamp > TEN_MINUTES) {
                        this.processedTxHashes.delete(hash);
                        cleanupCount++;
                    }
                }
                
                // If we still have too many entries, remove the oldest ones
                if (this.processedTxHashes.size > 1000) {
                    const oldestEntries = Array.from(this.processedTxHashes.entries())
                        .sort((a, b) => a[1] - b[1])
                        .slice(0, 100);
                    
                    oldestEntries.forEach(([hash]) => {
                        this.processedTxHashes.delete(hash);
                        cleanupCount++;
                    });
                }
                
                if (cleanupCount > 0) {
                    console.log(`Cleaned up ${cleanupCount} old transaction hashes. Remaining: ${this.processedTxHashes.size}`);
                }
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

    // Track the last seen block to prevent duplicate processing
    private lastSeenBlocks: Map<string, number> = new Map();
    private blockHeaderSubscription: any = null;
    
    /**
     * Subscribe to new block headers
     */
    public async subscribeToNewBlockHeaders() {
        try {
            console.log('Subscribing to new block headers...');
            
            // Check if we already have an active block header subscription
            if (this.blockHeaderSubscription) {
                console.log('Block header subscription already exists, unsubscribing first');
                try {
                    await this.blockHeaderSubscription.unsubscribe();
                    
                    // Remove from subscriptions array
                    const index = this.subscriptions.indexOf(this.blockHeaderSubscription);
                    if (index > -1) {
                        this.subscriptions.splice(index, 1);
                    }
                    
                    this.blockHeaderSubscription = null;
                } catch (error) {
                    console.error('Error unsubscribing from existing block header subscription:', error);
                    // Continue with creating a new subscription even if unsubscribe fails
                }
            }
            
            // Create new subscription
            const newBlockHeadersSub = await this.web3.eth.subscribe('newBlockHeaders');
            
            // Store reference to subscription
            this.blockHeaderSubscription = newBlockHeadersSub;
            
            // Add to subscriptions array
            this.subscriptions.push(newBlockHeadersSub);
            
            newBlockHeadersSub.on('data', (blockHeader) => {
                try {
                    if (!blockHeader || !blockHeader.number || !blockHeader.hash) {
                        console.warn('Received invalid block header:', blockHeader);
                        return;
                    }
                    
                    // Check if we've already seen this block
                    const blockNumber = Number(blockHeader.number);
                    const blockHash = blockHeader.hash;
                    
                    // Use a unique key combining block number and hash
                    const blockKey = `${blockNumber}-${blockHash}`;
                    
                    if (this.lastSeenBlocks.has(blockKey)) {
                        // Skip processing for blocks we've already seen
                        console.debug(`Skipping duplicate block: ${blockNumber} (${blockHash.substring(0, 10)}...)`);
                        return;
                    }
                    
                    // Add to seen blocks with timestamp
                    const now = Date.now();
                    this.lastSeenBlocks.set(blockKey, now);
                    
                    // Clean up old entries based on time (older than 30 minutes) and size
                    const THIRTY_MINUTES = 30 * 60 * 1000;
                    let cleanupCount = 0;
                    
                    // First remove entries older than 30 minutes
                    for (const [key, timestamp] of this.lastSeenBlocks.entries()) {
                        if (now - timestamp > THIRTY_MINUTES) {
                            this.lastSeenBlocks.delete(key);
                            cleanupCount++;
                        }
                    }
                    
                    // Then ensure we don't exceed max size (100 blocks)
                    if (this.lastSeenBlocks.size > 100) {
                        const oldestEntries = Array.from(this.lastSeenBlocks.entries())
                            .sort((a, b) => a[1] - b[1])
                            .slice(0, this.lastSeenBlocks.size - 100);
                            
                        oldestEntries.forEach(([key]) => {
                            this.lastSeenBlocks.delete(key);
                            cleanupCount++;
                        });
                    }
                    
                    if (cleanupCount > 0) {
                        console.log(`Cleaned up ${cleanupCount} old block entries. Remaining: ${this.lastSeenBlocks.size}`);
                    }
                    
                    console.log('New block header received:', {
                        number: blockNumber,
                        hash: blockHash.substring(0, 10) + '...',
                        timestamp: blockHeader.timestamp,
                        gasUsed: blockHeader.gasUsed,
                        seenBlocks: this.lastSeenBlocks.size
                    });
                } catch (error) {
                    console.error('Error processing new block header:', error);
                }
            });
            
            newBlockHeadersSub.on('error', (error) => {
                console.error('Error in new block headers subscription:', error);
                // Remove the faulty subscription from our array
                const index = this.subscriptions.indexOf(newBlockHeadersSub);
                if (index > -1) {
                    this.subscriptions.splice(index, 1);
                }
                this.blockHeaderSubscription = null;
                
                // Attempt to re-subscribe after a short delay
                setTimeout(() => {
                    console.log('Attempting to re-subscribe to block headers after error...');
                    this.subscribeToNewBlockHeaders().catch(err => {
                        console.error('Failed to re-subscribe to block headers:', err);
                    });
                }, 5000); // 5 second delay
            });
            
            console.log('Successfully subscribed to new block headers');
            return newBlockHeadersSub;
        } catch (error) {
            console.error('Failed to subscribe to new block headers:', error);
            
            // Attempt to re-subscribe after a short delay
            setTimeout(() => {
                console.log('Attempting to re-subscribe to block headers after failure...');
                this.subscribeToNewBlockHeaders().catch(err => {
                    console.error('Failed to re-subscribe to block headers:', err);
                });
            }, 5000); // 5 second delay
            
            throw error;
        }
    }
    
    // Event emitters for the EventFetcher to handle
    private emitBuyEvent(decodedLog: any, txHash: string) {
        if (this.onBuyEvent) {
            this.onBuyEvent(decodedLog, txHash);
        }
    }

    private emitNewPoolEvent(decodedLog: any) {
        if (this.onNewPoolEvent) {
            this.onNewPoolEvent(decodedLog);
        }
    }

    private emitPoolV2Event(poolAddress: string, log: any, txHash: string) {
        if (this.onPoolV2Event) {
            this.onPoolV2Event(poolAddress, log, txHash);
        }
    }

    private emitPoolV3Event(poolAddress: string, log: any, txHash: string) {
        if (this.onPoolV3Event) {
            this.onPoolV3Event(poolAddress, log, txHash);
        }
    }

    // Callback handlers
    public onBuyEvent: ((decodedLog: any, txHash: string) => void) | null = null;
    public onNewPoolEvent: ((decodedLog: any) => void) | null = null;
    public onPoolV2Event: ((poolAddress: string, log: any, txHash: string) => void) | null = null;
    public onPoolV3Event: ((poolAddress: string, log: any, txHash: string) => void) | null = null;
}

export default SubscriptionManager;
