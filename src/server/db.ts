import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { d1Batch, d1Query, getD1Config } from './d1';

const require = createRequire(import.meta.url);
const { DatabaseSync: NativeDatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'store.sqlite');
export const UPLOAD_ROOT = path.resolve(process.cwd(), 'data', 'uploads');

export type SqlParam = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlParam[];
}

export interface SqlResultMeta {
  changes: number;
  last_row_id: number;
}

export interface SqlExecResult<T = Record<string, unknown>> {
  results: T[];
  meta: SqlResultMeta;
}

export interface DbStatus {
  mode: 'cloudflare-d1' | 'local-sqlite';
  configured: boolean;
  databaseName: string;
  databaseId: string;
  accountId: string;
}

export interface DbClient {
  readonly mode: 'cloudflare-d1' | 'local-sqlite';
  readonly imageKeyCol: 'r2_key' | 'storage_key';
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null>;
  run(sql: string, params?: SqlParam[]): Promise<SqlResultMeta>;
  batch(statements: SqlStatement[]): Promise<SqlExecResult[]>;
}

let dbPromise: Promise<DbClient> | null = null;
let cachedMode: 'cloudflare-d1' | 'local-sqlite' | null = null;
let loggedFallbackNotice = false;

export function getDbStatus(): DbStatus {
  const d1 = getD1Config();
  const mode = cachedMode ?? (d1.configured ? 'cloudflare-d1' : 'local-sqlite');
  return {
    mode,
    configured: d1.configured,
    databaseName: d1.databaseName,
    databaseId: d1.databaseId,
    accountId: d1.accountId,
  };
}

export async function getDb(): Promise<DbClient> {
  if (!dbPromise) {
    dbPromise = initDbClient().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function initDbClient(): Promise<DbClient> {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
  const d1 = getD1Config();

  if (d1.configured) {
    const d1Client = createD1Adapter();
    await ensureSchemaAndSeed(d1Client);
    cachedMode = 'cloudflare-d1';
    return d1Client;
  }

  if (!loggedFallbackNotice) {
    loggedFallbackNotice = true;
    console.warn(
      `[MOKIKO DB] CF_D1_API_TOKEN is not set — using local SQLite fallback until Cloudflare D1 (${d1.databaseId}) token is configured.`
    );
  }

  const configuredPath = process.env['SQLITE_DB_PATH']?.trim();
  const dbPath = configuredPath ? path.resolve(configuredPath) : DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const nativeDb = new NativeDatabaseSync(dbPath);
  nativeDb.exec('PRAGMA foreign_keys = ON;');
  nativeDb.exec('PRAGMA journal_mode = WAL;');
  nativeDb.exec('PRAGMA busy_timeout = 5000;');

  const localClient = createLocalSqliteAdapter(nativeDb);
  await ensureSchemaAndSeed(localClient);
  cachedMode = 'local-sqlite';
  return localClient;
}

function createD1Adapter(): DbClient {
  let detectedImageKeyCol: 'r2_key' | 'storage_key' = 'r2_key';

  return {
    mode: 'cloudflare-d1',
    get imageKeyCol() {
      return detectedImageKeyCol;
    },
    set imageKeyCol(val: 'r2_key' | 'storage_key') {
      detectedImageKeyCol = val;
    },
    async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      const res = await d1Query<T>(sql, params);
      return res.results;
    },
    async first<T = Record<string, unknown>>(
      sql: string,
      params: SqlParam[] = []
    ): Promise<T | null> {
      const res = await d1Query<T>(sql, params);
      return res.results[0] ?? null;
    },
    async run(sql: string, params: SqlParam[] = []): Promise<SqlResultMeta> {
      const res = await d1Query(sql, params);
      return {
        changes: res.meta.changes,
        last_row_id: res.meta.last_row_id,
      };
    },
    async batch(statements: SqlStatement[]): Promise<SqlExecResult[]> {
      const results = await d1Batch(statements);
      return results.map((entry) => ({
        results: entry.results,
        meta: {
          changes: entry.meta.changes,
          last_row_id: entry.meta.last_row_id,
        },
      }));
    },
  } as DbClient & { imageKeyCol: 'r2_key' | 'storage_key' };
}

function createLocalSqliteAdapter(db: DatabaseSync): DbClient {
  let detectedImageKeyCol: 'r2_key' | 'storage_key' = 'storage_key';

  return {
    mode: 'local-sqlite',
    get imageKeyCol() {
      return detectedImageKeyCol;
    },
    set imageKeyCol(val: 'r2_key' | 'storage_key') {
      detectedImageKeyCol = val;
    },
    async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },
    async first<T = Record<string, unknown>>(
      sql: string,
      params: SqlParam[] = []
    ): Promise<T | null> {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async run(sql: string, params: SqlParam[] = []): Promise<SqlResultMeta> {
      const info = db.prepare(sql).run(...params);
      return {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      };
    },
    async batch(statements: SqlStatement[]): Promise<SqlExecResult[]> {
      if (!statements.length) return [];
      const out: SqlExecResult[] = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const stmt of statements) {
          const trimmed = stmt.sql.trim().toUpperCase();
          const params = stmt.params ?? [];
          if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
            const rows = db.prepare(stmt.sql).all(...params) as Array<Record<string, unknown>>;
            out.push({
              results: rows,
              meta: { changes: 0, last_row_id: 0 },
            });
          } else {
            const info = db.prepare(stmt.sql).run(...params);
            out.push({
              results: [],
              meta: {
                changes: Number(info.changes ?? 0),
                last_row_id: Number(info.lastInsertRowid ?? 0),
              },
            });
          }
        }
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  } as DbClient & { imageKeyCol: 'r2_key' | 'storage_key' };
}

