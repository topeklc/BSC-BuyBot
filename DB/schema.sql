-- Function to automatically update updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Pools table for storing ICP Swap pool information
CREATE TABLE pools (
    -- Primary key using the unique key from the pool data
    key VARCHAR(255) PRIMARY KEY,
    
    -- Pool basic info
    fee BIGINT NOT NULL,
    tick_spacing BIGINT NOT NULL,
    address VARCHAR(63) NOT NULL,
    
    -- Token0 info
    token0_address VARCHAR(63) NOT NULL,
    
    -- Token1 info
    token1_address VARCHAR(63) NOT NULL,
    
    version INTEGER NOT NULL,
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for pools table
CREATE INDEX idx_pools_address ON pools(address);
CREATE INDEX idx_pools_token0_address ON pools(token0_address);
CREATE INDEX idx_pools_token1_address ON pools(token1_address);


-- Trigger to update updated_at on pools table
CREATE TRIGGER update_pools_updated_at
    BEFORE UPDATE ON pools
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Tokens table for storing token information
CREATE TABLE tokens (
    address VARCHAR(100) NOT NULL PRIMARY KEY,
    decimals INTEGER NOT NULL,
    name VARCHAR(100) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    total_supply NUMERIC,
    owner VARCHAR(100),
    pools VARCHAR(100)[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Trigger to update updated_at on tokens table
CREATE TRIGGER update_tokens_updated_at
    BEFORE UPDATE ON tokens
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- Users table for telegram bot users
CREATE TABLE users (
    id BIGINT PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    currently_setting BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Trigger to update updated_at on users table
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Groups table for telegram groups
CREATE TABLE groups (
    id BIGINT PRIMARY KEY,
    name VARCHAR(100),
    link VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Trigger to update updated_at on groups table
CREATE TRIGGER update_groups_updated_at
    BEFORE UPDATE ON groups
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Group configurations table
CREATE TABLE group_configs (
    id SERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL UNIQUE,
    address VARCHAR(100),
    media BYTEA,
    emoji VARCHAR(10),
    min_amount INT,
    pools VARCHAR(100)[],
    socials JSONB,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups (id),
    FOREIGN KEY (address) REFERENCES tokens (address)
);

-- Trigger to update updated_at on group_configs table
CREATE TRIGGER update_group_configs_updated_at
    BEFORE UPDATE ON group_configs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE user_groups (
    user_id BIGINT NOT NULL,
    group_id BIGINT NOT NULL,
    role VARCHAR(50) DEFAULT 'admin',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, group_id),
    FOREIGN KEY (user_id) REFERENCES users (id),
    FOREIGN KEY (group_id) REFERENCES groups (id)
);

-- Trigger to update updated_at on user_groups table
CREATE TRIGGER update_user_groups_updated_at
    BEFORE UPDATE ON user_groups
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


CREATE TABLE token_metrics (
    address VARCHAR(100) NOT NULL PRIMARY KEY,
    volume_usd_1d NUMERIC,
    volume_usd_7d NUMERIC,
    total_volume_usd NUMERIC,
    volume_usd NUMERIC,
    fees_usd NUMERIC,
    price_usd_change NUMERIC,
    tx_count INTEGER,
    price_usd NUMERIC,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (address) REFERENCES tokens (address)
);

CREATE TRIGGER update_token_metrics_updated_at
    BEFORE UPDATE ON token_metrics
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE trending (
    address VARCHAR(100) NOT NULL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    volume_usd_1d NUMERIC,
    price_usd NUMERIC,
    price_usd_change NUMERIC,
    socials JSONB,
    place INTEGER,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER update_trending_updated_at
    BEFORE UPDATE ON trending
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();