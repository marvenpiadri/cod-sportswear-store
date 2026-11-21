export type ProductCategory = 'Tops' | 'Layers' | 'Bottoms';
export type ProductStatus = 'active' | 'draft' | 'archived';
export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'shipped'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'returned';

export type SortOption = 'featured' | 'price-asc' | 'price-desc';
export type AdminAuthMode = 'env' | 'claimed' | 'unclaimed' | 'remote';
export type StoreLang = 'fr' | 'ar';

export interface ProductImage {
  id: number;
  url: string;
  alt_text: string;
  color: string;
  color_hex: string | null;
  sort_order?: number;
}

export interface ProductVariant {
  id: number;
  sku: string;
  size: string;
  color: string;
  color_hex?: string | null;
  stock: number;
}

export interface Product {
  id: number;
  slug: string;
  name: string;
  category: ProductCategory;
  price: number | null;
  status: ProductStatus;
  image: string;
  images: ProductImage[];
  tag?: string;
  fabricNote?: string;
  fitNote?: string;
  description?: string;
  colors: string[];
  variants: ProductVariant[];
}

export interface CartItem {
  product: Product;
  variant?: ProductVariant;
  quantity: number;
}

export interface CustomerDetails {
  fullName: string;
  phone: string;
  whatsapp: string;
  city: string;
  address: string;
  note: string;
}

export interface OrderItemRecord {
  productId: number;
  variantId: number | null;
  productName: string;
  sku: string;
  size: string;
  color: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface OrderRecord {
  id: number;
  order_number: string;
  total: number;
  status: OrderStatus;
  created_at: string;
  full_name: string;
  phone: string;
  whatsapp_phone: string;
  city: string;
  address: string;
  delivery_note?: string;
  items?: OrderItemRecord[];
}

export interface StockMovement {
  id: number;
  variant_id: number;
  order_id?: number | null;
  order_number?: string | null;
  movement_type: 'sale' | 'adjustment' | 'cancel_restore';
  quantity_delta: number;
  reason: string;
  created_at: string;
  sku: string;
  size: string;
  color: string;
  product_name: string;
}

export interface InventoryAuditRow {
  variant_id: number;
  sku: string;
  size: string;
  color: string;
  stock: number;
  product_id: number;
  product_name: string;
  ledger_total: number;
  difference: number;
  movement_count: number;
}

export interface AdminNotification {
  id: number;
  order_id?: number | null;
  type?: string;
  title: string;
  message: string;
  is_read: number;
  created_at: string;
}
