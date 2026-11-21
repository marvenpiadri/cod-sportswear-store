import { Injectable } from '@angular/core';
import {
  AdminAuthMode,
  AdminNotification,
  CustomerDetails,
  InventoryAuditRow,
  OrderRecord,
  OrderStatus,
  ProductCategory,
  ProductStatus,
  StockMovement,
} from '../models/store.models';

export type DatabaseMode = 'cloudflare-d1' | 'local-sqlite';

export interface D1ConnectionStatus {
  mode: DatabaseMode;
  configured: boolean;
  databaseName: string;
  databaseId: string;
  accountId: string;
}

export interface R2ConnectionStatus {
  configured: boolean;
  bucket: string;
  endpointOrigin: string;
  publicBaseUrl: string;
}

export interface DatabaseHealthStatus {
  ok: boolean;
  database: string;
  databaseName?: string;
  databaseId?: string;
  service: string;
}

export interface CreateProductInput {
  name: string;
  slug: string;
  category: ProductCategory;
  tag: string;
  fabricNote: string;
  fitNote: string;
  description: string;
  price: number;
  status: ProductStatus;
}

export interface UpdateProductInput extends Omit<CreateProductInput, 'slug'> {
  id: number;
}

export interface CreateVariantInput {
  productId: number;
  size: string;
  color: string;
  colorHex: string;
  stock: number;
}

export interface SubmitOrderInput {
  idempotencyKey: string;
  customer: CustomerDetails;
  items: Array<{ productId: number; variantId: number | null; quantity: number }>;
}

/**
 * Angular data-access service interfacing with the Cloudflare D1 SQLite database
 * via src/server.ts (D1 REST API) or a deployed Cloudflare Worker D1 binding.
 */
@Injectable({ providedIn: 'root' })
export class DbService {
  private cleanBase(apiUrl = ''): string {
    return apiUrl.trim().replace(/\/$/, '');
  }

