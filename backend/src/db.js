import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '../.env') });
dotenv.config({ path: path.join(here, '../../.env') });

const { Pool } = pg;
pg.types.setTypeParser(1082, (value) => value);

const useRender = Boolean(process.env.DATABASE_URL);

export const pool = useRender
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || 'cvscoupons',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      max: 5,
    });

export async function query(text, params) {
  return pool.query(text, params);
}

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      amount INTEGER NOT NULL,
      qualifier TEXT,
      expires_on DATE,
      expires_label TEXT,
      card_last4 TEXT,
      subject TEXT,
      from_address TEXT,
      received_at TIMESTAMPTZ,
      coupon_url TEXT,
      image_data TEXT,
      image_mime TEXT,
      image_kind TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      capture_error TEXT,
      used_at TIMESTAMPTZ,
      cvs_account_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE coupons ADD COLUMN IF NOT EXISTS cvs_account_email TEXT;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}
