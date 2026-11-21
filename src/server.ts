import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { getDb, getDbStatus, SqlStatement, UPLOAD_ROOT } from './server/db';
import {
  deleteR2Object,
  extractR2ObjectKey,
  getR2Config,
  headR2Object,
  presignPutObject,
  putObjectToR2,
} from './server/r2-s3';

const app = express();
app.set('trust proxy', 1);

const angularApp = new AngularNodeAppEngine();
const browserDistFolder = path.resolve(import.meta.dirname, '../browser');

const SESSION_SIGNING_SECRET =
  process.env['SESSION_SECRET']?.trim() || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_LIMIT = 10;
const ADMIN_WINDOW_MS = 15 * 60 * 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
});

app.use(express.json({ limit: '1mb' }));

// Security headers for API responses
app.use('/api', (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Serve uploaded product media with path confinement
app.use('/media', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  let relPath = '';
  try {
    relPath = decodeURIComponent(req.path || '').replace(/^\/+/, '');
  } catch {
    res.status(400).end();
    return;
  }
  if (!relPath) {
    res.status(404).end();
    return;
  }
  const resolved = path.resolve(UPLOAD_ROOT, relPath);
  if (!resolved.startsWith(UPLOAD_ROOT + path.sep)) {
    res.status(403).end();
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(resolved).pipe(res);
});

// Helper functions
function getClientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

function hashPin(pin: string, salt: string): string {
  return crypto.scryptSync(pin, salt, 64).toString('hex');
}

function timingSafeMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function issueAdminToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: 'admin', exp: Date.now() + SESSION_TTL_MS })
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SIGNING_SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAdminToken(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SIGNING_SECRET)
    .update(payload)
    .digest('base64url');
  if (!timingSafeMatch(sig, expectedSig)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed?.sub === 'admin' && Number(parsed?.exp) > Date.now();
  } catch {
    return false;
  }
}

async function getAuthMode(): Promise<'env' | 'claimed' | 'unclaimed'> {
  if (process.env['ADMIN_PIN']?.trim()) return 'env';
  const db = await getDb();
  const row = await db.first<{ id: number }>('SELECT id FROM admin_credentials WHERE id = 1');
  return row ? 'claimed' : 'unclaimed';
}

async function verifySubmittedPin(pin: string): Promise<boolean> {
  const envPin = process.env['ADMIN_PIN']?.trim();
  if (envPin) {
    return timingSafeMatch(pin, envPin);
  }
  const db = await getDb();
  const row = await db.first<{ pin_hash: string; salt: string }>(
    'SELECT pin_hash, salt FROM admin_credentials WHERE id = 1'
  );
  if (!row) return false;
  const derived = hashPin(pin, row.salt);
  return timingSafeMatch(derived, row.pin_hash);
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const header = String(req.headers['authorization'] || '');
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token || !verifyAdminToken(token)) {
    res.status(401).json({ error: 'Session expired or invalid. Please unlock again.' });
    return;
  }
  next();
}

async function readPriceVisibility(): Promise<boolean> {
  const db = await getDb();
  const row = await db.first<{ value: string }>(
    "SELECT value FROM store_settings WHERE key = 'price_visible'"
  );
  return row?.value !== '0';
}

function formatImageUrl(storageKey: string): string {
  if (
    storageKey.startsWith('/assets/') ||
    storageKey.startsWith('http://') ||
    storageKey.startsWith('https://')
  ) {
    return storageKey;
  }
  const r2 = getR2Config();
  if (storageKey.startsWith('products/')) {
    const localCandidate = path.resolve(UPLOAD_ROOT, storageKey);
    if (localCandidate.startsWith(UPLOAD_ROOT + path.sep) && fs.existsSync(localCandidate)) {
      return `/media/${storageKey.replace(/^\/+/, '')}`;
    }
    return `${r2.publicBaseUrl}/${storageKey.replace(/^\/+/, '')}`;
  }
  return `/media/${storageKey.replace(/^\/+/, '')}`;
}

async function loadCatalog(activeOnly: boolean) {
  const db = await getDb();
  const keyCol = db.imageKeyCol;

  const prodSql = activeOnly
    ? "SELECT id, slug, name, category, tag, fabric_note, fit_note, description, price, status, created_at FROM products WHERE status = 'active' ORDER BY id DESC"
    : 'SELECT id, slug, name, category, tag, fabric_note, fit_note, description, price, status, created_at FROM products ORDER BY id DESC';

  const imgSql = `
    SELECT a.id, a.product_id, a.alt_text, a.color, a.color_hex, a.sort_order, v.width, v.${keyCol} AS media_key, v.byte_size
    FROM image_assets a
    JOIN image_variants v ON v.image_asset_id = a.id
    ORDER BY a.product_id ASC, a.sort_order ASC, a.id ASC, v.width ASC
  `;

  const variantSql = `
    SELECT id, product_id, sku, size, color, color_hex, stock
    FROM product_variants
    WHERE active = 1
    ORDER BY id ASC
  `;

  const [settingsRes, prodRes, imgRes, varRes] = await db.batch([
    { sql: "SELECT value FROM store_settings WHERE key = 'price_visible'" },
    { sql: prodSql },
    { sql: imgSql },
    { sql: variantSql },
  ]);

  const priceVisible = (settingsRes.results[0] as { value?: string } | undefined)?.value !== '0';
  const products = prodRes.results as Array<Record<string, unknown>>;
  const allImages = imgRes.results as Array<Record<string, unknown>>;
  const allVariants = varRes.results as Array<Record<string, unknown>>;

  const imagesByProduct = new Map<number, Array<Record<string, unknown>>>();
  for (const row of allImages) {
    const pid = Number(row['product_id']);
    const list = imagesByProduct.get(pid) || [];
    list.push(row);
    imagesByProduct.set(pid, list);
  }

  const variantsByProduct = new Map<number, Array<Record<string, unknown>>>();
  for (const row of allVariants) {
    const pid = Number(row['product_id']);
    const list = variantsByProduct.get(pid) || [];
    list.push(row);
    variantsByProduct.set(pid, list);
  }

  return products.map((p) => {
    const productId = Number(p['id']);
    const rawImages = imagesByProduct.get(productId) || [];
    const variants = variantsByProduct.get(productId) || [];

    const groupedMap = new Map<
      number,
      {
        id: number;
        alt_text: string;
        color: string;
        color_hex: string | null;
        url: string;
        variants: Array<{ width: number; url: string; byte_size: number }>;
      }
    >();

    for (const row of rawImages) {
      const assetId = Number(row['id']);
      const url = formatImageUrl(String(row['media_key'] || ''));
      const width = Number(row['width']);
      const byteSize = Number(row['byte_size']);
      let entry = groupedMap.get(assetId);
      if (!entry) {
        entry = {
          id: assetId,
          alt_text: String(row['alt_text'] || ''),
          color: String(row['color'] || ''),
          color_hex: row['color_hex'] ? String(row['color_hex']) : null,
          url,
          variants: [],
        };
        groupedMap.set(assetId, entry);
      }
      entry.variants.push({ width, url, byte_size: byteSize });
      if (width === 800 || (width === 1200 && !entry.variants.some((v) => v.width === 800))) {
        entry.url = url;
      }
    }

    return {
      id: productId,
      slug: String(p['slug']),
      name: String(p['name']),
      category: String(p['category'] || 'Tops'),
      tag: String(p['tag'] || ''),
      fabricNote: String(p['fabric_note'] || ''),
      fitNote: String(p['fit_note'] || ''),
      description: String(p['description'] || ''),
      price: !activeOnly || priceVisible ? Number(p['price']) : null,
      status: String(p['status']),
      images: Array.from(groupedMap.values()),
      variants: variants.map((v) => ({
        id: Number(v['id']),
        sku: String(v['sku']),
        size: String(v['size']),
        color: String(v['color']),
        color_hex: v['color_hex'] ? String(v['color_hex']) : null,
        stock: Number(v['stock']),
      })),
    };
  });
}

function isWebPBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

// ---------- Public Storefront Routes ----------

app.get('/api/health', async (_req, res) => {
  await getDb();
  const status = getDbStatus();
  res.json({
    ok: true,
    database: status.mode,
    databaseName: status.databaseName,
    databaseId: status.databaseId,
    service: 'mokiko-sport-api',
  });
});

app.get('/api/store-settings', async (_req, res) => {
  res.json({ priceVisible: await readPriceVisibility() });
});

app.get('/api/products', async (_req, res) => {
  res.json(await loadCatalog(true));
});

app.post('/api/orders', async (req, res) => {
  if (!(await readPriceVisibility())) {
    res.status(403).json({ error: 'Online ordering is currently unavailable.' });
    return;
  }

  const db = await getDb();
  const ip = getClientIp(req);
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  await db.run('DELETE FROM order_attempts WHERE attempted_at < ?', [cutoff]);
  const recent = await db.first<{ attempts: number }>(
    'SELECT COUNT(*) AS attempts FROM order_attempts WHERE ip = ? AND attempted_at > ?',
    [ip, cutoff]
  );
  if (Number(recent?.attempts || 0) >= 15) {
    res.status(429).json({ error: 'Too many order attempts. Please try again later.' });
    return;
  }
  await db.run('INSERT INTO order_attempts(ip, attempted_at) VALUES (?, ?)', [
    ip,
    new Date().toISOString(),
  ]);

  const body = req.body || {};
  const idempotencyKey = String(body.idempotencyKey || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(idempotencyKey)) {
    res.status(400).json({ error: 'A valid checkout request key is required.' });
    return;
  }

  const existingOrder = await db.first<Record<string, unknown>>(
    'SELECT id, order_number, total, currency, status FROM orders WHERE idempotency_key = ?',
    [idempotencyKey]
  );
  if (existingOrder) {
    res.status(200).json({
      orderId: existingOrder['id'],
      orderNumber: existingOrder['order_number'],
      total: existingOrder['total'],
      currency: existingOrder['currency'],
      status: existingOrder['status'],
      replayed: true,
    });
    return;
  }

  const customer = body.customer || {};
  const items = Array.isArray(body.items) ? body.items : [];
  const name = String(customer.fullName || '').trim();
  const phone = String(customer.phone || '').trim();
  const whatsapp = String(customer.whatsapp || phone).trim();
  const city = String(customer.city || '').trim();
  const address = String(customer.address || '').trim();
  const note = String(customer.note || '').trim();

  if (
    !name ||
    name.length > 120 ||
    !phone ||
    phone.length > 30 ||
    !/^\+?[0-9\s().-]{5,25}$/.test(phone) ||
    !whatsapp ||
    whatsapp.length > 30 ||
    !/^\+?[0-9\s().-]{5,25}$/.test(whatsapp) ||
    !city ||
    city.length > 100 ||
    !address ||
    address.length > 500 ||
    note.length > 500 ||
    !items.length ||
    items.length > 30
  ) {
    res.status(400).json({
      error: 'Please check customer details and cart items. Fields may be invalid or too long.',
    });
    return;
  }

  const grouped = new Map<string, { productId: number; variantId: number | null; quantity: number }>();
  for (const raw of items) {
    const productId = Number(raw?.productId);
    const quantity = Number(raw?.quantity);
    const variantId = raw?.variantId == null ? null : Number(raw.variantId);
    if (
      !Number.isInteger(productId) ||
      productId < 1 ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 20 ||
      (variantId !== null && (!Number.isInteger(variantId) || variantId < 1))
    ) {
      res.status(400).json({ error: 'Invalid cart item.' });
      return;
    }
    const key = `${productId}:${variantId ?? 'standard'}`;
    const totalQty = (grouped.get(key)?.quantity || 0) + quantity;
    if (totalQty > 20) {
      res.status(400).json({ error: 'Maximum quantity per product option is 20.' });
      return;
    }
    grouped.set(key, { productId, variantId, quantity: totalQty });
  }

  const safeItems: Array<{
    productId: number;
    name: string;
    price: number;
    variant: { id: number; sku: string; size: string; color: string; stock: number } | null;
    quantity: number;
    lineTotal: number;
  }> = [];

  for (const item of grouped.values()) {
    const product = await db.first<{ id: number; name: string; price: number }>(
      "SELECT id, name, price FROM products WHERE id = ? AND status = 'active'",
      [item.productId]
    );
    if (!product) {
      res.status(409).json({ error: 'One of the selected products is no longer available.' });
      return;
    }

    const activeVariants = await db.all(
      'SELECT id FROM product_variants WHERE product_id = ? AND active = 1',
      [item.productId]
    );
    if (activeVariants.length && !item.variantId) {
      res.status(409).json({ error: `Please select a size and colour for ${product.name}.` });
      return;
    }

    let variant: { id: number; sku: string; size: string; color: string; stock: number } | null =
      null;
    if (item.variantId) {
      variant = await db.first<{ id: number; sku: string; size: string; color: string; stock: number }>(
        'SELECT id, sku, size, color, stock FROM product_variants WHERE id = ? AND product_id = ? AND active = 1',
        [item.variantId, item.productId]
      );
      if (!variant) {
        res.status(409).json({ error: 'The selected size or colour is no longer available.' });
        return;
      }
      if (Number(variant.stock) < item.quantity) {
        res.status(409).json({
          error: `Insufficient stock for ${product.name} (${variant.size} / ${variant.color}).`,
        });
        return;
      }
    }

    safeItems.push({
      productId: product.id,
      name: product.name,
      price: Number(product.price),
      variant,
      quantity: item.quantity,
      lineTotal: Number(product.price) * item.quantity,
    });
  }

  const subtotal = safeItems.reduce((sum, i) => sum + i.lineTotal, 0);
  if (subtotal > 10_000_000) {
    res.status(400).json({ error: 'Order total exceeds limit.' });
    return;
  }

  const orderNumber = `MK-${Date.now().toString(36).toUpperCase().slice(-5)}-${crypto
    .randomUUID()
    .slice(0, 4)
    .toUpperCase()}`;

  const stockGuards = safeItems
    .filter((i) => i.variant)
    .map(
      (i) =>
        `EXISTS(SELECT 1 FROM product_variants WHERE id = ${Number(i.variant!.id)} AND active = 1 AND stock >= ${Number(i.quantity)})`
    );

  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO customers(full_name, phone, whatsapp_phone, city, address, delivery_note)
            SELECT ?, ?, ?, ?, ?, ? WHERE 1 = 1${stockGuards.length ? ' AND ' + stockGuards.join(' AND ') : ''}`,
      params: [name, phone, whatsapp, city, address, note],
    },
    {
      sql: `INSERT INTO orders(order_number, customer_id, status, payment_method, payment_status, currency, subtotal, delivery_fee, total, idempotency_key)
            SELECT ?, last_insert_rowid(), 'pending', 'cod', 'unpaid', 'MAD', ?, 0, ?, ? WHERE changes() = 1`,
      params: [orderNumber, subtotal, subtotal, idempotencyKey],
    },
    ...safeItems.map((item) => ({
      sql: `INSERT INTO order_items(order_id, variant_id, product_name, sku, size, color, unit_price, quantity, line_total)
            SELECT id, ?, ?, ?, ?, ?, ?, ?, ? FROM orders WHERE order_number = ?`,
      params: [
        item.variant?.id ?? null,
        item.name,
        item.variant?.sku || `FA-${item.productId}`,
        item.variant?.size || 'Standard',
        item.variant?.color || 'Default',
        item.price,
        item.quantity,
        item.lineTotal,
        orderNumber,
      ],
    })),
    ...safeItems
      .filter((item) => item.variant)
      .flatMap((item) => [
        {
          sql: `UPDATE product_variants SET stock = stock - ?
                WHERE id = ? AND EXISTS(SELECT 1 FROM orders WHERE order_number = ?)`,
          params: [item.quantity, item.variant!.id, orderNumber],
        },
        {
          sql: `INSERT INTO stock_movements(variant_id, order_id, movement_type, quantity_delta, reason)
                SELECT ?, id, 'sale', ?, 'COD checkout' FROM orders WHERE order_number = ?`,
          params: [item.variant!.id, -item.quantity, orderNumber],
        },
      ]),
    {
      sql: `INSERT INTO notifications(order_id, type, title, message)
            SELECT id, 'order', ?, ? FROM orders WHERE order_number = ?`,
      params: [
        `New COD order · ${orderNumber}`,
        `${name} (${city}) placed an order for ${subtotal} MAD.`,
        orderNumber,
      ],
    },
  ];

  try {
    const results = await db.batch(statements);
    if (!results[0]?.meta.changes || !results[1]?.meta.changes) {
      res.status(409).json({
        error: 'Stock changed while you were checking out. Please refresh your bag and try again.',
      });
      return;
    }
    const orderId = Number(results[1].meta.last_row_id);
    res.status(201).json({
      orderId,
      orderNumber,
      total: subtotal,
      currency: 'MAD',
      status: 'pending',
    });
  } catch {
    const replay = await db.first<Record<string, unknown>>(
      'SELECT id, order_number, total, currency, status FROM orders WHERE idempotency_key = ?',
      [idempotencyKey]
    );
    if (replay) {
      res.status(200).json({
        orderId: replay['id'],
        orderNumber: replay['order_number'],
        total: replay['total'],
        currency: replay['currency'],
        status: replay['status'],
        replayed: true,
      });
      return;
    }
    res.status(409).json({ error: 'Order could not be saved. Please try again.' });
  }
});

// ---------- Admin Auth Routes ----------

app.get('/api/admin/auth-status', async (_req, res) => {
  const mode = await getAuthMode();
  res.json({ configured: mode !== 'unclaimed', mode });
});

app.post('/api/admin/setup-pin', async (req, res) => {
  if ((await getAuthMode()) !== 'unclaimed') {
    res.status(409).json({ error: 'Admin PIN is already configured.' });
    return;
  }

  const pin = String(req.body?.pin || '').trim();
  if (!/^[0-9]{4,8}$/.test(pin)) {
    res.status(400).json({ error: 'Choose a numeric PIN between 4 and 8 digits.' });
    return;
  }

  const db = await getDb();
  const salt = crypto.randomBytes(16).toString('hex');
  const pinHash = hashPin(pin, salt);

  try {
    await db.run('INSERT INTO admin_credentials(id, pin_hash, salt) VALUES (1, ?, ?)', [
      pinHash,
      salt,
    ]);
    const token = issueAdminToken();
    res.status(201).json({ token, mode: 'claimed' });
  } catch {
    res.status(409).json({ error: 'Admin PIN is already configured.' });
  }
});

app.post('/api/admin/login', async (req, res) => {
  const mode = await getAuthMode();
  if (mode === 'unclaimed') {
    res.status(409).json({ error: 'No admin PIN configured yet. Complete initial setup first.' });
    return;
  }

  const db = await getDb();
  const ip = getClientIp(req);
  const cutoff = new Date(Date.now() - ADMIN_WINDOW_MS).toISOString();

  const recent = await db.first<{ attempts: number }>(
    'SELECT COUNT(*) AS attempts FROM admin_pin_attempts WHERE ip = ? AND attempted_at > ?',
    [ip, cutoff]
  );

  if (Number(recent?.attempts || 0) >= ADMIN_LIMIT) {
    res.status(429).json({ error: 'Too many PIN attempts. Try again in 15 minutes.' });
    return;
  }

  const pin = String(req.body?.pin || '').trim();
  if (!pin || !(await verifySubmittedPin(pin))) {
    await db.run('INSERT INTO admin_pin_attempts(ip, attempted_at) VALUES (?, ?)', [
      ip,
      new Date().toISOString(),
    ]);
    res.status(401).json({ error: 'Incorrect access PIN.' });
    return;
  }

  await db.run('DELETE FROM admin_pin_attempts WHERE attempted_at < ?', [cutoff]);
  const token = issueAdminToken();
  res.json({ token, mode });
});

app.post('/api/admin/logout', requireAdminAuth, (_req, res) => {
  res.json({ ok: true });
});

// ---------- Protected Admin CRM Routes ----------

app.get('/api/admin/d1-status', requireAdminAuth, async (_req, res) => {
  await getDb();
  res.json(getDbStatus());
});

app.get('/api/admin/r2-status', requireAdminAuth, (_req, res) => {
  const r2 = getR2Config();
  res.json({
    configured: r2.configured,
    bucket: r2.bucket,
    endpointOrigin: r2.endpointOrigin,
    publicBaseUrl: r2.publicBaseUrl,
  });
});

app.get('/api/admin/products', requireAdminAuth, async (_req, res) => {
  res.json(await loadCatalog(false));
});

app.post('/api/admin/products', requireAdminAuth, async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const category = ['Tops', 'Layers', 'Bottoms'].includes(String(body.category))
    ? String(body.category)
    : 'Tops';
  const tag = String(body.tag || '').trim().slice(0, 60);
  const fabricNote = String(body.fabricNote || '').trim().slice(0, 240);
  const fitNote = String(body.fitNote || '').trim().slice(0, 240);
  const description = String(body.description || '').trim().slice(0, 3000);
  const price = Number(body.price);
  const status = body.status === 'active' ? 'active' : 'draft';

  if (!name || name.length > 160 || !Number.isSafeInteger(price) || price < 0 || price > 1_000_000) {
    res.status(400).json({ error: 'Name and valid integer MAD price are required.' });
    return;
  }

  const slug = String(
    body.slug ||
      name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
  ).slice(0, 160);

  if (!slug) {
    res.status(400).json({ error: 'Invalid product slug.' });
    return;
  }

  const db = await getDb();
  try {
    const result = await db.run(
      'INSERT INTO products(slug, name, category, tag, fabric_note, fit_note, description, price, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [slug, name, category, tag, fabricNote, fitNote, description, price, status]
    );
    res.status(201).json({
      id: result.last_row_id,
      slug,
      name,
      category,
      tag,
      fabricNote,
      fitNote,
      description,
      price,
      status,
    });
  } catch {
    res.status(409).json({ error: 'A product with this slug already exists.' });
  }
});

app.patch('/api/admin/products', requireAdminAuth, async (req, res) => {
  const body = req.body || {};
  const id = Number(body.id);
  const name = String(body.name || '').trim();
  const category = ['Tops', 'Layers', 'Bottoms'].includes(String(body.category))
    ? String(body.category)
    : 'Tops';
  const tag = String(body.tag || '').trim().slice(0, 60);
  const fabricNote = String(body.fabricNote || '').trim().slice(0, 240);
  const fitNote = String(body.fitNote || '').trim().slice(0, 240);
  const description = String(body.description || '').trim();
  const price = Number(body.price);
  const status = String(body.status || '');

  if (
    !Number.isInteger(id) ||
    id < 1 ||
    !name ||
    name.length > 160 ||
    description.length > 3000 ||
    !Number.isSafeInteger(price) ||
    price < 0 ||
    price > 1_000_000 ||
    !['draft', 'active', 'archived'].includes(status)
  ) {
    res.status(400).json({ error: 'Enter a valid product name, price, description, and status.' });
    return;
  }

  const db = await getDb();
  const result = await db.run(
    'UPDATE products SET name = ?, category = ?, tag = ?, fabric_note = ?, fit_note = ?, description = ?, price = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [name, category, tag, fabricNote, fitNote, description, price, status, id]
  );

  if (!result.changes) {
    res.status(404).json({ error: 'Product not found.' });
    return;
  }
  res.json({ id, name, category, tag, fabricNote, fitNote, description, price, status });
});

app.delete('/api/admin/products/:id', requireAdminAuth, async (req, res) => {
  const productId = Number(req.params['id']);
  if (!Number.isInteger(productId) || productId < 1) {
    res.status(400).json({ error: 'Invalid product ID.' });
    return;
  }

  const db = await getDb();
  const keyCol = db.imageKeyCol;

  const existing = await db.first('SELECT id FROM products WHERE id = ?', [productId]);
  if (!existing) {
    res.status(404).json({ error: 'Product not found.' });
    return;
  }

  const linkedOrder = await db.first(
    `SELECT oi.id FROM order_items oi
     JOIN product_variants pv ON pv.id = oi.variant_id
     WHERE pv.product_id = ? LIMIT 1`,
    [productId]
  );
  if (linkedOrder) {
    res.status(409).json({
      error: 'This product is linked to existing COD orders. Set its status to archived instead.',
    });
    return;
  }

  const imageRows = await db.all<{ media_key: string }>(
    `SELECT iv.${keyCol} AS media_key FROM image_variants iv
     JOIN image_assets ia ON ia.id = iv.image_asset_id
     WHERE ia.product_id = ?`,
    [productId]
  );

  try {
    await db.batch([
      {
        sql: 'DELETE FROM stock_movements WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = ?)',
        params: [productId],
      },
      {
        sql: 'DELETE FROM products WHERE id = ?',
        params: [productId],
      },
    ]);
  } catch {
    res.status(500).json({ error: 'Could not delete product.' });
    return;
  }

  for (const row of imageRows) {
    const r2Key = extractR2ObjectKey(row.media_key);
    if (r2Key) {
      void deleteR2Object(r2Key);
    } else if (!row.media_key.startsWith('/assets/') && !row.media_key.startsWith('http')) {
      const absPath = path.resolve(UPLOAD_ROOT, row.media_key);
      if (absPath.startsWith(UPLOAD_ROOT + path.sep) && fs.existsSync(absPath)) {
        try {
          fs.unlinkSync(absPath);
        } catch {}
      }
    }
  }
  res.json({ deleted: true, id: productId });
});

app.post('/api/admin/products/variants', requireAdminAuth, async (req, res) => {
  const body = req.body || {};
  const productId = Number(body.productId);
  const size = String(body.size || '').trim();
  const color = String(body.color || '').trim();
  const colorHex = String(body.colorHex || '').trim();
  const stock = Number(body.stock);

  if (
    !Number.isInteger(productId) ||
    productId < 1 ||
    !size ||
    size.length > 30 ||
    !color ||
    color.length > 50 ||
    !Number.isInteger(stock) ||
    stock < 0 ||
    stock > 100_000 ||
    (colorHex && !/^#[0-9a-fA-F]{6}$/.test(colorHex))
  ) {
    res.status(400).json({ error: 'Enter a valid size, colour, hex code, and stock quantity.' });
    return;
  }

  const db = await getDb();
  const prod = await db.first('SELECT id FROM products WHERE id = ?', [productId]);
  if (!prod) {
    res.status(404).json({ error: 'Product not found.' });
    return;
  }

  const sku = String(
    body.sku || `FA-${productId}-${size}-${color}`.toUpperCase().replace(/[^A-Z0-9-]/g, '-')
  ).slice(0, 80);

  const statements: SqlStatement[] = [
    {
      sql: 'INSERT INTO product_variants(product_id, sku, size, color, color_hex, stock) VALUES (?, ?, ?, ?, ?, ?)',
      params: [productId, sku, size, color, colorHex || null, stock],
    },
  ];
  if (stock > 0) {
    statements.push({
      sql: "INSERT INTO stock_movements(variant_id, movement_type, quantity_delta, reason) SELECT id, 'adjustment', ?, 'Initial stock' FROM product_variants WHERE sku = ?",
      params: [stock, sku],
    });
  }

  try {
    const results = await db.batch(statements);
    res.status(201).json({
      id: results[0].meta.last_row_id,
      productId,
      sku,
      size,
      color,
      color_hex: colorHex || null,
      stock,
    });
  } catch {
    res.status(409).json({ error: 'This size and colour combination or SKU already exists.' });
  }
});

app.patch('/api/admin/products/variants/stock', requireAdminAuth, async (req, res) => {
  const body = req.body || {};
  const variantId = Number(body.variantId);
  const delta = Number(body.delta);
  const reason = String(body.reason || 'Manual CRM adjustment').trim().slice(0, 160);

  if (
    !Number.isInteger(variantId) ||
    variantId < 1 ||
    !Number.isInteger(delta) ||
    delta === 0 ||
    Math.abs(delta) > 100_000
  ) {
    res.status(400).json({ error: 'Enter a valid stock adjustment.' });
    return;
  }

  const db = await getDb();
  try {
    const results = await db.batch([
      {
        sql: 'UPDATE product_variants SET stock = stock + ? WHERE id = ? AND active = 1 AND stock + ? BETWEEN 0 AND 100000',
        params: [delta, variantId, delta],
      },
      {
        sql: "INSERT INTO stock_movements(variant_id, movement_type, quantity_delta, reason) SELECT ?, 'adjustment', ?, ? WHERE changes() = 1",
        params: [variantId, delta, reason],
      },
      {
        sql: "INSERT INTO audit_logs(action, entity_type, entity_id, details) SELECT 'stock_adjustment', 'variant', ?, ? WHERE changes() = 1",
        params: [String(variantId), JSON.stringify({ delta, reason })],
      },
    ]);

    if (!results[0]?.meta.changes) {
      res.status(409).json({ error: 'Stock adjustment would be invalid or variant unavailable.' });
      return;
    }

    const updated = await db.first<{ stock: number }>(
      'SELECT stock FROM product_variants WHERE id = ?',
      [variantId]
    );
    res.json({
      variantId,
      delta,
      stock: Number(updated?.stock || 0),
      stockMovementRecorded: true,
    });
  } catch {
    res.status(500).json({ error: 'Stock adjustment could not be saved.' });
  }
});

// Generate short-lived SigV4 presigned PUT URLs for direct browser -> Cloudflare R2 upload
app.post('/api/admin/images/presign', requireAdminAuth, async (req, res) => {
  const productId = Number(req.body?.productId);
  const rawWidths: unknown[] = Array.isArray(req.body?.widths) ? req.body.widths : [400, 800, 1200];
  const widthSet = new Set<400 | 800 | 1200>();
  for (const w of rawWidths) {
    const num = Number(w);
    if (num === 400 || num === 800 || num === 1200) {
      widthSet.add(num);
    }
  }
  const widths = Array.from(widthSet).sort((a, b) => a - b);

  if (!Number.isInteger(productId) || productId < 1 || !widths.length) {
    res.status(400).json({ error: 'Valid productId and WebP widths are required.' });
    return;
  }

  const db = await getDb();
  const prod = await db.first('SELECT id FROM products WHERE id = ?', [productId]);
  if (!prod) {
    res.status(404).json({ error: 'Product not found.' });
    return;
  }

  const r2 = getR2Config();
  if (!r2.configured) {
    res.json({
      mode: 'local',
      bucket: r2.bucket,
      publicBaseUrl: r2.publicBaseUrl,
    });
    return;
  }

  const batchId = crypto.randomUUID();
  const uploads = widths.map((width) => {
    const key = `products/${productId}/images/${batchId}/${width}.webp`;
    const signed = presignPutObject(key, 300, r2);
    return {
      width,
      objectKey: signed.objectKey,
      putUrl: signed.putUrl,
      publicUrl: signed.publicUrl,
    };
  });

  res.json({
    mode: 'r2-direct',
    batchId,
    bucket: r2.bucket,
    publicBaseUrl: r2.publicBaseUrl,
    uploads,
  });
});

// Confirm direct R2 upload and register variants in Cloudflare D1 / SQLite
app.post('/api/admin/images/complete', requireAdminAuth, async (req, res) => {
  const productId = Number(req.body?.productId);
  const batchId = String(req.body?.batchId || '').trim();
  const altText = String(req.body?.altText || '').trim().slice(0, 240);
  const color = String(req.body?.color || '').trim().slice(0, 50);
  const colorHexRaw = String(req.body?.colorHex || '').trim();
  const colorHex = /^#[0-9a-fA-F]{6}$/.test(colorHexRaw) ? colorHexRaw : null;
  const sortOrder = Number.isInteger(Number(req.body?.sortOrder)) ? Number(req.body?.sortOrder) : 0;
  const rawVariants = Array.isArray(req.body?.variants) ? req.body.variants : [];

  if (!Number.isInteger(productId) || productId < 1 || !/^[0-9a-f-]{36}$/i.test(batchId)) {
    res.status(400).json({ error: 'Valid productId and batchId are required.' });
    return;
  }

  const r2 = getR2Config();
  if (!r2.configured) {
    res.status(503).json({ error: 'Cloudflare R2 credentials are not configured on the server.' });
    return;
  }

  const variants: Array<{
    width: 400 | 800 | 1200;
    byteSize: number;
    objectKey: string;
    publicUrl: string;
  }> = [];
  const seenWidths = new Set<number>();
  for (const raw of rawVariants) {
    const width = Number(raw?.width);
    const byteSize = Number(raw?.byteSize);
    if (
      (width !== 400 && width !== 800 && width !== 1200) ||
      seenWidths.has(width) ||
      !Number.isInteger(byteSize) ||
      byteSize < 1 ||
      byteSize > 5 * 1024 * 1024
    ) {
      res.status(400).json({ error: 'Invalid uploaded WebP variant metadata.' });
      return;
    }
    seenWidths.add(width);
    const objectKey = `products/${productId}/images/${batchId}/${width}.webp`;
    variants.push({
      width,
      byteSize,
      objectKey,
      publicUrl: `${r2.publicBaseUrl}/${objectKey}`,
    });
  }

  if (!variants.length) {
    res.status(400).json({ error: 'Provide at least one uploaded WebP variant.' });
    return;
  }

  const db = await getDb();
  const keyCol = db.imageKeyCol;
  const prod = await db.first('SELECT id FROM products WHERE id = ?', [productId]);
  if (!prod) {
    res.status(404).json({ error: 'Product not found.' });
    return;
  }

  try {
    const checks = await Promise.all(variants.map((v) => headR2Object(v.objectKey, r2)));
    if (checks.some((exists) => !exists)) {
      res.status(409).json({ error: 'Uploaded WebP files were not found in the R2 bucket.' });
      return;
    }
  } catch {
    res.status(502).json({ error: 'Could not verify R2 object storage.' });
    return;
  }

  try {
    const assetRes = await db.run(
      'INSERT INTO image_assets(product_id, alt_text, color, color_hex, sort_order) VALUES (?, ?, ?, ?, ?)',
      [productId, altText, color, colorHex, sortOrder]
    );
    const imageId = assetRes.last_row_id;

    await db.batch(
      variants.map((v) => ({
        sql: `INSERT INTO image_variants(image_asset_id, width, ${keyCol}, content_type, byte_size) VALUES (?, ?, ?, 'image/webp', ?)`,
        params: [imageId, v.width, v.publicUrl, v.byteSize],
      }))
    );

    res.status(201).json({
      id: imageId,
      productId,
      color,
      color_hex: colorHex,
      alt_text: altText,
      storage: 'r2',
      variants: variants.map((v) => ({ width: v.width, url: v.publicUrl, bytes: v.byteSize })),
    });
  } catch {
    res.status(500).json({ error: 'Failed to save R2 image metadata in database.' });
  }
});

// Upload color-tagged product image variants (pushes straight to R2 when configured, or local /media fallback)
app.post(
  '/api/admin/images',
  requireAdminAuth,
  upload.fields([
    { name: '400', maxCount: 1 },
    { name: '800', maxCount: 1 },
    { name: '1200', maxCount: 1 },
  ]),
  async (req, res) => {
    const productId = Number(req.body?.productId);
    const altText = String(req.body?.altText || '').trim().slice(0, 240);
    const color = String(req.body?.color || '').trim().slice(0, 50);
    const colorHexRaw = String(req.body?.colorHex || '').trim();
    const colorHex = /^#[0-9a-fA-F]{6}$/.test(colorHexRaw) ? colorHexRaw : null;
    const sortOrder = Number.isInteger(Number(req.body?.sortOrder)) ? Number(req.body?.sortOrder) : 0;

    if (!Number.isInteger(productId) || productId < 1) {
      res.status(400).json({ error: 'Invalid product ID.' });
      return;
    }

    const db = await getDb();
    const keyCol = db.imageKeyCol;
    const prod = await db.first('SELECT id FROM products WHERE id = ?', [productId]);
    if (!prod) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }

    const fileMap = (req.files || {}) as Record<string, Express.Multer.File[]>;
    const targets: Array<{ width: 400 | 800 | 1200; file: Express.Multer.File }> = [];
    for (const width of [400, 800, 1200] as const) {
      const f = fileMap[String(width)]?.[0];
      if (f) targets.push({ width, file: f });
    }

    if (!targets.length) {
      res.status(400).json({ error: 'Provide at least one WebP variant (400, 800, or 1200).' });
      return;
    }

    for (const { file } of targets) {
      if (file.mimetype !== 'image/webp' || !isWebPBuffer(file.buffer)) {
        res.status(400).json({ error: 'Uploaded variants must be valid WebP images.' });
        return;
      }
    }

    const r2 = getR2Config();
    if (r2.configured) {
      const batchId = crypto.randomUUID();
      const uploadedKeys: string[] = [];
      let imageId = 0;
      try {
        const uploadedUrls = await Promise.all(
          targets.map(async ({ width, file }) => {
            const key = `products/${productId}/images/${batchId}/${width}.webp`;
            const url = await putObjectToR2(key, file.buffer, 'image/webp', r2);
            uploadedKeys.push(key);
            return { width, url, bytes: file.size };
          })
        );

        const assetRes = await db.run(
          'INSERT INTO image_assets(product_id, alt_text, color, color_hex, sort_order) VALUES (?, ?, ?, ?, ?)',
          [productId, altText, color, colorHex, sortOrder]
        );
        imageId = assetRes.last_row_id;

        await db.batch(
          uploadedUrls.map((item) => ({
            sql: `INSERT INTO image_variants(image_asset_id, width, ${keyCol}, content_type, byte_size) VALUES (?, ?, ?, 'image/webp', ?)`,
            params: [imageId, item.width, item.url, item.bytes],
          }))
        );

        res.status(201).json({
          id: imageId,
          productId,
          color,
          color_hex: colorHex,
          alt_text: altText,
          storage: 'r2',
          variants: uploadedUrls,
        });
        return;
      } catch (err) {
        if (imageId) {
          await db.run('DELETE FROM image_assets WHERE id = ?', [imageId]).catch(() => undefined);
        }
        await Promise.all(uploadedKeys.map((k) => deleteR2Object(k, r2)));
        res.status(502).json({
          error: err instanceof Error ? err.message : 'Failed to upload image to Cloudflare R2.',
        });
        return;
      }
    }

    const writtenPaths: string[] = [];
    let imageId = 0;
    try {
      const assetRes = await db.run(
        'INSERT INTO image_assets(product_id, alt_text, color, color_hex, sort_order) VALUES (?, ?, ?, ?, ?)',
        [productId, altText, color, colorHex, sortOrder]
      );
      imageId = assetRes.last_row_id;

      const variantsOut: Array<{ width: number; url: string; bytes: number }> = [];
      const variantInserts: SqlStatement[] = [];
      for (const { width, file } of targets) {
        const relKey = path.posix.join(
          'products',
          String(productId),
          'images',
          String(imageId),
          `${width}.webp`
        );
        const absDest = path.resolve(UPLOAD_ROOT, relKey);
        if (!absDest.startsWith(UPLOAD_ROOT + path.sep)) {
          throw new Error('Invalid destination path.');
        }
        fs.mkdirSync(path.dirname(absDest), { recursive: true });
        fs.writeFileSync(absDest, file.buffer);
        writtenPaths.push(absDest);

        variantInserts.push({
          sql: `INSERT INTO image_variants(image_asset_id, width, ${keyCol}, content_type, byte_size) VALUES (?, ?, ?, 'image/webp', ?)`,
          params: [imageId, width, relKey, file.size],
        });
        variantsOut.push({ width, url: formatImageUrl(relKey), bytes: file.size });
      }

      await db.batch(variantInserts);

      res.status(201).json({
        id: imageId,
        productId,
        color,
        color_hex: colorHex,
        alt_text: altText,
        storage: 'local',
        variants: variantsOut,
      });
    } catch {
      if (imageId) {
        await db.run('DELETE FROM image_assets WHERE id = ?', [imageId]).catch(() => undefined);
      }
      for (const p of writtenPaths) {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {}
      }
      res.status(500).json({ error: 'Failed to store image variants.' });
    }
  }
);

app.patch('/api/admin/images/:id', requireAdminAuth, async (req, res) => {
  const imageId = Number(req.params['id']);
  const color = String(req.body?.color || '').trim().slice(0, 50);
  const colorHexRaw = String(req.body?.colorHex || '').trim();
  const colorHex = colorHexRaw ? (/^#[0-9a-fA-F]{6}$/.test(colorHexRaw) ? colorHexRaw : null) : null;
  const altText =
    req.body?.altText !== undefined ? String(req.body.altText).trim().slice(0, 240) : undefined;

  if (!Number.isInteger(imageId) || imageId < 1) {
    res.status(400).json({ error: 'Invalid image ID.' });
    return;
  }
  if (colorHexRaw && !colorHex) {
    res.status(400).json({ error: 'Colour hex must be in #RRGGBB format.' });
    return;
  }

  const db = await getDb();
  const result =
    altText !== undefined
      ? await db.run('UPDATE image_assets SET color = ?, color_hex = ?, alt_text = ? WHERE id = ?', [
          color,
          colorHex,
          altText,
          imageId,
        ])
      : await db.run('UPDATE image_assets SET color = ?, color_hex = ? WHERE id = ?', [
          color,
          colorHex,
          imageId,
        ]);

  if (!result.changes) {
    res.status(404).json({ error: 'Image asset not found.' });
    return;
  }
  res.json({ id: imageId, color, color_hex: colorHex });
});

app.delete('/api/admin/images/:id', requireAdminAuth, async (req, res) => {
  const imageId = Number(req.params['id']);
  if (!Number.isInteger(imageId) || imageId < 1) {
    res.status(400).json({ error: 'Invalid image ID.' });
    return;
  }
  const db = await getDb();
  const keyCol = db.imageKeyCol;

  const variants = await db.all<{ media_key: string }>(
    `SELECT ${keyCol} AS media_key FROM image_variants WHERE image_asset_id = ?`,
    [imageId]
  );

  const del = await db.run('DELETE FROM image_assets WHERE id = ?', [imageId]);
  if (!del.changes) {
    res.status(404).json({ error: 'Image asset not found.' });
    return;
  }

  for (const v of variants) {
    const r2Key = extractR2ObjectKey(v.media_key);
    if (r2Key) {
      void deleteR2Object(r2Key);
    } else if (!v.media_key.startsWith('/assets/') && !v.media_key.startsWith('http')) {
      const absPath = path.resolve(UPLOAD_ROOT, v.media_key);
      if (absPath.startsWith(UPLOAD_ROOT + path.sep) && fs.existsSync(absPath)) {
        try {
          fs.unlinkSync(absPath);
        } catch {}
      }
    }
  }
  res.json({ deleted: true, id: imageId });
});

app.get('/api/admin/orders', requireAdminAuth, async (req, res) => {
  const search = String(req.query['q'] || '').trim().slice(0, 100);
  const db = await getDb();

  const orders = search
    ? await db.all<Record<string, unknown>>(
        `SELECT o.id, o.order_number, o.total, o.status, o.created_at,
                c.full_name, c.phone, c.whatsapp_phone, c.city, c.address, c.delivery_note
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         WHERE o.order_number LIKE ? OR o.status LIKE ? OR c.full_name LIKE ? OR c.phone LIKE ? OR c.whatsapp_phone LIKE ? OR c.city LIKE ? OR c.address LIKE ?
         ORDER BY o.created_at DESC, o.id DESC
         LIMIT 50`,
        Array(7).fill(`%${search}%`)
      )
    : await db.all<Record<string, unknown>>(
        `SELECT o.id, o.order_number, o.total, o.status, o.created_at,
                c.full_name, c.phone, c.whatsapp_phone, c.city, c.address, c.delivery_note
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         ORDER BY o.created_at DESC, o.id DESC
         LIMIT 50`
      );

  if (!orders.length) {
    res.json([]);
    return;
  }

  const orderIds = orders.map((o) => Number(o['id']));
  const placeholders = orderIds.map(() => '?').join(', ');
  const allItems = await db.all<Record<string, unknown>>(
    `SELECT order_id, variant_id, product_name, sku, size, color, unit_price, quantity, line_total
     FROM order_items WHERE order_id IN (${placeholders})`,
    orderIds
  );

  const itemsByOrder = new Map<number, Array<Record<string, unknown>>>();
  for (const it of allItems) {
    const oid = Number(it['order_id']);
    const list = itemsByOrder.get(oid) || [];
    list.push(it);
    itemsByOrder.set(oid, list);
  }

  res.json(
    orders.map((o) => ({
      ...o,
      items: (itemsByOrder.get(Number(o['id'])) || []).map((it: any) => ({
        productId: 0,
        variantId: it.variant_id,
        productName: it.product_name,
        sku: it.sku,
        size: it.size,
        color: it.color,
        unitPrice: Number(it.unit_price),
        quantity: Number(it.quantity),
        lineTotal: Number(it.line_total),
      })),
    }))
  );
});

app.patch('/api/admin/orders', requireAdminAuth, async (req, res) => {
  const id = Number(req.body?.id);
  const status = String(req.body?.status || '');
  const allowed = [
    'pending',
    'confirmed',
    'preparing',
    'shipped',
    'out_for_delivery',
    'delivered',
    'cancelled',
    'returned',
  ];
  if (!Number.isInteger(id) || id < 1 || !allowed.includes(status)) {
    res.status(400).json({ error: 'Invalid order or status.' });
    return;
  }

  const transitions: Record<string, string[]> = {
    pending: ['confirmed', 'cancelled'],
    confirmed: ['preparing', 'cancelled'],
    preparing: ['shipped', 'cancelled'],
    shipped: ['out_for_delivery', 'returned'],
    out_for_delivery: ['delivered', 'returned'],
    delivered: ['returned'],
    cancelled: [],
    returned: [],
  };

  const db = await getDb();
  const prior = await db.first<{ status: string }>('SELECT status FROM orders WHERE id = ?', [id]);
  if (!prior) {
    res.status(404).json({ error: 'Order not found.' });
    return;
  }
  if (prior.status === status) {
    res.json({ id, status, unchanged: true });
    return;
  }
  if (!(transitions[prior.status] || []).includes(status)) {
    res.status(409).json({ error: 'This order status transition is not allowed.' });
    return;
  }

  const restoring = status === 'cancelled' && !['cancelled', 'returned'].includes(prior.status);

  const statements: SqlStatement[] = [
    {
      sql: 'UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?',
      params: [status, id, prior.status],
    },
  ];

  if (restoring) {
    const items = await db.all<{ variant_id: number; quantity: number }>(
      'SELECT variant_id, quantity FROM order_items WHERE order_id = ? AND variant_id IS NOT NULL',
      [id]
    );
    for (const item of items) {
      statements.push({
        sql: `UPDATE product_variants
              SET stock = stock + ?
              WHERE id = ?
                AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'cancelled')
                AND NOT EXISTS (
                  SELECT 1 FROM stock_movements
                  WHERE order_id = ? AND variant_id = ? AND movement_type = 'cancel_restore'
                )`,
        params: [item.quantity, item.variant_id, id, id, item.variant_id],
      });
      statements.push({
        sql: "INSERT INTO stock_movements(variant_id, order_id, movement_type, quantity_delta, reason) SELECT ?, ?, 'cancel_restore', ?, 'Order cancelled' WHERE changes() = 1",
        params: [item.variant_id, id, item.quantity],
      });
    }
  }

  statements.push({
    sql: "INSERT INTO audit_logs(action, entity_type, entity_id, details) SELECT 'order_status_change', 'order', ?, ? WHERE changes() = 1 OR 1 = 1",
    params: [String(id), JSON.stringify({ from: prior.status, to: status, stockRestored: restoring })],
  });

  try {
    const results = await db.batch(statements);
    if (!results[0]?.meta.changes) {
      res.status(409).json({ error: 'Order status changed concurrently.' });
      return;
    }
    res.json({ id, status, stockRestored: restoring });
  } catch {
    res.status(500).json({ error: 'Order status update could not be saved.' });
  }
});

app.get('/api/admin/notifications', requireAdminAuth, async (_req, res) => {
  const db = await getDb();
  const rows = await db.all(
    'SELECT id, order_id, type, title, message, is_read, created_at FROM notifications ORDER BY created_at DESC, id DESC LIMIT 50'
  );
  res.json(rows);
});

app.patch('/api/admin/notifications', requireAdminAuth, async (req, res) => {
  const id = Number(req.body?.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid notification ID.' });
    return;
  }
  const db = await getDb();
  const result = await db.run('UPDATE notifications SET is_read = 1 WHERE id = ?', [id]);
  if (!result.changes) {
    res.status(404).json({ error: 'Notification not found.' });
    return;
  }
  res.json({ id, is_read: 1 });
});

app.get('/api/admin/inventory-audit', requireAdminAuth, async (_req, res) => {
  const db = await getDb();
  const rows = await db.all<Record<string, unknown>>(
    `SELECT v.id AS variant_id, v.sku, v.size, v.color, v.stock, p.id AS product_id, p.name AS product_name,
            COALESCE(SUM(m.quantity_delta), 0) AS ledger_total, COUNT(m.id) AS movement_count
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     LEFT JOIN stock_movements m ON m.variant_id = v.id
     GROUP BY v.id
     ORDER BY p.name, v.size, v.color`
  );

  res.json(
    rows.map((r) => ({
      ...r,
      stock: Number(r['stock']),
      ledger_total: Number(r['ledger_total']),
      difference: Number(r['stock']) - Number(r['ledger_total']),
      movement_count: Number(r['movement_count']),
    }))
  );
});

app.get('/api/admin/stock-movements', requireAdminAuth, async (req, res) => {
  const variantId = Number(req.query['variantId'] || 0);
  const search = String(req.query['q'] || '').trim().slice(0, 80);

  let sql = `
    SELECT m.id, m.variant_id, m.order_id, m.movement_type, m.quantity_delta, m.reason, m.created_at,
           v.sku, v.size, v.color, p.name AS product_name, o.order_number
    FROM stock_movements m
    JOIN product_variants v ON m.variant_id = v.id
    JOIN products p ON p.id = v.product_id
    LEFT JOIN orders o ON o.id = m.order_id
    WHERE 1 = 1
  `;
  const binds: Array<string | number> = [];

  if (variantId > 0) {
    sql += ' AND m.variant_id = ?';
    binds.push(variantId);
  }
  if (search) {
    sql += ' AND (v.sku LIKE ? OR p.name LIKE ? OR o.order_number LIKE ? OR m.reason LIKE ?)';
    binds.push(...Array(4).fill(`%${search}%`));
  }
  sql += ' ORDER BY m.created_at DESC, m.id DESC LIMIT 200';

  const db = await getDb();
  res.json(await db.all(sql, binds));
});

app.patch('/api/admin/store-settings', requireAdminAuth, async (req, res) => {
  if (typeof req.body?.priceVisible !== 'boolean') {
    res.status(400).json({ error: 'priceVisible must be a boolean.' });
    return;
  }
  const db = await getDb();
  await db.run(
    "INSERT INTO store_settings(key, value) VALUES ('price_visible', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [req.body.priceVisible ? '1' : '0']
  );
  res.json({ priceVisible: req.body.priceVisible });
});

// Serve static assets from browser dist in production
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  })
);

// Angular SSR catch-all (must be last)
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url)) {
  const port = Number(process.env['PORT'] || 3000);
  app.listen(port, '0.0.0.0', () => {
    void getDb().catch((err) => {
      console.error('[MOKIKO DB] Initialization error:', err);
    });
    console.log(`MOKIKO SPORT server listening on http://0.0.0.0:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
