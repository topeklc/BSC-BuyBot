import { Pool } from "pg";
import dotenv from 'dotenv';
dotenv.config();
// Create a connection pool
export const postgres = new Pool({
    user: process.env.PGUSER || "postgres",
    host: process.env.PGHOST || "localhost",
    database: process.env.PGDATABASE || "postgres",
    password: process.env.PGPASSWORD || "password",
    port: Number(process.env.PGPORT) || 5432, // Default PostgreSQL port
});