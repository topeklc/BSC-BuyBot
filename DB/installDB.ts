import { Pool } from "pg";
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const postgres = new Pool({
    user: process.env.PGUSER || "postgres",
    host: process.env.PGHOST || "localhost",
    database: process.env.PGDATABASE || "postgres",
    password: process.env.PGPASSWORD || "password",
    port: process.env.PGPORT || 5432, // Default PostgreSQL port
});

async function installSchema() {
    const client = await postgres.connect();
    try {
        // Read the schema.sql file
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');

        // Execute the schema
        await client.query(schema);
        console.log('Schema installed successfully');
    } catch (err) {
        console.error('Error installing schema:', err);
        throw err;
    } finally {
        client.release();
    }
}

installSchema()