  private authHeaders(token: string, json = false): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (json) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  private async readJsonOrThrow<T>(response: Response, fallbackError: string): Promise<T> {
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      throw new Error(parsed?.error || text || fallbackError);
    }
    return parsed as T;
  }

  // ---------- Cloudflare D1 & R2 Connection Health ----------

  async getHealth(apiUrl = ''): Promise<DatabaseHealthStatus> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/health`);
    return this.readJsonOrThrow(res, 'Cloudflare D1 health check failed.');
  }

  async getD1Status(apiUrl: string, token: string): Promise<D1ConnectionStatus> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/d1-status`, {
      headers: this.authHeaders(token),
    });
    return this.readJsonOrThrow(res, 'Could not load Cloudflare D1 connection status.');
  }

  async getR2Status(apiUrl: string, token: string): Promise<R2ConnectionStatus> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/r2-status`, {
      headers: this.authHeaders(token),
    });
    return this.readJsonOrThrow(res, 'Could not load Cloudflare R2 storage status.');
  }

  async getStoreSettings(apiUrl = ''): Promise<{ priceVisible: boolean }> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/store-settings`);
    return this.readJsonOrThrow(res, 'Could not load store settings.');
  }

  async updateStoreSettings(
    apiUrl: string,
    token: string,
    priceVisible: boolean
  ): Promise<{ priceVisible: boolean }> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/store-settings`, {
      method: 'PATCH',
      headers: this.authHeaders(token, true),
      body: JSON.stringify({ priceVisible }),
    });
    return this.readJsonOrThrow(res, 'Could not update store settings.');
  }

  // ---------- Admin Authentication ----------

  async getAdminAuthStatus(apiUrl = ''): Promise<{ configured: boolean; mode: AdminAuthMode }> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/auth-status`);
    return this.readJsonOrThrow(res, 'Could not load admin auth status.');
  }

  async setupInitialAdminPin(
    pin: string,
    apiUrl = ''
  ): Promise<{ token: string; mode: AdminAuthMode }> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/setup-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    return this.readJsonOrThrow(res, 'Could not configure initial admin PIN.');
  }

  async loginAdmin(pin: string, apiUrl = ''): Promise<{ token: string; mode: AdminAuthMode }> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    return this.readJsonOrThrow(res, 'Incorrect access PIN.');
  }

  async logoutAdmin(token: string, apiUrl = ''): Promise<void> {
    await fetch(`${this.cleanBase(apiUrl)}/api/admin/logout`, {
      method: 'POST',
      headers: this.authHeaders(token),
    }).catch(() => undefined);
  }

  // ---------- Products CRUD ----------

  async getPublicProducts(apiUrl = ''): Promise<any[]> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/products`);
    return this.readJsonOrThrow(res, 'Could not load public catalog from Cloudflare D1.');
  }

  async getAdminProducts(apiUrl: string, token: string): Promise<any[]> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/products`, {
      headers: this.authHeaders(token),
    });
    return this.readJsonOrThrow(res, 'Could not load admin catalog from Cloudflare D1.');
  }

  async createProduct(apiUrl: string, token: string, payload: CreateProductInput): Promise<any> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/products`, {
      method: 'POST',
      headers: this.authHeaders(token, true),
      body: JSON.stringify(payload),
    });
    return this.readJsonOrThrow(res, 'Could not create product.');
  }

  async updateProduct(apiUrl: string, token: string, payload: UpdateProductInput): Promise<any> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/products`, {
      method: 'PATCH',
      headers: this.authHeaders(token, true),
      body: JSON.stringify(payload),
    });
    return this.readJsonOrThrow(res, 'Could not update product.');
  }

  async deleteProduct(
    apiUrl: string,
    token: string,
    productId: number
  ): Promise<{ deleted: boolean; id: number }> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/products/${productId}`, {
      method: 'DELETE',
      headers: this.authHeaders(token),
    });
    return this.readJsonOrThrow(res, 'Could not delete product.');
  }

  // ---------- Colour-Tagged Product Images CRUD ----------

  async updateProductImageColor(
    apiUrl: string,
    token: string,
    imageId: number,
    color: string,
    colorHex: string
  ): Promise<{ id: number; color: string; color_hex: string | null }> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/images/${imageId}`, {
      method: 'PATCH',
      headers: this.authHeaders(token, true),
      body: JSON.stringify({ color: color.trim(), colorHex: colorHex.trim() }),
    });
    return this.readJsonOrThrow(res, 'Could not update image colour.');
  }

  async deleteProductImage(
    apiUrl: string,
    token: string,
    imageId: number
  ): Promise<{ deleted: boolean; id: number }> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/images/${imageId}`, {
      method: 'DELETE',
      headers: this.authHeaders(token),
    });
    return this.readJsonOrThrow(res, 'Could not delete image.');
  }

  // ---------- Inventory & Variants CRUD ----------

  async createVariant(apiUrl: string, token: string, payload: CreateVariantInput): Promise<any> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/products/variants`, {
      method: 'POST',
      headers: this.authHeaders(token, true),
      body: JSON.stringify(payload),
    });
    return this.readJsonOrThrow(res, 'Could not create variant.');
  }

  async adjustVariantStock(
    apiUrl: string,
    token: string,
    variantId: number,
    delta: number,
    reason: string
  ): Promise<{ variantId: number; delta: number; stock: number }> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/products/variants/stock`, {
      method: 'PATCH',
      headers: this.authHeaders(token, true),
      body: JSON.stringify({ variantId, delta, reason }),
    });
    return this.readJsonOrThrow(res, 'Could not adjust variant stock.');
  }

  async getInventoryAudit(apiUrl: string, token: string): Promise<InventoryAuditRow[]> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/inventory-audit`, {
      headers: this.authHeaders(token),
    });
    return this.readJsonOrThrow(res, 'Could not load inventory audit.');
  }

  async getStockMovements(
    apiUrl: string,
    token: string,
    search = '',
    variantId = 0
  ): Promise<StockMovement[]> {
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    if (variantId > 0) params.set('variantId', String(variantId));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/stock-movements${qs}`, {
      headers: this.authHeaders(token),
    });
    return this.readJsonOrThrow(res, 'Could not load stock movements.');
  }

  // ---------- Orders & Notifications CRUD ----------

  async submitOrder(
    apiUrl: string,
    payload: SubmitOrderInput
  ): Promise<{ orderId: number; orderNumber: string; total: number; status: OrderStatus }> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return this.readJsonOrThrow(res, 'Order submission failed.');
  }

  async getOrders(apiUrl: string, token: string, search = ''): Promise<OrderRecord[]> {
    const qs = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : '';
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/orders${qs}`, {
      headers: this.authHeaders(token),
    });
    return this.readJsonOrThrow(res, 'Could not load orders from Cloudflare D1.');
  }

  async updateOrderStatus(
    apiUrl: string,
    token: string,
    orderId: number,
    status: OrderStatus
  ): Promise<{ id: number; status: OrderStatus; stockRestored?: boolean }> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/orders`, {
      method: 'PATCH',
      headers: this.authHeaders(token, true),
      body: JSON.stringify({ id: orderId, status }),
    });
    return this.readJsonOrThrow(res, 'Could not update order status.');
  }

  async getNotifications(apiUrl: string, token: string): Promise<AdminNotification[]> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/notifications`, {
      headers: this.authHeaders(token),
    });
    return this.readJsonOrThrow(res, 'Could not load notifications.');
  }

  async markNotificationRead(
    apiUrl: string,
    token: string,
    id: number
  ): Promise<{ id: number; is_read: number }> {
    const res = await fetch(`${this.cleanBase(apiUrl)}/api/admin/notifications`, {
      method: 'PATCH',
      headers: this.authHeaders(token, true),
      body: JSON.stringify({ id }),
    });
    return this.readJsonOrThrow(res, 'Could not update notification.');
  }
}
