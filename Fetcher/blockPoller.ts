import Web3 from 'web3';
import { getAllActiveTokens, getAllConfigPools, getTokenInfoFromDB } from '../DB/queries';
import EventDecoder from './eventDecoder';
import { BuyMessageData, TokenInfo } from '../types/types';
import fs from 'fs';
import path from 'path';
import Web3HttpProvider from 'web3-providers-http';
import { WebSocketServer } from './websocketServer';
import { PoolSwapHandler } from './poolSwapHandler';
import { CommonWeb3, WBNB } from '../CommonWeb3/common';
import { MemeSwapHandler } from './memeSwapHandler';
import { toChecksumAddress } from 'web3-utils';

// Define a type for Web3 logs to make TypeScript happy
interface Web3Log {
    address: string;
    data: string;
    topics: string[];
    logIndex: string | number;
    transactionIndex: string | number;
    transactionHash: string;
    blockHash: string;
    blockNumber: string | number;
    removed?: boolean;
}

// Define topics as constants
export const buyTopic = '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942';
export const newPoolTopic = '0xc18aa71171b358b706fe3dd345299685ba21a5316c66ffa9e319268b033c44b0';
export const swapV3Topic = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
export const swapV2Topic = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

/**
 * BlockPoller class replaces WebSocket subscriptions with a polling approach
 * It periodically checks for new blocks and fetches logs for relevant events
 */
export class BlockPoller {
    private web3: Web3;
    private eventDecoder: EventDecoder;
    private fourMemeCA: string;
    private fourMemeContract: any;
    private pollingInterval: NodeJS.Timeout | null = null;
    private lastProcessedBlock: number = 0;
    private isPolling: boolean = false;
    private processedTxHashes: Set<string> = new Set();
    private readonly POLLING_FREQUENCY = 5000; // 5 seconds
    private readonly MAX_BLOCKS_PER_POLL = 10; // Maximum blocks to process in one poll
    private readonly TX_HASH_CACHE_LIMIT = 1000; // Maximum number of tx hashes to keep in memory
    private ws: WebSocketServer;
    private poolSwapHandler: PoolSwapHandler;
    private commonWeb3: CommonWeb3;
    
    // Event handlers with WebSocket broadcasting
    public onBuyEvent = async (decodedLog: Record<string, any>, txHash: string): Promise<void> => {
        try {
            console.log('Buy event detected:', decodedLog);
            
            // Get token info from database
            const tokenInfo = await getTokenInfoFromDB(decodedLog.token);
            if (!tokenInfo) {
                console.error(`Token info not found for ${decodedLog.token}`);
                return;
            }
            
            // Create buy message data that matches the BuyMessageData interface
            const buyMessage: BuyMessageData = await new MemeSwapHandler().processBuyEvent(decodedLog, txHash);
            
            // Broadcast to WebSocket clients
            this.ws.broadcast('NewBuy', buyMessage);
        } catch (error) {
            console.error('Error in onBuyEvent:', error);
        }
    };
    
    public onNewPoolEvent = async (decodedLog: Record<string, any>): Promise<void> => {
        try {
            console.log('New pool event detected:', decodedLog);
            
            // Extract token address from the decoded log
            const tokenCA = String(decodedLog.base || decodedLog.token);
            if (!tokenCA) {
                console.error('Token address not found in new pool event:', decodedLog);
                return;
            }
            
            // Get pool addresses for this token
            const pools = await this.commonWeb3.getPoolAddresses(tokenCA);
            
            // Process each pool
            for (const poolAddress of pools) {
                try {
                    // Get pool details
                    const poolDetails = await this.commonWeb3.getPoolDetails(poolAddress);
                    
                    // Insert pool into database
                    // Note: You might need to implement this if it's not already available
                    // await insertPool(poolDetails);
                    
                    // Update group configs with new pools
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
                } catch (error) {
                    console.error(`Error processing pool ${poolAddress} for token ${tokenCA}:`, error);
                }
            }
        } catch (error) {
            console.error('Error in onNewPoolEvent:', error);
        }
    };
    
