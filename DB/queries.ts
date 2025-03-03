import { postgres } from "./dbConnector";
import { Group, PoolDetail} from "../types/types";
import {WBNB} from '../CommonWeb3/common';
interface PoolInfo {
    address: string;
    token0: string;
    token1: string;
    fee: number;
    tickSpacing: number;
    pairName: string;
    version: number;
}

export const saveUser = async (userId: bigint, username: string) => {
    try {
        await postgres.query('INSERT INTO users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [userId, username]);
    }
    catch (err) {
        console.error('Error saving user:', err);
    }
    
}

export const updateUserCol = async (userId: bigint, col: string, value: any): Promise<void> => {
    try {
        const query = `UPDATE users SET ${col} = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`;
        await postgres.query(query, [value, userId]);
    } catch (err) {
        console.error('Error updating user:', err);
    }
}

export const upsertGroup = async (groupId: bigint, groupTitle: string, link: string): Promise<void> => {
    try {
        const query = `INSERT INTO groups (id, name, link) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = $2, link = $3, updated_at = CURRENT_TIMESTAMP`;
        await postgres.query(query, [groupId, groupTitle, link]);
    } catch (err) {
        console.error('Error upserting group:', err);
    }
}

export const upsertGroupUser = async (groupId: bigint, userId: bigint): Promise<void> => {
    try {
        const query = `INSERT INTO user_groups (group_id, user_id) VALUES ($1, $2) ON CONFLICT (group_id, user_id) DO NOTHING`;
        await postgres.query(query, [groupId, userId]);
    } catch (err) {
        console.error('Error upserting group user:', err);
    }
}

export const getAllConfigsForUser = async (userId: bigint) => {
    try { 
        const query = 'SELECT * FROM group_configs WHERE group_id IN (SELECT group_id FROM user_groups WHERE user_id = $1)';
        const result = await postgres.query(query, [userId]);
        return result.rows;
    } catch (err) {
        console.error('Error getting all configs for user:', err);
        return [];
    }
}

export const getConfigsForUserView = async (userId: bigint) => {
    try { 
        const query = 'SELECT group_configs.group_id as "configGroupId", COALESCE((SELECT name from tokens WHERE address = group_configs.address), group_configs.address) as "tokenName", COALESCE((SELECT name from groups WHERE id = group_configs.group_id), \'PRIVATE\') as "groupName" FROM group_configs WHERE group_id IN (SELECT group_id FROM user_groups WHERE user_id = $1)';
        const result = await postgres.query(query, [userId]);
        return result.rows;
    } catch (err) {
        console.error('Error getting all configs for user:', err);
        return [];
    }
}

export const handleGroupTypeChange = async (oldGroupId: bigint, group: Group): Promise<void> => {
    try {
        const query = `
            WITH old_user AS (
                SELECT user_id FROM user_groups WHERE group_id = $1
            ), upsert_group AS (
                INSERT INTO groups (id, name, link)
                VALUES ($2, $3, $4)
                ON CONFLICT (id) DO UPDATE
                SET name = EXCLUDED.name, link = EXCLUDED.link, updated_at = CURRENT_TIMESTAMP
            ), move_user AS (
                INSERT INTO user_groups (group_id, user_id)
                SELECT $2, user_id FROM old_user
                ON CONFLICT (group_id, user_id) DO NOTHING
            )
            DELETE FROM user_groups WHERE group_id = $1 AND user_id IN (SELECT user_id FROM old_user)
        `;
        
        await postgres.query(query, [oldGroupId, group.id, group.name, group.link]);
    } catch (err) {
        console.error('Error handling group type change:', err);
        throw err;
    }
}

export const upsertToken = async (token: {
    address: string;
    decimals: number;
    name: string;
    symbol: string;
    totalSupply: string;
    owner: string;
    poolAddresses?: string[];
}): Promise<void> => {
    try {
        const query = `
            INSERT INTO tokens (
                address,
                decimals,
                name,
                symbol,
                total_supply,
                owner,
                pools
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (address) 
            DO UPDATE SET
                total_supply = $5,
                pools = $7,
                updated_at = CURRENT_TIMESTAMP
        `;

        const values = [
            token.address,
            token.decimals,
            token.name,
            token.symbol,
            token.totalSupply,
            token.owner,
            token.poolAddresses || []
        ];

        await postgres.query(query, values);
    } catch (error) {
        console.error('Error in upsertToken:', error);
    }
}

export const getGroupConfig = async (groupId: bigint) => {
    try {
        const query = 'SELECT * FROM group_configs WHERE group_id = $1';
        const result = await postgres.query(query, [groupId]);
        return result.rows[0];
    } catch (err) {
        console.error('Error getting group config:', err);
    }
}

export const getAllActiveTokens = async () => {
    try {
        const query = 'SELECT DISTINCT address FROM group_configs WHERE active = true';
        const result = await postgres.query(query);
        // Return an array of addresses instead of just the first row
        return result.rows.map((row: { address: string }) => row.address);
    } catch (err) {
        console.error('Error getting active tokens:', err);
        return []; // Return empty array on error to avoid further errors
    }
}

export const getGroupData = async (groupId: bigint) => {
    try {
        const query = 'SELECT * FROM groups WHERE id = $1';
        const result = await postgres.query(query, [groupId]);
        return result.rows[0];
    } catch (err) {
        console.error('Error getting group config:', err);
    }
}
export const getGroupConfigByField = async (field: string, value: any) => {
    try {
        const query = `SELECT * FROM group_configs WHERE ${field} = $1`;
        const result = await postgres.query(query, [value]);
        return result.rows;
    } catch (err) {
        console.error(`Error getting group config by field ${field}:`, err);
        return [];
    }
}

export const insertDefaultGroupConfig = async (groupId: bigint, address: string): Promise<void> => {
    try {
        // First, check if the token exists in the tokens table
        const tokenExists = await postgres.query(
            'SELECT EXISTS(SELECT 1 FROM tokens WHERE address = $1)',
            [address]
        );
        
        // If token doesn't exist, insert a placeholder record
        if (!tokenExists.rows[0].exists) {
            console.log(`Token ${address} does not exist in the database. Creating placeholder.`);
            await postgres.query(
                'INSERT INTO tokens (address, decimals, name, symbol, total_supply, owner, pools) VALUES ($1, 0, $2, $2, \'0\', \'unknown\', $3)',
                [address, `Token_${address.substring(0, 8)}`, []]
            );
        }

        const pools = await getPoolsForToken(address);
        const defaultSocials = JSON.stringify({
            website: null,
            telegram: null,
            x: null,
        });

        // First check if a config already exists
        const existingConfig = await getGroupConfig(groupId);
        if (existingConfig) {
            console.log('Group config already exists');
        } else {
            // If doesn't exist, insert new
            const query = `
                INSERT INTO group_configs (
                    group_id, 
                    address,
                    pools, 
                    socials,
                    emoji,
                    min_amount
                ) VALUES ($1, $2, $3, $4, '🚀', 0)
            `;
            const poolsJson = pools.map(p => JSON.stringify(p));
            await postgres.query(query, [groupId, address, poolsJson, defaultSocials]);
        }
    } catch (err) {
        console.error('Error inserting/updating default group config:', err);
        throw err;
    }
}

export const updateGroupConfig = async (groupId: bigint, field: string, value: any): Promise<void> => {
    try {
        // First ensure group_config exists
        const existingConfig = await getGroupConfig(groupId);
        if (!existingConfig) {
            throw new Error('No group config found for this group');
        }

        let query;
        if (field === 'pools') {
            query = `UPDATE group_configs SET ${field} = $1::varchar[], updated_at = CURRENT_TIMESTAMP WHERE group_id = $2`;
        } else if (['website', 'telegram', 'x'].includes(field)) {
            // Handle social media updates by updating the JSONB field
            query = `
                UPDATE group_configs 
                SET socials = jsonb_set(
                    COALESCE(socials, '{}'::jsonb),
                    '{${field}}',
                    $1::jsonb,
                    true
                ),
                updated_at = CURRENT_TIMESTAMP 
                WHERE group_id = $2
            `;
            // Convert the value to a JSON string or null
            value = value ? JSON.stringify(value) : 'null';
        } else {
            query = `UPDATE group_configs SET ${field} = $1, updated_at = CURRENT_TIMESTAMP WHERE group_id = $2`;
        }
        console.log('Updating group config:', { groupId, field, value, query });
        await postgres.query(query, [value, groupId]);
    } catch (err) {
        console.error('Error updating group config:', err);
    }
}

export const getCurrentGroupId = async (userId: number): Promise<bigint | null> => {
    try {
        const result = await postgres.query(
            'SELECT currently_setting FROM users WHERE id = $1',
            [userId]
        );
        return result.rows[0]?.currently_setting || null;
    } catch (err) {
        console.error('Error getting current group ID:', err);
        return null;
    }
};

export const getPoolsForToken = async (tokenAddress: string): Promise<PoolInfo[]> => {
    try {
        const query = `
        SELECT 
            p.address, p.version, p.token0_address, p.token1_address, p.fee, p.tick_spacing,
                    CASE 
                        WHEN p.token0_address = $1 THEN CONCAT(t1.symbol, '/', t2.symbol, '/', p.version)
                        ELSE CONCAT(t2.symbol, '/', t1.symbol, '/', p.version)
                    END as pair_name
        FROM pools p
        JOIN tokens t1 ON p.token0_address = t1.address
        JOIN tokens t2 ON p.token1_address = t2.address
        WHERE p.token0_address = $1 OR p.token1_address = $1
    `;
        
        const result = await postgres.query(query, [tokenAddress]);
        return result.rows.map((row: any) => ({
            address: row.address,
            token0:row.token0_address,
            token1:row.token1_address,
            fee: row.fee,
            tickSpacing: row.tick_spacing,
            pairName: row.pair_name,
            version: row.version
        }));
    } catch (err) {
        console.error('Error getting pools for token:', err);
        return [];
    }
}

export const insertPool = async (pool: PoolDetail): Promise<void> => {
    try {
        // First, check if a pool with this address already exists to avoid conflicts
        const checkQuery = 'SELECT COUNT(*) FROM pools WHERE address = $1';
        const checkResult = await postgres.query(checkQuery, [pool.address]);
        
        if (parseInt(checkResult.rows[0].count) > 0) {
            console.log(`Pool ${pool.address} already exists in database, skipping insert`);
            return;
        }
        
        // Validate that version is explicitly set
        if (pool.version === undefined || pool.version === null) {
            console.error(`Cannot insert pool ${pool.address}: version must be explicitly set`);
            throw new Error('Pool version must be explicitly set');
        }
        
        // Generate a unique key for the pool using address and version
        const poolKey = `${pool.address.toLowerCase()}_${pool.version}`;
        
        console.log(`Inserting pool with key: ${poolKey}, version: ${pool.version}`);
        
        // Modified query to include the key column which is the primary key
        const query = `
            INSERT INTO pools (
                key, 
                address, 
                token0_address, 
                token1_address, 
                fee, 
                tick_spacing,
                version
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;
        
        await postgres.query(query, [
            poolKey, 
            pool.address, 
            pool.token0_address, 
            pool.token1_address, 
            pool.fee, 
            pool.tickSpacing,
            pool.version
        ]);
        
        console.log(`Successfully inserted pool ${pool.address} with version ${pool.version}`);
    } catch (err) {
        console.error('Error inserting pool:', err);
        // Provide more detailed error info
        const error = err as any;
        if (error.code) {
            console.error(`SQL Error Code: ${error.code}, Detail: ${error.detail || 'No detail'}`);
        }
        throw err; // Re-throw to ensure calling code knows about the error
    }
}

export const getAllPools = async (tokenAddress: string): Promise<{ address: string; version: number }[]> => {
    try {
        const query = `
            SELECT DISTINCT address, version
            FROM pools
            WHERE token0_address = $1 OR token1_address = $1
        `;
        const result = await postgres.query(query, [tokenAddress]);
        return result.rows.map((row: any) => ({ address: row.address, version: row.version }));
    } catch (err) {
        console.error('Error getting all pools:', err);
        return [];
    }
}

export const updateGroupConfigPools = async (groupId: bigint, pools: string[] | 'all'): Promise<void> => {
    try {
        let query;
        let values;
        
        if (pools === 'all') {
            // Get the token address for this group
            const groupConfig = await getGroupConfig(groupId);
            if (!groupConfig?.address) {
                throw new Error('No token address configured for this group');
            }
            
            // Get all pools for the token
            const allPools = await getAllPools(groupConfig.address);
            query = `UPDATE group_configs SET pools = $1::varchar[], updated_at = CURRENT_TIMESTAMP WHERE group_id = $2`;
            values = [allPools.map(pool => pool.address), groupId];
        } else {
            query = `UPDATE group_configs SET pools = $1::varchar[], updated_at = CURRENT_TIMESTAMP WHERE group_id = $2`;
            values = [pools, groupId];
        }
        
        await postgres.query(query, values);
    } catch (err) {
        console.error('Error updating group config pools:', err);
        throw err;
    }
}

export const getTokenInfoFromDB = async (address: string): Promise<{
    address: string;
    decimals: number;
    name: string;
    symbol: string;
    totalSupply: string;
    owner: string;
    poolAddresses: string[];
    updatedAt: Date;
} | null> => {
    try {
        const query = `
            SELECT address, decimals, name, symbol, total_supply as "totalSupply", pools as poolAddresses,
                    owner, updated_at as "updatedAt"
            FROM tokens 
            WHERE address = $1`;
        const result = await postgres.query(query, [address]);
        return result.rows[0] || null;
    } catch (err) {
        console.error('Error getting token info from DB:', err);
        return null;
    }
}

export const getTrending = async (): Promise<any[]> => {
    try {
        const query = `SELECT * from trending`;
        const result = await postgres.query(query);
        return result.rows;
    } catch (err) {
        console.error('Error getting trending:', err);
        return [];
    }
}

/**
 * Save the token price to the database
 * @param address The token address
 * @param priceUsd The token price in USD
 */
export const saveTokenPrice = async (address: string, priceUsd: number): Promise<void> => {
    try {
        // Check if token already exists in token_metrics
        const exists = await postgres.query(
            'SELECT EXISTS(SELECT 1 FROM token_metrics WHERE address = $1)',
            [address]
        );

        if (exists.rows[0].exists) {
            // Update existing record
            await postgres.query(
                'UPDATE token_metrics SET price_usd = $1, updated_at = CURRENT_TIMESTAMP WHERE address = $2',
                [priceUsd, address]
            );
        } else {
            // Insert new record
            await postgres.query(
                'INSERT INTO token_metrics (address, price_usd) VALUES ($1, $2)',
                [address, priceUsd]
            );
        }
        
        console.log(`Updated price for ${address}: $${priceUsd}`);
    } catch (error) {
        console.error('Error saving token price:', error);
        throw error;
    }
};

export const getPrice = async (contractAddress: string=WBNB) => {
    try {
        const query = 'SELECT price_usd FROM token_metrics WHERE address = $1';
        const result = await postgres.query(query, [contractAddress]);
        return result.rows[0];
    } catch (err) {
        console.error('Error getting group config:', err);
    }
}

/**
 * Retrieve all pools from active group configurations
 */
export const getAllConfigPools = async (): Promise<any[]> => {
    try {
        console.log('Fetching pools from active configurations');
        
        // Modified query to handle pools as a string array rather than trying to cast to jsonb
        const query = `
            WITH pool_addresses AS (
                -- Unnest the pools array to get individual pool addresses
                SELECT DISTINCT gc.group_id, unnest(gc.pools) AS pool_address
                FROM group_configs gc
                WHERE gc.active = true
            )
            SELECT DISTINCT p.*,
                CASE 
                    WHEN p.token0_address = t1.address THEN CONCAT(t1.symbol, '/', t2.symbol, '/', p.version)
                    ELSE CONCAT(t2.symbol, '/', t1.symbol, '/', p.version)
                END as pair_name
            FROM pool_addresses pa
            JOIN pools p ON (
                -- Handle both plain addresses and JSON objects
                p.address = pa.pool_address OR
                p.address = (
                    CASE 
                        WHEN pa.pool_address ~ '^\\{.*\\}$' THEN 
                            (CAST(pa.pool_address AS jsonb)->>'address')::text
                        ELSE pa.pool_address
                    END
                ) OR 
                p.address = (
                    CASE 
                        WHEN pa.pool_address ~ '^\\{.*\\}$' THEN 
                            (CAST(pa.pool_address AS jsonb)->>'tokenAddress')::text
                        ELSE pa.pool_address
                    END
                )
            )
            LEFT JOIN tokens t1 ON p.token0_address = t1.address
            LEFT JOIN tokens t2 ON p.token1_address = t2.address
        `;
        
        console.log('Executing query to get all pools from active configurations');
        
        const result = await postgres.query(query);
        
        console.log(`Retrieved ${result.rows.length} pools from active configurations`);
        
        return result.rows.map(row => ({
            address: row.address,
            token0: row.token0_address,
            token1: row.token1_address,
            fee: row.fee,
            tickSpacing: row.tick_spacing,
            pairName: row.pair_name || `Unknown_${row.address.substring(0, 6)}`,
            version: row.version
        }));
    } catch (error) {
        console.error('Error getting pools from active configurations:', error);
        return [];
    }
}