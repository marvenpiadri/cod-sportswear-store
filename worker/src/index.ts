export interface Env {
  DB: D1Database;
  PRODUCT_MEDIA: R2Bucket;
  PUBLIC_MEDIA_BASE?: string;
  R2_BUCKET?: string;
  CF_ACCOUNT_ID?: string;
  CF_D1_DATABASE_ID?: string;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

const cors = (response: Response) => {
  const h = new Headers(response.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  h.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers: h });
};

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const submitted = auth.slice('Bearer '.length).trim();
  if (!/^[0-9]+$/.test(submitted)) return false;
  const row = await env.DB.prepare('SELECT pin FROM admin_pins ORDER BY id LIMIT 1').first<{ pin: number | string }>();
  const expected = row == null ? '' : String(row.pin).trim();
  return Boolean(expected) && timingSafeEqualStr(submitted, expected);
}

const ADMIN_LIMIT = 10;
const ADMIN_WINDOW_MS = 15 * 60 * 1000;

async function adminAuth(request: Request, env: Env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const cutoff = new Date(Date.now() - ADMIN_WINDOW_MS).toISOString();
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS attempts FROM admin_pin_attempts WHERE ip = ? AND attempted_at > ?'
  )
    .bind(ip, cutoff)
    .first<{ attempts: number }>();
  if (Number(recent?.attempts || 0) >= ADMIN_LIMIT) {
    return {
      ok: false,
      response: json({ error: 'Too many PIN attempts. Try again in 15 minutes.' }, 429),
    };
  }
  if (await authorized(request, env)) {
    await env.DB.prepare('DELETE FROM admin_pin_attempts WHERE attempted_at < ?').bind(cutoff).run();
    return { ok: true };
  }
  await env.DB.prepare('INSERT INTO admin_pin_attempts(ip, attempted_at) VALUES (?, ?)')
    .bind(ip, new Date().toISOString())
    .run();
  return { ok: false, response: json({ error: 'Unauthorized' }, 401) };
}

const mediaUrl = (env: Env, key: string) => {
  if (key.startsWith('/assets/') || key.startsWith('http://') || key.startsWith('https://')) {
    return key;
  }
  return env.PUBLIC_MEDIA_BASE ? `${env.PUBLIC_MEDIA_BASE.replace(/\/$/, '')}/${key}` : null;
};

async function readPriceVisibility(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM store_settings WHERE key = 'price_visible'")
    .first<{ value: string }>();
  return row?.value !== '0';
}

