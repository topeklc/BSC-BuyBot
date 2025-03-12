import Web3 from 'web3';




// try {
//     // Load the V2 factory ABI
//     this.poolAbiV2 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','poolV2.abi'), 'utf-8'));
    
//     // Load the dedicated V3 pool events ABI file
//     try {
//         this.poolAbiV3 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../CommonWeb3/abi','poolV3.abi'), 'utf-8'));
//     } catch (error) {
//         console.error("Error loading V3 pool events ABI:", error);
//         // Define swap event manually if file can't be loaded
//         this.poolAbiV3 = [{
//             "anonymous": false,
//             "inputs": [
//                 { "indexed": true, "name": "sender", "type": "address" },
//                 { "indexed": true, "name": "recipient", "type": "address" },
//                 { "indexed": false, "name": "amount0", "type": "int256" },
//                 { "indexed": false, "name": "amount1", "type": "int256" },
//                 { "indexed": false, "name": "sqrtPriceX96", "type": "uint160" },
//                 { "indexed": false, "name": "liquidity", "type": "uint128" },
//                 { "indexed": false, "name": "tick", "type": "int24" }
//             ],
//             "name": "Swap",
//             "type": "event"
//         }];
//     }
    
//     // Initialize the EventDecoder
//     this.eventDecoder = new EventDecoder(this.web3);
// } catch (error) {
//     console.error("Error loading ABIs:", error);
//     // Provide fallback definitions
//     this.poolAbiV3 = [{
//         "anonymous": false,
//         "inputs": [
//             { "indexed": true, "name": "sender", "type": "address" },
//             { "indexed": true, "name": "recipient", "type": "address" },
//             { "indexed": false, "name": "amount0", "type": "int256" },
//             { "indexed": false, "name": "amount1", "type": "int256" },
//             { "indexed": false, "name": "sqrtPriceX96", "type": "uint160" },
//             { "indexed": false, "name": "liquidity", "type": "uint128" },
//             { "indexed": false, "name": "tick", "type": "int24" }
//         ],
//         "name": "Swap",
//         "type": "event"
//     }];
    
//     // Initialize the EventDecoder even in case of error
//     this.eventDecoder = new EventDecoder(this.web3);
// }

/**
 * EventDecoder class handles the decoding of blockchain events from different protocols
 * It provides methods for decoding Uniswap V3 and PancakeSwap V2 swap events
 */
export class EventDecoder {
    private web3: Web3;

    constructor(web3: Web3) {
        this.web3 = web3;
    }

    /**
     * Decode Uniswap V3 Swap event data using Web3 ABI decoder
     */
    public decodeSwapEvent(data: string, topics: string[]): any {
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
    public manualDecodeSwapEvent(data: string, topics: string[] = []): any {
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
            
            return decoded;
        } catch (error) {
            console.error('Error in manual decoding of swap event:', error);
            return null;
        }
    }

    /**
     * Decode PancakeSwap V2 Swap event data using Web3 ABI decoder
     */
    public decodeSwapEventV2(data: string, topics: string[]): any {
        try {
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
    public manualDecodeSwapEventV2(data: string, topics: string[]): any {
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
            const sender = topics.length > 1 ? topics[1].replace('000000000000000000000000', '') : '0x0000000000000000000000000000000000000000';
            const to = topics.length > 2 ? topics[2].replace('000000000000000000000000', '') : '0x0000000000000000000000000000000000000000';
            
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
    public parseHexValue(hexSubstring: string): string {
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
}

export default EventDecoder;