    public onPoolV2Event = async (poolAddress: string, log: any, txHash: string): Promise<void> => {
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
                    if (buyMessage) {
                        this.ws.broadcast('NewBuy', buyMessage);
                    } else {
                        console.log(`Skipping duplicate buy broadcast for`);
                    }
                }
            }
        } catch (error) {
            console.error(`Error processing V2 pool event for ${poolAddress}:`, error);
        }
    };
    
    public onPoolV3Event = async (poolAddress: string, log: any, txHash: string): Promise<void> => {
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
                    if (buyMessage) {
                        this.ws.broadcast('NewBuy', buyMessage);
                    }
                }
            }
        } catch (error) {
            console.error(`Error processing V3 pool event for ${poolAddress}:`, error);
        }
    };
    
    constructor() {
        this.web3 = new Web3(new Web3HttpProvider(process.env.HTTPS_WEB3_PROVIDER || ""));
        this.fourMemeCA = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
        const fourMemeAbi = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi', 'TokenManager2.lite.abi'), 'utf-8')
        );
        this.fourMemeContract = new this.web3.eth.Contract(fourMemeAbi, this.fourMemeCA);
        this.eventDecoder = new EventDecoder(this.web3);
        this.ws = new WebSocketServer();
        this.poolSwapHandler = new PoolSwapHandler();
        this.commonWeb3 = new CommonWeb3();
    }
    
    /**
     * Start polling for new blocks
     */
    public async start(): Promise<void> {
        try {
            if (this.isPolling) {
                console.log('Block polling is already running');
                return;
            }
            
            // Get the current block number as our starting point
            const currentBlock = await this.web3.eth.getBlockNumber();
            this.lastProcessedBlock = Number(currentBlock);
            console.log(`Starting block polling from block ${this.lastProcessedBlock}`);
            
            this.isPolling = true;
            
            // Start the polling interval
            this.pollingInterval = setInterval(() => this.pollForNewBlocks(), this.POLLING_FREQUENCY);
            
            // Do an initial poll immediately
            this.pollForNewBlocks();
        } catch (error) {
            console.error('Error starting block polling:', error);
            throw error;
        }
    }
    
    /**
     * Stop polling for new blocks
     */
    public stop(): void {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        this.isPolling = false;
        console.log('Block polling stopped');
    }
    
    /**
     * Poll for new blocks and process events
     */
    private async pollForNewBlocks(): Promise<void> {
        try {
            // Skip if we're already processing a poll
            if (!this.isPolling) return;
            
            // Get the current block number
            const currentBlock = await this.web3.eth.getBlockNumber();
            
            // If no new blocks, skip processing
            if (currentBlock <= this.lastProcessedBlock) {
                console.log(`No new blocks since ${this.lastProcessedBlock}`);
                return;
            }
            
            // Calculate the range of blocks to process
            const fromBlock = this.lastProcessedBlock + 1;
            // Limit the number of blocks we process at once to avoid timeouts
            const toBlock = Math.min(Number(currentBlock), fromBlock + this.MAX_BLOCKS_PER_POLL - 1);
            
            console.log(`Processing blocks from ${fromBlock} to ${toBlock}`);
            
            // Process all relevant events in these blocks
            await Promise.all([
                this.processBuyEvents(fromBlock, toBlock),
                this.processNewPoolEvents(fromBlock, toBlock),
                this.processPoolSwapEvents(fromBlock, toBlock)
            ]);
            
            // Update the last processed block
            this.lastProcessedBlock = toBlock;
            
            // Prune the processed tx hashes cache if it gets too large
            this.pruneProcessedTxHashes();
            
        } catch (error) {
            console.error('Error polling for new blocks:', error);
        }
    }
    
    /**
     * Process buy events in the given block range
     */
    private async processBuyEvents(fromBlock: number, toBlock: number): Promise<void> {
        try {
            // Get logs for buy events
            const buyLogs = await this.web3.eth.getPastLogs({
                fromBlock,
                toBlock,
                address: this.fourMemeCA,
                topics: [buyTopic]
            });
            
            console.log(`Found ${buyLogs.length} buy events in blocks ${fromBlock}-${toBlock}`);
            
            // Process each buy event
            for (const log of buyLogs) {
                const result = this.safelyProcessLog(
                    log,
                    (validLog) => {
                        const txHash = validLog.transactionHash;
                        
                        // Skip if already processed
                        if (this.processedTxHashes.has(txHash)) {
                            return null;
                        }
                        
                        // Decode the log data
                        const decodedLog = this.fourMemeContract.options.jsonInterface.find(
                            (item: any) => item.signature === buyTopic
                        );
                        
                        if (decodedLog && decodedLog.inputs && validLog.data && validLog.topics) {
                            const decoded = this.web3.eth.abi.decodeLog(
                                decodedLog.inputs,
                                validLog.data,
                                validLog.topics.slice(1)
                            );
                            
                            // Call the buy event handler
                            this.onBuyEvent(decoded, txHash);
                            
                            // Mark this transaction as processed
                            this.processedTxHashes.add(txHash);
                        }
                        
                        return true;
                    },
                    (error, txHash) => {
                        console.error(`Error processing buy event in tx ${txHash}:`, error);
                    }
                );
            }
        } catch (error) {
            console.error(`Error fetching buy events for blocks ${fromBlock}-${toBlock}:`, error);
        }
    }
    
    /**
     * Process new pool events in the given block range
     */
    private async processNewPoolEvents(fromBlock: number, toBlock: number): Promise<void> {
        try {
            // Get logs for new pool events
            const newPoolLogs = await this.web3.eth.getPastLogs({
                fromBlock,
                toBlock,
                address: this.fourMemeCA,
                topics: [newPoolTopic]
            });
            
            console.log(`Found ${newPoolLogs.length} new pool events in blocks ${fromBlock}-${toBlock}`);
            
            // Process each new pool event
            for (const log of newPoolLogs) {
                const result = this.safelyProcessLog(
                    log,
                    (validLog) => {
                        const txHash = validLog.transactionHash;
                        
                        // Skip if already processed
                        if (this.processedTxHashes.has(txHash)) {
                            return null;
                        }
                        
                        // Decode the log data
                        const decodedLog = this.fourMemeContract.options.jsonInterface.find(
                            (item: any) => item.signature === newPoolTopic
                        );
                        
                        if (decodedLog && decodedLog.inputs && validLog.data && validLog.topics) {
                            const decoded = this.web3.eth.abi.decodeLog(
                                decodedLog.inputs,
                                validLog.data,
                                validLog.topics.slice(1)
                            );
                            
                            // Call the new pool event handler
                            this.onNewPoolEvent(decoded);
                            
                            // Mark this transaction as processed
                            this.processedTxHashes.add(txHash);
                        }
                        
                        return true;
                    },
                    (error, txHash) => {
                        console.error(`Error processing new pool event in tx ${txHash}:`, error);
                    }
                );
            }
        } catch (error) {
            console.error(`Error processing new pool events for blocks ${fromBlock}-${toBlock}:`, error);
        }
    }
    
    /**
     * Process pool swap events in the given block range
     */
    private async processPoolSwapEvents(fromBlock: number, toBlock: number): Promise<void> {
        try {
            // Get all active pool addresses to monitor
            const configPools = await getAllConfigPools();
            const poolAddresses = configPools.map(pool => pool.address);
            
            if (poolAddresses.length === 0) {
                console.log('No pool addresses to monitor for swap events');
                return;
            }
            
            // Process pools in batches to avoid request size limitations
            const batchSize = 50;
            for (let i = 0; i < poolAddresses.length; i += batchSize) {
                const batchAddresses = poolAddresses.slice(i, i + batchSize);
                
                // Get V3 swap logs
                try {
                    const v3SwapLogs = await this.web3.eth.getPastLogs({
                        fromBlock,
                        toBlock,
                        address: batchAddresses,
                        topics: [swapV3Topic]
                    });
                    
                    console.log(`Found ${v3SwapLogs.length} V3 swap events for batch ${i/batchSize + 1}/${Math.ceil(poolAddresses.length/batchSize)}`);
                    
                    // Process each V3 swap event
                    for (const log of v3SwapLogs) {
                        const result = this.safelyProcessLog(
                            log,
                            (validLog) => {
                                const txHash = validLog.transactionHash;
                                const address = toChecksumAddress(validLog.address);
                                
                                // Skip if already processed
                                if (this.processedTxHashes.has(txHash)) {
                                    return null;
                                }
                                
                                // Call the pool V3 event handler
                                this.onPoolV3Event(address, log as any, txHash);
                                
                                // Mark this transaction as processed
                                this.processedTxHashes.add(txHash);
                                
                                return true;
                            },
                            (error, txHash) => {
                                console.error(`Error processing V3 swap event in tx ${txHash}:`, error);
                            }
                        );
                    }
                } catch (error) {
                    const batchNumber = Math.floor(i/batchSize) + 1;
                    console.error(`Error fetching V3 swap events for batch ${batchNumber}:`, error);
                }
                
                // Get V2 swap logs
                try {
                    const v2SwapLogs = await this.web3.eth.getPastLogs({
                        fromBlock,
                        toBlock,
                        address: batchAddresses,
                        topics: [swapV2Topic]
                    });
                    
                    console.log(`Found ${v2SwapLogs.length} V2 swap events for batch ${i/batchSize + 1}/${Math.ceil(poolAddresses.length/batchSize)}`);
                    
                    // Process each V2 swap event
                    for (const log of v2SwapLogs) {
                        const result = this.safelyProcessLog(
                            log,
                            (validLog) => {
                                const txHash = validLog.transactionHash;
                                const address = toChecksumAddress(validLog.address);
                                
                                // Skip if already processed
                                if (this.processedTxHashes.has(txHash)) {
                                    return null;
                                }
                                
                                // Call the pool V2 event handler
                                this.onPoolV2Event(address, log as any, txHash);
                                
                                // Mark this transaction as processed
                                this.processedTxHashes.add(txHash);
                                
                                return true;
                            },
                            (error, txHash) => {
                                console.error(`Error processing V2 swap event in tx ${txHash}:`, error);
                            }
                        );
                    }
                } catch (error) {
                    const batchNumber = Math.floor(i/batchSize) + 1;
                    console.error(`Error fetching V2 swap events for batch ${batchNumber}:`, error);
                }
            }
        } catch (error) {
            console.error(`Error processing pool swap events for blocks ${fromBlock}-${toBlock}:`, error);
        }
    }
    
    /**
     * Helper function to safely process logs
     */
    private safelyProcessLog<T>(
        log: any, 
        processor: (log: Web3Log) => T, 
        errorHandler: (error: any, txHash?: string) => void
    ): T | null {
        try {
            // Skip if invalid log format
            if (!log || typeof log === 'string' || !('transactionHash' in log)) {
                console.error('Invalid log format:', log);
                return null;
            }
            
            // Ensure transactionHash is a string
            const txHash = log.transactionHash as string;
            if (!txHash) {
                console.error('Missing transaction hash in log:', log);
                return null;
            }
            
            return processor(log as Web3Log);
        } catch (error) {
            const txHash = typeof log === 'string' ? 'unknown' : (log?.transactionHash as string || 'unknown');
            errorHandler(error, txHash);
            return null;
        }
    }
    
    /**
     * Check if a transaction has already been processed
     */
    public isTransactionProcessed(txHash: string): boolean {
        return this.processedTxHashes.has(txHash);
    }
    
    /**
     * Prune the processed tx hashes cache to prevent memory leaks
     */
    private pruneProcessedTxHashes(): void {
        if (this.processedTxHashes.size > this.TX_HASH_CACHE_LIMIT) {
            // Convert to array, keep only the most recent entries
            const txArray = Array.from(this.processedTxHashes);
            const prunedTxArray = txArray.slice(txArray.length - this.TX_HASH_CACHE_LIMIT);
            
            // Clear and rebuild the set
            this.processedTxHashes.clear();
            for (const tx of prunedTxArray) {
                this.processedTxHashes.add(tx);
            }
            
            console.log(`Pruned processed tx hashes cache from ${txArray.length} to ${this.processedTxHashes.size} entries`);
        }
    }
}

export default BlockPoller;