async function catalog(env: Env, activeOnly: boolean) {
  const prodSql = activeOnly
    ? "SELECT id, slug, name, category, tag, fabric_note, fit_note, description, price, status FROM products WHERE status = 'active' ORDER BY id DESC"
    : 'SELECT id, slug, name, category, tag, fabric_note, fit_note, description, price, status FROM products ORDER BY id DESC';

  const imgSql =
    'SELECT a.id, a.product_id, a.alt_text, a.color, a.color_hex, a.sort_order, v.width, v.r2_key, v.byte_size FROM image_assets a JOIN image_variants v ON v.image_asset_id = a.id ORDER BY a.product_id ASC, a.sort_order ASC, a.id ASC, v.width ASC';
  const varSql =
    'SELECT id, product_id, sku, size, color, color_hex, stock FROM product_variants WHERE active = 1 ORDER BY id ASC';

  const [priceVisible, prodRes, imgRes, varRes] = await Promise.all([
    readPriceVisibility(env),
    env.DB.prepare(prodSql).all<Record<string, unknown>>(),
    env.DB.prepare(imgSql).all<Record<string, unknown>>(),
    env.DB.prepare(varSql).all<Record<string, unknown>>(),
  ]);

  const imagesByProduct = new Map<number, Array<Record<string, unknown>>>();
  for (const row of imgRes.results) {
    const pid = Number(row['product_id']);
    const list = imagesByProduct.get(pid) || [];
    list.push(row);
    imagesByProduct.set(pid, list);
  }

  const variantsByProduct = new Map<number, Array<Record<string, unknown>>>();
  for (const row of varRes.results) {
    const pid = Number(row['product_id']);
    const list = variantsByProduct.get(pid) || [];
    list.push(row);
    variantsByProduct.set(pid, list);
  }

  return prodRes.results.map((p) => {
    const productId = Number(p['id']);
    const rawImages = imagesByProduct.get(productId) || [];
    const variants = variantsByProduct.get(productId) || [];

    const grouped = new Map<
      number,
      {
        id: number;
        alt_text: string;
        color: string;
        color_hex: string | null;
        url: string | null;
        variants: Array<{ width: number; url: string | null; byte_size: number }>;
      }
    >();

    for (const row of rawImages) {
      const assetId = Number(row['id']);
      const url = mediaUrl(env, String(row['r2_key']));
      const width = Number(row['width']);
      const byteSize = Number(row['byte_size']);
      let entry = grouped.get(assetId);
      if (!entry) {
        entry = {
          id: assetId,
          alt_text: String(row['alt_text'] || ''),
          color: String(row['color'] || ''),
          color_hex: row['color_hex'] ? String(row['color_hex']) : null,
          url,
          variants: [],
        };
        grouped.set(assetId, entry);
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
      images: Array.from(grouped.values()),
      variants,
    };
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    if (url.pathname === '/api/health') {
      return cors(
        json({
          ok: true,
          database: 'cloudflare-d1',
          databaseName: 'mokiko',
          databaseId: env.CF_D1_DATABASE_ID || '3f54f739-90d2-4f98-9a15-d4cb32c288b4',
          service: 'mokiko-sport-api',
        })
      );
    }

    if (url.pathname === '/api/products' && request.method === 'GET') {
      return cors(json(await catalog(env, true)));
    }

    if (url.pathname === '/api/store-settings' && request.method === 'GET') {
      return cors(json({ priceVisible: await readPriceVisibility(env) }));
    }

    if (url.pathname === '/api/admin/auth-status' && request.method === 'GET') {
      const pin = await env.DB.prepare('SELECT pin FROM admin_pins LIMIT 1').first<{ pin: number | string }>();
      return cors(json({ configured: pin != null, mode: 'database' }));
    }

    if (url.pathname === '/api/admin/d1-status' && request.method === 'GET') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      return cors(
        json({
          mode: 'cloudflare-d1',
          configured: true,
          databaseName: 'mokiko',
          databaseId: env.CF_D1_DATABASE_ID || '3f54f739-90d2-4f98-9a15-d4cb32c288b4',
          accountId: env.CF_ACCOUNT_ID || '44d2687132765f2b95d4916a4687c0c0',
        })
      );
    }

    if (url.pathname === '/api/admin/r2-status' && request.method === 'GET') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      return cors(
        json({
          configured: Boolean(env.PRODUCT_MEDIA),
          bucket: env.R2_BUCKET || 'mokiko',
          endpointOrigin: `https://${env.CF_ACCOUNT_ID || '44d2687132765f2b95d4916a4687c0c0'}.r2.cloudflarestorage.com`,
          publicBaseUrl: env.PUBLIC_MEDIA_BASE || 'https://pub-22f1ea2ceedc494a88c49453ea8b15bd.r2.dev',
        })
      );
    }

    if (url.pathname === '/api/admin/store-settings' && request.method === 'PATCH') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return cors(json({ error: 'Invalid JSON' }, 400));
      }
      if (typeof body.priceVisible !== 'boolean') {
        return cors(json({ error: 'priceVisible must be boolean.' }, 400));
      }
      await env.DB.prepare(
        "INSERT INTO store_settings(key, value) VALUES('price_visible', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
        .bind(body.priceVisible ? '1' : '0')
        .run();
      return cors(json({ priceVisible: body.priceVisible }));
    }

    if (url.pathname === '/api/orders' && request.method === 'POST') {
      if (!(await readPriceVisibility(env))) {
        return cors(json({ error: 'Online ordering is currently unavailable.' }, 403));
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      await env.DB.prepare('DELETE FROM order_attempts WHERE attempted_at < ?').bind(cutoff).run();
      const count = await env.DB.prepare(
        'SELECT COUNT(*) AS attempts FROM order_attempts WHERE ip = ? AND attempted_at > ?'
      )
        .bind(ip, cutoff)
        .first<{ attempts: number }>();
      if (Number(count?.attempts || 0) >= 15) {
        return cors(json({ error: 'Too many order attempts. Please try again later.' }, 429));
      }
      await env.DB.prepare('INSERT INTO order_attempts(ip, attempted_at) VALUES(?, ?)')
        .bind(ip, new Date().toISOString())
        .run();

      let body: any;
      try {
        body = await request.json();
      } catch {
        return cors(json({ error: 'Invalid JSON' }, 400));
      }
      const idempotencyKey = String(body.idempotencyKey || '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(idempotencyKey)) {
        return cors(json({ error: 'A valid checkout request key is required.' }, 400));
      }
      const previous: any = await env.DB.prepare(
        'SELECT id, order_number, total, currency, status FROM orders WHERE idempotency_key = ?'
      )
        .bind(idempotencyKey)
        .first();
      if (previous) {
        return cors(
          json(
            {
              orderId: previous.id,
              orderNumber: previous.order_number,
              total: previous.total,
              currency: previous.currency,
              status: previous.status,
              replayed: true,
            },
            200
          )
        );
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
        return cors(
          json(
            { error: 'Please check customer details and cart items. Fields may be too long or invalid.' },
            400
          )
        );
      }

      const groupedItems = new Map<
        string,
        { productId: number; variantId: number | null; quantity: number }
      >();
      for (const item of items) {
        const productId = Number(item.productId);
        const quantity = Number(item.quantity);
        const variantId = item.variantId == null ? null : Number(item.variantId);
        if (
          !Number.isInteger(productId) ||
          productId < 1 ||
          !Number.isInteger(quantity) ||
          quantity < 1 ||
          quantity > 20 ||
          (variantId !== null && (!Number.isInteger(variantId) || variantId < 1))
        ) {
          return cors(json({ error: 'Invalid cart item.' }, 400));
        }
        const key = `${productId}:${variantId ?? 'standard'}`;
        const total = (groupedItems.get(key)?.quantity || 0) + quantity;
        if (total > 20) {
          return cors(json({ error: 'Maximum quantity per product option is 20.' }, 400));
        }
        groupedItems.set(key, { productId, variantId, quantity: total });
      }

      const safeItems: any[] = [];
      for (const grouped of groupedItems.values()) {
        const product: any = await env.DB.prepare(
          "SELECT id, name, price FROM products WHERE id = ? AND status = 'active'"
        )
          .bind(grouped.productId)
          .first();
        if (!product) {
          return cors(json({ error: 'One of the products is no longer available.' }, 409));
        }
        const variantRows = await env.DB.prepare(
          'SELECT id FROM product_variants WHERE product_id = ? AND active = 1'
        )
          .bind(grouped.productId)
          .all();
        if (variantRows.results.length && !grouped.variantId) {
          return cors(json({ error: `Please select a size and colour for ${product.name}.` }, 409));
        }
        let variant: any = null;
        if (grouped.variantId) {
          variant = await env.DB.prepare(
            'SELECT id, sku, size, color, stock FROM product_variants WHERE id = ? AND product_id = ? AND active = 1'
          )
            .bind(grouped.variantId, grouped.productId)
            .first();
          if (!variant) {
            return cors(json({ error: 'The selected size or colour is no longer available.' }, 409));
          }
          if (Number(variant.stock) < grouped.quantity) {
            return cors(
              json(
                { error: `Not enough stock for ${product.name} (${variant.size} / ${variant.color}).` },
                409
              )
            );
          }
        }
        safeItems.push({
          ...product,
          variant,
          quantity: grouped.quantity,
          lineTotal: Number(product.price) * grouped.quantity,
        });
      }

      const subtotal = safeItems.reduce((sum, item) => sum + item.lineTotal, 0);
      if (subtotal > 10000000) return cors(json({ error: 'Order total is too high.' }, 400));

      const orderNumber =
        'MK-' + Date.now().toString(36).toUpperCase().slice(-5) + '-' + crypto.randomUUID().slice(0, 4).toUpperCase();
      const stockGuards = safeItems
        .filter((item) => item.variant)
        .map(
          (item) =>
            `EXISTS(SELECT 1 FROM product_variants WHERE id = ${Number(item.variant.id)} AND active = 1 AND stock >= ${Number(item.quantity)})`
        );

      const statements = [
        env.DB.prepare(
          `INSERT INTO customers(full_name, phone, whatsapp_phone, city, address, delivery_note) SELECT ?, ?, ?, ?, ?, ? WHERE 1 = 1${
            stockGuards.length ? ' AND ' + stockGuards.join(' AND ') : ''
          }`
        ).bind(name, phone, whatsapp, city, address, note),
        env.DB.prepare(
          "INSERT INTO orders(order_number, customer_id, status, payment_method, payment_status, currency, subtotal, delivery_fee, total, idempotency_key) SELECT ?, last_insert_rowid(), 'pending', 'cod', 'unpaid', 'MAD', ?, 0, ?, ? WHERE changes() = 1"
        ).bind(orderNumber, subtotal, subtotal, idempotencyKey),
        ...safeItems.map((item) =>
          env.DB.prepare(
            'INSERT INTO order_items(order_id, variant_id, product_name, sku, size, color, unit_price, quantity, line_total) SELECT id, ?, ?, ?, ?, ?, ?, ?, ? FROM orders WHERE order_number = ?'
          ).bind(
            item.variant?.id ?? null,
            item.name,
            item.variant?.sku || `FA-${item.id}`,
            item.variant?.size || 'Standard',
            item.variant?.color || 'Default',
            item.price,
            item.quantity,
            item.lineTotal,
            orderNumber
          )
        ),
        ...safeItems
          .filter((item) => item.variant)
          .flatMap((item) => [
            env.DB.prepare(
              'UPDATE product_variants SET stock = stock - ? WHERE id = ? AND EXISTS(SELECT 1 FROM orders WHERE order_number = ?)'
            ).bind(item.quantity, item.variant.id, orderNumber),
            env.DB.prepare(
              "INSERT INTO stock_movements(variant_id, order_id, movement_type, quantity_delta, reason) SELECT ?, id, 'sale', ?, 'COD checkout' FROM orders WHERE order_number = ?"
            ).bind(item.variant.id, -item.quantity, orderNumber),
          ]),
        env.DB.prepare(
          "INSERT INTO notifications(order_id, type, title, message) SELECT id, 'order', ?, ? FROM orders WHERE order_number = ?"
        ).bind(
          `New COD order · ${orderNumber}`,
          `${name} (${city}) placed an order for ${subtotal} MAD.`,
          orderNumber
        ),
      ];

      try {
        const results = await env.DB.batch(statements);
        if (!results[0].meta.changes || !results[1].meta.changes) {
          return cors(
            json(
              { error: 'Stock changed while you were checking out. Please refresh your bag and try again.' },
              409
            )
          );
        }
        return cors(
          json(
            {
              orderId: results[1].meta.last_row_id,
              orderNumber,
              total: subtotal,
              currency: 'MAD',
              status: 'pending',
            },
            201
          )
        );
      } catch {
        const replay: any = await env.DB.prepare(
          'SELECT id, order_number, total, currency, status FROM orders WHERE idempotency_key = ?'
        )
          .bind(idempotencyKey)
          .first();
        if (replay) {
          return cors(
            json(
              {
                orderId: replay.id,
                orderNumber: replay.order_number,
                total: replay.total,
                currency: replay.currency,
                status: replay.status,
                replayed: true,
              },
              200
            )
          );
        }
        return cors(json({ error: 'Order could not be saved. Please try again.' }, 500));
      }
    }

    if (url.pathname === '/api/admin/stock-movements' && request.method === 'GET') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      const variantId = Number(url.searchParams.get('variantId') || 0);
      const search = String(url.searchParams.get('q') || '').trim().slice(0, 80);
      let sql =
        'SELECT m.id, m.variant_id, m.order_id, m.movement_type, m.quantity_delta, m.reason, m.created_at, v.sku, v.size, v.color, p.name AS product_name, o.order_number FROM stock_movements m JOIN product_variants v ON m.variant_id = v.id JOIN products p ON p.id = v.product_id LEFT JOIN orders o ON o.id = m.order_id WHERE 1 = 1';
      const binds: any[] = [];
      if (variantId > 0) {
        sql += ' AND m.variant_id = ?';
        binds.push(variantId);
      }
      if (search) {
        sql += ' AND (v.sku LIKE ? OR p.name LIKE ? OR o.order_number LIKE ? OR m.reason LIKE ?)';
        binds.push(...Array(4).fill(`%${search}%`));
      }
      sql += ' ORDER BY m.created_at DESC, m.id DESC LIMIT 200';
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      return cors(json(results));
    }

    if (url.pathname === '/api/admin/inventory-audit' && request.method === 'GET') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      const { results } = await env.DB.prepare(
        'SELECT v.id AS variant_id, v.sku, v.size, v.color, v.stock, p.id AS product_id, p.name AS product_name, COALESCE(SUM(m.quantity_delta), 0) AS ledger_total, COUNT(m.id) AS movement_count FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN stock_movements m ON m.variant_id = v.id GROUP BY v.id ORDER BY p.name, v.size, v.color'
      ).all();
      return cors(
        json(
          results.map((r: any) => ({
            ...r,
            stock: Number(r.stock),
            ledger_total: Number(r.ledger_total),
            difference: Number(r.stock) - Number(r.ledger_total),
            movement_count: Number(r.movement_count),
          }))
        )
      );
    }

    if (url.pathname === '/api/admin/notifications' && request.method === 'GET') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      const { results } = await env.DB.prepare(
        'SELECT id, order_id, type, title, message, is_read, created_at FROM notifications ORDER BY created_at DESC LIMIT 50'
      ).all();
      return cors(json(results));
    }

    if (url.pathname === '/api/admin/notifications' && request.method === 'PATCH') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return cors(json({ error: 'Invalid JSON' }, 400));
      }
      const id = Number(body.id);
      if (!Number.isInteger(id) || id < 1) return cors(json({ error: 'Invalid notification.' }, 400));
      const result = await env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').bind(id).run();
      if (!result.meta.changes) return cors(json({ error: 'Notification not found.' }, 404));
      return cors(json({ id, is_read: 1 }));
    }

    if (url.pathname === '/api/admin/orders' && request.method === 'PATCH') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return cors(json({ error: 'Invalid JSON' }, 400));
      }
      const id = Number(body.id);
      const status = String(body.status || '');
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
        return cors(json({ error: 'Invalid order or status.' }, 400));
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
      const prior: any = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(id).first();
      if (!prior) return cors(json({ error: 'Order not found.' }, 404));
      if (prior.status === status) return cors(json({ id, status, unchanged: true }));
      if (!(transitions[prior.status] || []).includes(status)) {
        return cors(json({ error: 'This order status transition is not allowed.' }, 409));
      }
      const restoring = status === 'cancelled' && !['cancelled', 'returned'].includes(prior.status);
      const statements = [
        env.DB.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?').bind(
          status,
          id,
          prior.status
        ),
      ];
      if (restoring) {
        const { results: items } = await env.DB.prepare(
          'SELECT variant_id, quantity FROM order_items WHERE order_id = ? AND variant_id IS NOT NULL'
        )
          .bind(id)
          .all();
        for (const item of items as any[]) {
          statements.push(
            env.DB.prepare(
              "UPDATE product_variants SET stock = stock + ? WHERE id = ? AND EXISTS(SELECT 1 FROM orders WHERE id = ? AND status = 'cancelled') AND NOT EXISTS(SELECT 1 FROM stock_movements WHERE order_id = ? AND variant_id = ? AND movement_type = 'cancel_restore')"
            ).bind(item.quantity, item.variant_id, id, id, item.variant_id)
          );
          statements.push(
            env.DB.prepare(
              "INSERT INTO stock_movements(variant_id, order_id, movement_type, quantity_delta, reason) SELECT ?, ?, 'cancel_restore', ?, 'Order cancelled' WHERE changes() = 1"
            ).bind(item.variant_id, id, item.quantity)
          );
        }
      }
      statements.push(
        env.DB.prepare(
          "INSERT INTO audit_logs(action, entity_type, entity_id, details) SELECT 'order_status_change', 'order', ?, ? WHERE changes() = 1 OR 1 = 1"
        ).bind(String(id), JSON.stringify({ from: prior.status, to: status, stockRestored: restoring }))
      );
      try {
        const results = await env.DB.batch(statements);
        if (!results[0].meta.changes) {
          return cors(json({ error: 'Order status changed concurrently. Refresh and try again.' }, 409));
        }
        return cors(json({ id, status, stockRestored: restoring }));
      } catch {
        return cors(json({ error: 'Order update could not be saved.' }, 500));
      }
    }

    if (url.pathname === '/api/admin/orders' && request.method === 'GET') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      const search = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      const sql = search
        ? 'SELECT o.id, o.order_number, o.total, o.status, o.created_at, c.full_name, c.phone, c.whatsapp_phone, c.city, c.address, c.delivery_note FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.order_number LIKE ? OR o.status LIKE ? OR c.full_name LIKE ? OR c.phone LIKE ? OR c.whatsapp_phone LIKE ? OR c.city LIKE ? OR c.address LIKE ? ORDER BY o.created_at DESC LIMIT 50'
        : 'SELECT o.id, o.order_number, o.total, o.status, o.created_at, c.full_name, c.phone, c.whatsapp_phone, c.city, c.address, c.delivery_note FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.created_at DESC LIMIT 50';
      const statement = env.DB.prepare(sql);
      const { results: orders } = search
        ? await statement.bind(...Array(7).fill(`%${search}%`)).all<any>()
        : await statement.all<any>();
      if (!orders.length) return cors(json([]));
      const ids = orders.map((o: any) => Number(o.id));
      const { results: allItems } = await env.DB.prepare(
        `SELECT order_id, variant_id, product_name, sku, size, color, unit_price, quantity, line_total FROM order_items WHERE order_id IN (${ids.map(() => '?').join(', ')})`
      )
        .bind(...ids)
        .all<any>();
      const byOrder = new Map<number, any[]>();
      for (const it of allItems) {
        const list = byOrder.get(Number(it.order_id)) || [];
        list.push({
          productId: 0,
          variantId: it.variant_id,
          productName: it.product_name,
          sku: it.sku,
          size: it.size,
          color: it.color,
          unitPrice: Number(it.unit_price),
          quantity: Number(it.quantity),
          lineTotal: Number(it.line_total),
        });
        byOrder.set(Number(it.order_id), list);
      }
      return cors(json(orders.map((o: any) => ({ ...o, items: byOrder.get(Number(o.id)) || [] }))));
    }

    if (url.pathname === '/api/admin/products' && request.method === 'GET') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      return cors(json(await catalog(env, false)));
    }

    if (url.pathname === '/api/admin/products' && request.method === 'POST') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return cors(json({ error: 'Invalid JSON' }, 400));
      }
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
      if (!name || name.length > 160 || !Number.isSafeInteger(price) || price < 0 || price > 1000000) {
        return cors(json({ error: 'Name and valid price are required.' }, 400));
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
      if (!slug) return cors(json({ error: 'Invalid slug' }, 400));
      try {
        const result = await env.DB.prepare(
          'INSERT INTO products(slug, name, category, tag, fabric_note, fit_note, description, price, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
          .bind(slug, name, category, tag, fabricNote, fitNote, description, price, status)
          .run();
        return cors(
          json(
            {
              id: result.meta.last_row_id,
              slug,
              name,
              category,
              tag,
              fabricNote,
              fitNote,
              description,
              price,
              status,
            },
            201
          )
        );
      } catch {
        return cors(json({ error: 'Slug may already exist.' }, 409));
      }
    }

    if (url.pathname === '/api/admin/products' && request.method === 'PATCH') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return cors(json({ error: 'Invalid JSON' }, 400));
      }
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
        price > 1000000 ||
        !['draft', 'active', 'archived'].includes(status)
      ) {
        return cors(json({ error: 'Enter a valid product name, description, price and status.' }, 400));
      }
      const result = await env.DB.prepare(
        'UPDATE products SET name = ?, category = ?, tag = ?, fabric_note = ?, fit_note = ?, description = ?, price = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      )
        .bind(name, category, tag, fabricNote, fitNote, description, price, status, id)
        .run();
      if (!result.meta.changes) return cors(json({ error: 'Product not found.' }, 404));
      return cors(json({ id, name, category, tag, fabricNote, fitNote, description, price, status }));
    }

    const deleteProductMatch = url.pathname.match(/^\/api\/admin\/products\/([0-9]+)$/);
    if (deleteProductMatch && request.method === 'DELETE') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      const productId = Number(deleteProductMatch[1]);
      const existing = await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(productId).first();
      if (!existing) return cors(json({ error: 'Product not found.' }, 404));
      const linked = await env.DB.prepare(
        'SELECT oi.id FROM order_items oi JOIN product_variants pv ON pv.id = oi.variant_id WHERE pv.product_id = ? LIMIT 1'
      )
        .bind(productId)
        .first();
      if (linked) {
        return cors(json({ error: 'This product is linked to existing COD orders. Archive it instead.' }, 409));
      }
      const { results: imageRows } = await env.DB.prepare(
        'SELECT iv.r2_key FROM image_variants iv JOIN image_assets ia ON ia.id = iv.image_asset_id WHERE ia.product_id = ?'
      )
        .bind(productId)
        .all<{ r2_key: string }>();
      await env.DB.batch([
        env.DB.prepare(
          'DELETE FROM stock_movements WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = ?)'
        ).bind(productId),
        env.DB.prepare('DELETE FROM products WHERE id = ?').bind(productId),
      ]);
      await Promise.all(imageRows.map((r) => env.PRODUCT_MEDIA.delete(r.r2_key).catch(() => undefined)));
      return cors(json({ deleted: true, id: productId }));
    }

    if (url.pathname === '/api/admin/products/variants' && request.method === 'POST') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return cors(json({ error: 'Invalid JSON' }, 400));
      }
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
        stock > 100000 ||
        (colorHex && !/^#[0-9a-fA-F]{6}$/.test(colorHex))
      ) {
        return cors(json({ error: 'Enter a valid size, colour and stock quantity.' }, 400));
      }
      const product = await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(productId).first();
      if (!product) return cors(json({ error: 'Product not found.' }, 404));
      const sku = String(
        body.sku || `FA-${productId}-${size}-${color}`.toUpperCase().replace(/[^A-Z0-9-]/g, '-')
      ).slice(0, 80);
      try {
        const statements = [
          env.DB.prepare(
            'INSERT INTO product_variants(product_id, sku, size, color, color_hex, stock) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(productId, sku, size, color, colorHex || null, stock),
        ];
        if (stock > 0) {
          statements.push(
            env.DB.prepare(
              "INSERT INTO stock_movements(variant_id, movement_type, quantity_delta, reason) SELECT id, 'adjustment', ?, 'Initial stock' FROM product_variants WHERE sku = ?"
            ).bind(stock, sku)
          );
        }
        const results = await env.DB.batch(statements);
        return cors(
          json(
            {
              id: results[0].meta.last_row_id,
              productId,
              sku,
              size,
              color,
              color_hex: colorHex || null,
              stock,
            },
            201
          )
        );
      } catch {
        return cors(json({ error: 'This size and colour combination or SKU already exists.' }, 409));
      }
    }

    if (url.pathname === '/api/admin/products/variants/stock' && request.method === 'PATCH') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return cors(json({ error: 'Invalid JSON' }, 400));
      }
      const variantId = Number(body.variantId);
      const delta = Number(body.delta);
      const reason = String(body.reason || 'Manual stock adjustment').trim().slice(0, 160);
      if (
        !Number.isInteger(variantId) ||
        variantId < 1 ||
        !Number.isInteger(delta) ||
        delta === 0 ||
        Math.abs(delta) > 100000
      ) {
        return cors(json({ error: 'Enter a valid stock adjustment.' }, 400));
      }
      try {
        const results = await env.DB.batch([
          env.DB.prepare(
            'UPDATE product_variants SET stock = stock + ? WHERE id = ? AND active = 1 AND stock + ? BETWEEN 0 AND 100000'
          ).bind(delta, variantId, delta),
          env.DB.prepare(
            "INSERT INTO stock_movements(variant_id, movement_type, quantity_delta, reason) SELECT ?, 'adjustment', ?, ? WHERE changes() = 1"
          ).bind(variantId, delta, reason),
          env.DB.prepare(
            "INSERT INTO audit_logs(action, entity_type, entity_id, details) SELECT 'stock_adjustment', 'variant', ?, ? WHERE changes() = 1"
          ).bind(String(variantId), JSON.stringify({ delta, reason })),
        ]);
        if (!results[0].meta.changes) {
          return cors(json({ error: 'Stock adjustment would be invalid or the variant is unavailable.' }, 409));
        }
        const updated: any = await env.DB.prepare('SELECT stock FROM product_variants WHERE id = ?')
          .bind(variantId)
          .first();
        return cors(
          json({
            variantId,
            delta,
            stock: Number(updated?.stock || 0),
            stockMovementRecorded: !!results[1].meta.changes,
          })
        );
      } catch {
        return cors(json({ error: 'Stock adjustment could not be saved.' }, 500));
      }
    }

    if (url.pathname === '/api/admin/images' && request.method === 'POST') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return cors(json({ error: 'Invalid image upload form.' }, 400));
      }
      const productId = Number(form.get('productId'));
      const altText = String(form.get('altText') || '').trim().slice(0, 240);
      const color = String(form.get('color') || '').trim().slice(0, 50);
      const colorHexRaw = String(form.get('colorHex') || '').trim();
      const colorHex = /^#[0-9a-fA-F]{6}$/.test(colorHexRaw) ? colorHexRaw : null;
      const sortOrder = Number.isInteger(Number(form.get('sortOrder'))) ? Number(form.get('sortOrder')) : 0;
      if (!Number.isInteger(productId) || productId < 1) {
        return cors(json({ error: 'Invalid product ID' }, 400));
      }
      const product = await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(productId).first();
      if (!product) return cors(json({ error: 'Product not found' }, 404));

      const files = [400, 800, 1200]
        .map((width) => ({ width, file: form.get(String(width)) }))
        .filter((x) => x.file instanceof File);
      if (files.length < 1 || files.length > 3) {
        return cors(json({ error: 'Provide 1 to 3 WebP variants (400, 800 or 1200).' }, 400));
      }
      for (const { file } of files) {
        const f = file as File;
        if (f.type !== 'image/webp' || f.size === 0 || f.size > 5 * 1024 * 1024) {
          return cors(json({ error: 'Variants must be non-empty WebP under 5 MB each.' }, 400));
        }
      }

      const asset = await env.DB.prepare(
        'INSERT INTO image_assets(product_id, alt_text, color, color_hex, sort_order) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(productId, altText, color, colorHex, sortOrder)
        .run();
      const imageId = asset.meta.last_row_id;
      const stored: string[] = [];
      try {
        for (const { width, file } of files) {
          const f = file as File;
          const key = `products/${productId}/images/${imageId}/${width}.webp`;
          await env.PRODUCT_MEDIA.put(key, f.stream(), {
            httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' },
          });
          stored.push(key);
          await env.DB.prepare(
            "INSERT INTO image_variants(image_asset_id, width, r2_key, content_type, byte_size) VALUES (?, ?, ?, 'image/webp', ?)"
          )
            .bind(imageId, width, key, f.size)
            .run();
        }
      } catch {
        await env.DB.prepare('DELETE FROM image_assets WHERE id = ?').bind(imageId).run();
        await Promise.all(stored.map((k) => env.PRODUCT_MEDIA.delete(k)));
        return cors(json({ error: 'Storage operation failed.' }, 500));
      }

      return cors(
        json(
          {
            id: imageId,
            productId,
            color,
            color_hex: colorHex,
            storage: 'r2',
            variants: files.map(({ width, file }) => {
              const key = `products/${productId}/images/${imageId}/${width}.webp`;
              return { width, url: mediaUrl(env, key), bytes: (file as File).size };
            }),
          },
          201
        )
      );
    }

    const imageMatch = url.pathname.match(/^\/api\/admin\/images\/([0-9]+)$/);
    if (imageMatch && request.method === 'PATCH') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      const imageId = Number(imageMatch[1]);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return cors(json({ error: 'Invalid JSON' }, 400));
      }
      const color = String(body.color || '').trim().slice(0, 50);
      const colorHexRaw = String(body.colorHex || '').trim();
      const colorHex = colorHexRaw ? (/^#[0-9a-fA-F]{6}$/.test(colorHexRaw) ? colorHexRaw : null) : null;
      if (colorHexRaw && !colorHex) return cors(json({ error: 'Invalid hex colour.' }, 400));
      const resUpd = await env.DB.prepare('UPDATE image_assets SET color = ?, color_hex = ? WHERE id = ?')
        .bind(color, colorHex, imageId)
        .run();
      if (!resUpd.meta.changes) return cors(json({ error: 'Image asset not found.' }, 404));
      return cors(json({ id: imageId, color, color_hex: colorHex }));
    }

    if (imageMatch && request.method === 'DELETE') {
      const auth = await adminAuth(request, env);
      if (!auth.ok) return cors(auth.response!);
      const imageId = Number(imageMatch[1]);
      const { results: variants } = await env.DB.prepare(
        'SELECT r2_key FROM image_variants WHERE image_asset_id = ?'
      )
        .bind(imageId)
        .all<{ r2_key: string }>();
      const del = await env.DB.prepare('DELETE FROM image_assets WHERE id = ?').bind(imageId).run();
      if (!del.meta.changes) return cors(json({ error: 'Image asset not found.' }, 404));
      await Promise.all(variants.map((v) => env.PRODUCT_MEDIA.delete(v.r2_key).catch(() => undefined)));
      return cors(json({ deleted: true, id: imageId }));
    }

    return cors(new Response('Not found', { status: 404 }));
  },
};