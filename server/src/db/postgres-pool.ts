import { Pool } from 'pg';
import dns from 'dns';

let pool: Pool | null = null;

function resolveIpv4(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err || !addresses.length) {
        reject(err || new Error(`No IPv4 addresses for ${hostname}`));
      } else {
        resolve(addresses[0]);
      }
    });
  });
}

export async function getPool(): Promise<Pool> {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is required for PostgreSQL');
    }
    const url = new URL(connectionString);
    if (!url.searchParams.has('sslmode')) {
      url.searchParams.set('sslmode', 'require');
    }
    // Resolve hostname to IPv4 to avoid IPv6 ENETUNREACH on providers without IPv6
    let host = url.hostname;
    try {
      host = await resolveIpv4(url.hostname);
    } catch {
      // Keep original hostname if resolution fails
    }
    pool = new Pool({
      host,
      port: Number(url.port) || 5432,
      database: url.pathname.replace(/^\//, ''),
      user: url.username || 'postgres',
      password: url.password || '',
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