async function ensureSchemaAndSeed(
  client: DbClient & { imageKeyCol: 'r2_key' | 'storage_key' }
): Promise<void> {
  const defaultVariantKeyCol = client.mode === 'cloudflare-d1' ? 'r2_key' : 'storage_key';

  const ddlStatements: SqlStatement[] = [
    {
      sql: `CREATE TABLE IF NOT EXISTS store_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    },
    {
      sql: `INSERT INTO store_settings(key, value) VALUES('price_visible', '1') ON CONFLICT(key) DO NOTHING`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS admin_credentials (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        pin_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Tops',
        tag TEXT NOT NULL DEFAULT '',
        fabric_note TEXT NOT NULL DEFAULT '',
        fit_note TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        price INTEGER NOT NULL CHECK(price >= 0),
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS product_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        sku TEXT NOT NULL UNIQUE,
        size TEXT NOT NULL,
        color TEXT NOT NULL,
        color_hex TEXT,
        stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
        active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(product_id, size, color)
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS variants_product_idx ON product_variants(product_id)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS image_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        alt_text TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '',
        color_hex TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS image_assets_product_idx ON image_assets(product_id, sort_order, id)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS image_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_asset_id INTEGER NOT NULL REFERENCES image_assets(id) ON DELETE CASCADE,
        width INTEGER NOT NULL CHECK(width IN (400, 800, 1200)),
        ${defaultVariantKeyCol} TEXT NOT NULL UNIQUE,
        content_type TEXT NOT NULL DEFAULT 'image/webp',
        byte_size INTEGER NOT NULL,
        UNIQUE(image_asset_id, width)
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        whatsapp_phone TEXT,
        city TEXT NOT NULL,
        address TEXT NOT NULL,
        delivery_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS customers_phone_idx ON customers(phone)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number TEXT NOT NULL UNIQUE,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','preparing','shipped','out_for_delivery','delivered','cancelled','returned')),
        payment_method TEXT NOT NULL DEFAULT 'cod' CHECK(payment_method = 'cod'),
        payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','paid')),
        currency TEXT NOT NULL DEFAULT 'MAD',
        subtotal INTEGER NOT NULL,
        delivery_fee INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_idx ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders(status, created_at)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        variant_id INTEGER REFERENCES product_variants(id),
        product_name TEXT NOT NULL,
        sku TEXT NOT NULL,
        size TEXT NOT NULL,
        color TEXT NOT NULL,
        unit_price INTEGER NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        line_total INTEGER NOT NULL
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS stock_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        variant_id INTEGER NOT NULL REFERENCES product_variants(id),
        order_id INTEGER REFERENCES orders(id),
        movement_type TEXT NOT NULL,
        quantity_delta INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS stock_movements_variant_created_idx ON stock_movements(variant_id, created_at, id)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS stock_movements_order_idx ON stock_movements(order_id)`,
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS stock_cancel_restore_once_idx ON stock_movements(order_id, variant_id) WHERE movement_type = 'cancel_restore' AND order_id IS NOT NULL`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS notifications_read_created_idx ON notifications(is_read, created_at)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs(entity_type, entity_id, created_at)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS admin_pin_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL,
        attempted_at TEXT NOT NULL
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS admin_pin_attempts_ip_time_idx ON admin_pin_attempts(ip, attempted_at)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS order_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL,
        attempted_at TEXT NOT NULL
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS order_attempts_ip_time_idx ON order_attempts(ip, attempted_at)`,
    },
  ];

  await client.batch(ddlStatements);

  // Align any older D1 migrations incrementally
  const productCols = await client.all<{ name: string }>('PRAGMA table_info(products)');
  const alterStmts: SqlStatement[] = [];
  if (!productCols.some((c) => c.name === 'category')) {
    alterStmts.push({ sql: "ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'Tops'" });
  }
  if (!productCols.some((c) => c.name === 'tag')) {
    alterStmts.push({ sql: "ALTER TABLE products ADD COLUMN tag TEXT NOT NULL DEFAULT ''" });
  }
  if (!productCols.some((c) => c.name === 'fabric_note')) {
    alterStmts.push({ sql: "ALTER TABLE products ADD COLUMN fabric_note TEXT NOT NULL DEFAULT ''" });
  }
  if (!productCols.some((c) => c.name === 'fit_note')) {
    alterStmts.push({ sql: "ALTER TABLE products ADD COLUMN fit_note TEXT NOT NULL DEFAULT ''" });
  }

  const imageCols = await client.all<{ name: string }>('PRAGMA table_info(image_assets)');
  if (!imageCols.some((c) => c.name === 'color')) {
    alterStmts.push({ sql: "ALTER TABLE image_assets ADD COLUMN color TEXT NOT NULL DEFAULT ''" });
  }
  if (!imageCols.some((c) => c.name === 'color_hex')) {
    alterStmts.push({ sql: 'ALTER TABLE image_assets ADD COLUMN color_hex TEXT' });
  }
  if (!imageCols.some((c) => c.name === 'sort_order')) {
    alterStmts.push({ sql: 'ALTER TABLE image_assets ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0' });
  }

  if (alterStmts.length) {
    await client.batch(alterStmts);
  }

  const variantKeyCols = await client.all<{ name: string }>('PRAGMA table_info(image_variants)');
  client.imageKeyCol = variantKeyCols.some((c) => c.name === 'r2_key') ? 'r2_key' : 'storage_key';

  await seedInitialData(client);
}

async function seedInitialData(
  db: DbClient & { imageKeyCol: 'r2_key' | 'storage_key' }
): Promise<void> {
  const existing = await db.first<{ count: number }>('SELECT COUNT(*) AS count FROM products');
  if (Number(existing?.count ?? 0) > 0) return;

  const seeds = [
    {
      slug: 'tshirt-training-technique',
      name: 'T-Shirt Training Technique',
      category: 'Tops',
      tag: 'Essentiel',
      fabricNote: 'Jersey coton peigné 260g/m² · Coutures plates anti-frottement',
      fitNote: 'Coupe athlétique ajustée. Le mannequin mesure 1m83 et porte du M.',
      description:
        'Confectionné en jersey épais 260g/m² respirant qui garde sa tenue pendant les séances intenses. Col renforcé et coutures plates pour une liberté de mouvement totale.',
      price: 249,
      status: 'active',
      images: [
        {
          url: '/assets/images/product_training_tee_1795239482148.jpg',
          alt: 'T-Shirt Training Technique Anthracite',
          color: 'Anthracite',
          hex: '#2F3234',
        },
        {
          url: '/assets/images/product_tee_warm_stone_1795240157685.jpg',
          alt: 'T-Shirt Training Technique Beige Sable',
          color: 'Beige Sable',
          hex: '#C4B399',
        },
        {
          url: '/assets/images/product_tee_sage_slate_1795240158211.jpg',
          alt: 'T-Shirt Training Technique Vert Sauge',
          color: 'Vert Sauge',
          hex: '#5D6B63',
        },
      ],
      variants: [
        { sku: 'MK-TEE-S-ANT', size: 'S', color: 'Anthracite', hex: '#2F3234', stock: 8 },
        { sku: 'MK-TEE-M-ANT', size: 'M', color: 'Anthracite', hex: '#2F3234', stock: 12 },
        { sku: 'MK-TEE-L-ANT', size: 'L', color: 'Anthracite', hex: '#2F3234', stock: 9 },
        { sku: 'MK-TEE-XL-ANT', size: 'XL', color: 'Anthracite', hex: '#2F3234', stock: 5 },
        { sku: 'MK-TEE-M-SAB', size: 'M', color: 'Beige Sable', hex: '#C4B399', stock: 6 },
        { sku: 'MK-TEE-L-SAB', size: 'L', color: 'Beige Sable', hex: '#C4B399', stock: 4 },
        { sku: 'MK-TEE-M-SAU', size: 'M', color: 'Vert Sauge', hex: '#5D6B63', stock: 7 },
        { sku: 'MK-TEE-L-SAU', size: 'L', color: 'Vert Sauge', hex: '#5D6B63', stock: 5 },
      ],
    },
    {
      slug: 'hoodie-loopback-performance',
      name: 'Hoodie Loopback Performance',
      category: 'Layers',
      tag: 'Nouveauté',
      fabricNote: 'Molleton bouclé bio 420g/m² · Capuche doublée structurée',
      fitNote: 'Coupe droite moderne à épaules tombantes. Mannequin 1m83, taille M.',
      description:
        'Pensé pour l’échauffement, la récupération et le quotidien. Son molleton French terry 420g/m² régule la chaleur avec poches zippées dissimulées.',
      price: 449,
      status: 'active',
      images: [
        {
          url: '/assets/images/product_performance_hoodie_1795239482180.jpg',
          alt: 'Hoodie Loopback Performance Vert Olive',
          color: 'Vert Olive',
          hex: '#3E423B',
        },
        {
          url: '/assets/images/product_hoodie_obsidian_1795240157764.jpg',
          alt: 'Hoodie Loopback Performance Noir Mat',
          color: 'Noir Mat',
          hex: '#1C1C1B',
        },
      ],
      variants: [
        { sku: 'MK-HD-S-OLV', size: 'S', color: 'Vert Olive', hex: '#3E423B', stock: 5 },
        { sku: 'MK-HD-M-OLV', size: 'M', color: 'Vert Olive', hex: '#3E423B', stock: 9 },
        { sku: 'MK-HD-L-OLV', size: 'L', color: 'Vert Olive', hex: '#3E423B', stock: 7 },
        { sku: 'MK-HD-M-NOI', size: 'M', color: 'Noir Mat', hex: '#1C1C1B', stock: 6 },
        { sku: 'MK-HD-XL-NOI', size: 'XL', color: 'Noir Mat', hex: '#1C1C1B', stock: 3 },
      ],
    },
    {
      slug: 'jogger-technique-stretch',
      name: 'Jogger Technique Stretch',
      category: 'Bottoms',
      tag: 'Essentiel',
      fabricNote: 'Tissu nylon-élasthanne 210g/m² extensible 4 directions · Genoux articulés',
      fitNote: 'Coupe fuselée, taille normale. Le mannequin mesure 1m83 et porte du M.',
      description:
        'Tissu technique léger et silencieux qui accompagne chaque sprint et mouvement de mobilité. Cordon de serrage discret et poches zippées sécurisées.',
      price: 379,
      status: 'active',
      images: [
        {
          url: '/assets/images/product_utility_jogger_1795239482018.jpg',
          alt: 'Jogger Technique Stretch Noir Mat',
          color: 'Noir Mat',
          hex: '#23272A',
        },
        {
          url: '/assets/images/product_jogger_ash_grey_1795240157505.jpg',
          alt: 'Jogger Technique Stretch Gris Ardoise',
          color: 'Gris Ardoise',
          hex: '#7A7972',
        },
      ],
      variants: [
        { sku: 'MK-JOG-S-NOI', size: 'S', color: 'Noir Mat', hex: '#23272A', stock: 6 },
        { sku: 'MK-JOG-M-NOI', size: 'M', color: 'Noir Mat', hex: '#23272A', stock: 10 },
        { sku: 'MK-JOG-L-NOI', size: 'L', color: 'Noir Mat', hex: '#23272A', stock: 8 },
        { sku: 'MK-JOG-M-ARD', size: 'M', color: 'Gris Ardoise', hex: '#7A7972', stock: 7 },
        { sku: 'MK-JOG-XL-NOI', size: 'XL', color: 'Noir Mat', hex: '#23272A', stock: 4 },
      ],
    },
    {
      slug: 'short-training-core-7',
      name: 'Short Training Core 7"',
      category: 'Bottoms',
      tag: 'Essentiel',
      fabricNote: 'Nylon mat déperlant 175g/m² · Empiècement micro-perforé',
      fitNote: 'Longueur 7 pouces au-dessus du genou. Mannequin 1m83, taille M.',
      description:
        'Short d’entraînement 7 pouces à séchage rapide avec taille basse profilée, poche clé dissimulée et fentes latérales pour une amplitude maximale.',
      price: 229,
      status: 'active',
      images: [
        {
          url: '/assets/images/product_training_short_1795239482216.jpg',
          alt: 'Short Training Core 7 Pierre Mat',
          color: 'Pierre Mat',
          hex: '#8C887F',
        },
        {
          url: '/assets/images/product_short_obsidian_1795240157827.jpg',
          alt: 'Short Training Core 7 Noir Mat',
          color: 'Noir Mat',
          hex: '#1C1D1F',
        },
      ],
      variants: [
        { sku: 'MK-SH-S-PIE', size: 'S', color: 'Pierre Mat', hex: '#8C887F', stock: 7 },
        { sku: 'MK-SH-M-PIE', size: 'M', color: 'Pierre Mat', hex: '#8C887F', stock: 11 },
        { sku: 'MK-SH-L-PIE', size: 'L', color: 'Pierre Mat', hex: '#8C887F', stock: 9 },
        { sku: 'MK-SH-M-NOI', size: 'M', color: 'Noir Mat', hex: '#1C1D1F', stock: 8 },
        { sku: 'MK-SH-XL-PIE', size: 'XL', color: 'Pierre Mat', hex: '#8C887F', stock: 5 },
      ],
    },
  ];

  const statements: SqlStatement[] = [];
  const keyCol = db.imageKeyCol;

  for (const p of seeds) {
    statements.push({
      sql: `INSERT INTO products(slug, name, category, tag, fabric_note, fit_note, description, price, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING`,
      params: [p.slug, p.name, p.category, p.tag, p.fabricNote, p.fitNote, p.description, p.price, p.status],
    });

    p.images.forEach((img, idx) => {
      statements.push({
        sql: `INSERT INTO image_assets(product_id, alt_text, color, color_hex, sort_order)
              SELECT id, ?, ?, ?, ? FROM products WHERE slug = ?`,
        params: [img.alt, img.color, img.hex, idx, p.slug],
      });
      statements.push({
        sql: `INSERT INTO image_variants(image_asset_id, width, ${keyCol}, content_type, byte_size)
              SELECT last_insert_rowid(), 800, ?, 'image/jpeg', 0`,
        params: [img.url],
      });
    });

    for (const v of p.variants) {
      statements.push({
        sql: `INSERT INTO product_variants(product_id, sku, size, color, color_hex, stock)
              SELECT id, ?, ?, ?, ?, ? FROM products WHERE slug = ? ON CONFLICT(sku) DO NOTHING`,
        params: [v.sku, v.size, v.color, v.hex, v.stock, p.slug],
      });
      if (v.stock > 0) {
        statements.push({
          sql: `INSERT INTO stock_movements(variant_id, movement_type, quantity_delta, reason)
                SELECT id, 'adjustment', ?, 'Stock initial' FROM product_variants WHERE sku = ?`,
          params: [v.stock, v.sku],
        });
      }
    }
  }

  await db.batch(statements);
}
