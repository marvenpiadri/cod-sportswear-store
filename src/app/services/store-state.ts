import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import {
  AdminAuthMode,
  AdminNotification,
  CartItem,
  CustomerDetails,
  InventoryAuditRow,
  OrderRecord,
  OrderStatus,
  Product,
  ProductCategory,
  ProductImage,
  ProductStatus,
  ProductVariant,
  SortOption,
  StockMovement,
  StoreLang,
} from '../models/store.models';
import { FREE_DELIVERY_THRESHOLD, OWNER_WHATSAPP, STORE_API_URL } from '../store-config';
import { D1ConnectionStatus, DbService, R2ConnectionStatus } from './db.service';
import { ImagePipelineProgress, ImageVariant, ProductImagePipeline } from './product-image-pipeline';

const STORAGE_KEYS = {
  cart: 'mokiko_sport_cart_v1',
  apiUrl: 'mokiko_sport_api_url_v1',
  whatsapp: 'mokiko_sport_whatsapp_v1',
  lang: 'mokiko_sport_lang_v1',
} as const;

const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery', 'returned'],
  out_for_delivery: ['delivered', 'returned'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};

@Injectable({ providedIn: 'root' })
export class StoreState {
  private platformId = inject(PLATFORM_ID);
  private db = inject(DbService);
  private imagePipeline = inject(ProductImagePipeline);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  readonly lang = signal<StoreLang>(this.readLang());
  readonly apiUrl = signal<string>(this.readString(STORAGE_KEYS.apiUrl, STORE_API_URL));
  readonly ownerWhatsApp = signal<string>(this.readString(STORAGE_KEYS.whatsapp, OWNER_WHATSAPP));
  readonly priceVisible = signal<boolean>(true);
  readonly catalogLoading = signal<boolean>(false);

  readonly allProducts = signal<Product[]>([]);
  readonly activeProducts = computed(() => {
    const visible = this.priceVisible();
    return this.allProducts()
      .filter((p) => p.status === 'active')
      .map((p) => ({
        ...p,
        price: visible ? p.price : null,
      }));
  });

  readonly orders = signal<OrderRecord[]>([]);
  readonly stockMovements = signal<StockMovement[]>([]);
  readonly notifications = signal<AdminNotification[]>([]);
  readonly unreadNotificationCount = computed(
    () => this.notifications().filter((n) => !n.is_read).length
  );
  readonly r2Status = signal<R2ConnectionStatus>({
    configured: false,
    bucket: 'mokiko',
    endpointOrigin: 'https://44d2687132765f2b95d4916a4687c0c0.r2.cloudflarestorage.com',
    publicBaseUrl: 'https://pub-22f1ea2ceedc494a88c49453ea8b15bd.r2.dev',
  });
  readonly d1Status = signal<D1ConnectionStatus>({
    mode: 'local-sqlite',
    configured: false,
    databaseName: 'mokiko',
    databaseId: '3f54f739-90d2-4f98-9a15-d4cb32c288b4',
    accountId: '44d2687132765f2b95d4916a4687c0c0',
  });

  // Storefront UI & filter state
  readonly activeCategory = signal<'All' | ProductCategory>('All');
  readonly sortOrder = signal<SortOption>('featured');
  readonly searchQuery = signal<string>('');
  readonly currentPage = signal<number>(1);
  readonly pageSize = 9;

  readonly filteredProducts = computed(() => {
    const category = this.activeCategory();
    const query = this.searchQuery().trim().toLowerCase();
    const sort = this.sortOrder();
    let list = this.activeProducts();

    if (category !== 'All') {
      list = list.filter((p) => p.category === category);
    }

    if (query) {
      list = list.filter((p) =>
        [p.name, p.category, p.tag || '', p.fabricNote || '', p.description || ''].some((val) =>
          val.toLowerCase().includes(query)
        )
      );
    }

    if (sort === 'price-asc') {
      list = [...list].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    } else if (sort === 'price-desc') {
      list = [...list].sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    }

    return list;
  });

  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.filteredProducts().length / this.pageSize))
  );
  readonly paginatedProducts = computed(() => {
    const page = Math.min(this.currentPage(), this.totalPages());
    const start = (page - 1) * this.pageSize;
    return this.filteredProducts().slice(start, start + this.pageSize);
  });

  // Cart & drawer state
  readonly cart = signal<CartItem[]>(this.readJson<CartItem[]>(STORAGE_KEYS.cart, []));
  readonly cartError = signal<string>('');
  readonly cartOpen = signal<boolean>(false);
  readonly checkoutOpen = signal<boolean>(false);
  readonly selectedProduct = signal<Product | null>(null);
  readonly preferredDetailColorHex = signal<string | null>(null);

  readonly cartCount = computed(() => this.cart().reduce((sum, item) => sum + item.quantity, 0));
  readonly subtotal = computed(() =>
    this.cart().reduce((sum, item) => sum + (item.product.price ?? 0) * item.quantity, 0)
  );
  readonly freeDeliveryThreshold = FREE_DELIVERY_THRESHOLD;
  readonly remainingForFreeDelivery = computed(() =>
    Math.max(0, this.freeDeliveryThreshold - this.subtotal())
  );
  readonly freeDeliveryProgress = computed(() =>
    Math.min(100, Math.round((this.subtotal() / this.freeDeliveryThreshold) * 100))
  );

  // Admin auth state (Bearer token held strictly in memory)
  private readonly adminToken = signal<string>('');
  readonly adminUnlocked = computed(() => Boolean(this.adminToken()));
  readonly authMode = signal<AdminAuthMode>('claimed');
  readonly authStatusLoaded = signal<boolean>(false);

  private readonly serverAuditRows = signal<InventoryAuditRow[] | null>(null);
  readonly inventoryAudit = computed<InventoryAuditRow[]>(() => {
    const serverRows = this.serverAuditRows();
    if (serverRows) return serverRows;
    const movements = this.stockMovements();
    const rows: InventoryAuditRow[] = [];
    for (const product of this.allProducts()) {
      for (const variant of product.variants) {
        const variantMovements = movements.filter((m) => m.variant_id === variant.id);
        const ledgerTotal = variantMovements.reduce((sum, m) => sum + m.quantity_delta, 0);
        rows.push({
          variant_id: variant.id,
          sku: variant.sku,
          size: variant.size,
          color: variant.color,
          stock: variant.stock,
          product_id: product.id,
          product_name: product.name,
          ledger_total: ledgerTotal,
          difference: variant.stock - ledgerTotal,
          movement_count: variantMovements.length,
        });
      }
    }
    return rows;
  });

  constructor() {
    if (this.isBrowser) {
      this.applyDocumentLang(this.lang());
      void this.syncStorefrontFromApi();
    }
  }

  private baseUrl(): string {
    return this.apiUrl().trim().replace(/\/$/, '');
  }

  private isRemoteWorker(): boolean {
    return Boolean(this.baseUrl());
  }

  setLang(lang: StoreLang): void {
    this.lang.set(lang);
    this.writeString(STORAGE_KEYS.lang, lang);
    this.applyDocumentLang(lang);
  }

  private applyDocumentLang(lang: StoreLang): void {
    if (!this.isBrowser) return;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }

  formatMAD(amount: number): string {
    const formatted = new Intl.NumberFormat('fr-MA', {
      maximumFractionDigits: 0,
    }).format(amount);
    return this.lang() === 'ar' ? `${formatted} د.م` : `${formatted} MAD`;
  }

  setCategory(category: 'All' | ProductCategory): void {
    this.activeCategory.set(category);
    this.currentPage.set(1);
  }

  setSort(sort: SortOption): void {
    this.sortOrder.set(sort);
    this.currentPage.set(1);
  }

  setSearch(query: string): void {
    this.searchQuery.set(query);
    this.currentPage.set(1);
  }

  changePage(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.currentPage.set(page);
  }

  openProduct(product: Product, preferredColorHex: string | null = null): void {
    const fresh = this.activeProducts().find((p) => p.id === product.id) ?? product;
    this.preferredDetailColorHex.set(preferredColorHex);
    this.selectedProduct.set(fresh);
  }

  closeProduct(): void {
    this.selectedProduct.set(null);
    this.preferredDetailColorHex.set(null);
  }

  getProductImageForVariant(product: Product, variant?: ProductVariant): string {
    if (variant && product.images?.length) {
      const hexMatch = variant.color_hex
        ? product.images.find(
            (img) => img.color_hex?.toLowerCase() === variant.color_hex?.toLowerCase()
          )
        : undefined;
      if (hexMatch) return hexMatch.url;
      const nameMatch = product.images.find(
        (img) => img.color.toLowerCase() === variant.color.toLowerCase()
      );
      if (nameMatch) return nameMatch.url;
    }
    return product.image;
  }

  addToCart(product: Product, variant?: ProductVariant): void {
    const isAr = this.lang() === 'ar';
    const existing = this.cart().find(
      (item) => item.product.id === product.id && (item.variant?.id ?? null) === (variant?.id ?? null)
    );
    const limit = variant ? Math.min(20, variant.stock) : 20;
    if (limit <= 0) {
      this.cartError.set(isAr ? 'هذا الخيار غير متوفر حالياً.' : 'Cette option est en rupture de stock.');
      return;
    }
    if ((existing?.quantity ?? 0) >= limit) {
      this.cartError.set(
        variant
          ? isAr
            ? 'وصلت إلى الحد الأقصى المتاح في المخزون لهذا المقاس.'
            : 'Quantité maximale disponible atteinte pour cette taille.'
          : isAr
            ? 'الحد الأقصى للقطعة الواحدة هو 20.'
            : 'La quantité maximale par article est de 20.'
      );
      this.cartOpen.set(true);
      return;
    }
    this.cartError.set('');
    this.cart.update((items) => {
      const found = items.find(
        (item) =>
          item.product.id === product.id && (item.variant?.id ?? null) === (variant?.id ?? null)
      );
      return found
        ? items.map((item) =>
            item.product.id === product.id && (item.variant?.id ?? null) === (variant?.id ?? null)
              ? { ...item, quantity: item.quantity + 1 }
              : item
          )
        : [...items, { product, variant, quantity: 1 }];
    });
    this.persistCart();
    this.cartOpen.set(true);
  }

  increaseCartQuantity(productId: number, variantId?: number): void {
    const isAr = this.lang() === 'ar';
    this.cartError.set('');
    this.cart.update((items) =>
      items.map((item) => {
        if (item.product.id !== productId || (item.variant?.id ?? null) !== (variantId ?? null)) {
          return item;
        }
        const limit = item.variant ? Math.min(20, item.variant.stock) : 20;
        if (item.quantity >= limit) {
          this.cartError.set(
            item.variant
              ? isAr
                ? 'وصلت إلى الحد الأقصى المتاح لهذا المقاس.'
                : 'Stock maximum atteint pour cette taille.'
              : isAr
                ? 'الحد الأقصى للقطعة الواحدة هو 20.'
                : 'Maximum 20 unités par article.'
          );
          return item;
        }
        return { ...item, quantity: item.quantity + 1 };
      })
    );
    this.persistCart();
  }

  decreaseCartQuantity(productId: number, variantId?: number): void {
    this.cartError.set('');
    this.cart.update((items) =>
      items.flatMap((item) => {
        if (item.product.id !== productId || (item.variant?.id ?? null) !== (variantId ?? null)) {
          return [item];
        }
        return item.quantity > 1 ? [{ ...item, quantity: item.quantity - 1 }] : [];
      })
    );
    this.persistCart();
  }

  removeCartItem(productId: number, variantId?: number): void {
    this.cartError.set('');
    this.cart.update((items) =>
      items.filter(
        (item) => item.product.id !== productId || (item.variant?.id ?? null) !== (variantId ?? null)
      )
    );
    this.persistCart();
  }

  clearCart(): void {
    this.cart.set([]);
    this.cartError.set('');
    this.persistCart();
  }

  buildInquiryUrl(product: Product, variant?: ProductVariant): string {
    const digits = this.ownerWhatsApp().replace(/\D/g, '');
    const opt = variant ? ` (${variant.size} · ${variant.color})` : '';
    const msg =
      this.lang() === 'ar'
        ? `مرحباً Mokiko Sport، أرغب في الاستفسار عن ${product.name}${opt}.`
        : `Bonjour Mokiko Sport, je souhaite me renseigner sur ${product.name}${opt}.`;
    return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
  }

  buildGeneralWhatsAppUrl(): string {
    const digits = this.ownerWhatsApp().replace(/\D/g, '');
    const msg =
      this.lang() === 'ar'
        ? 'مرحباً Mokiko Sport، لدي استفسار بخصوص المنتجات المتوفرة.'
        : 'Bonjour Mokiko Sport, j’ai une question concernant vos articles disponibles.';
    return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
  }

  buildCustomerOrderWhatsAppUrl(
    orderNumber: string,
    customer: CustomerDetails,
    items: CartItem[],
    subtotal: number
  ): string {
    const digits = this.ownerWhatsApp().replace(/\D/g, '');
    const itemLines = items
      .map(
        (i) =>
          i.product.name +
          (i.variant ? ` (${i.variant.size} · ${i.variant.color})` : '') +
          ` x${i.quantity}`
      )
      .join(', ');

    const lines =
      this.lang() === 'ar'
        ? [
            `مرحباً Mokiko Sport، لقد أكدت للتو الطلب رقم ${orderNumber} (الدفع عند الاستلام).`,
            `الاسم: ${customer.fullName}`,
            `الهاتف: ${customer.phone}`,
            `المدينة: ${customer.city}`,
            `العنوان: ${customer.address}`,
            `المنتجات: ${itemLines}`,
            `المجموع: ${this.formatMAD(subtotal)}`,
            'شكراً لتأكيد التوصيل.',
          ]
        : [
            `Bonjour Mokiko Sport, je viens de passer la commande COD ${orderNumber}.`,
            `Nom : ${customer.fullName}`,
            `Téléphone : ${customer.phone}`,
            `Ville : ${customer.city}`,
            `Adresse : ${customer.address}`,
            `Articles : ${itemLines}`,
            `Total : ${this.formatMAD(subtotal)}`,
            'Merci de confirmer mon créneau de livraison.',
          ];
    return `https://wa.me/${digits}?text=${encodeURIComponent(lines.join('\n'))}`;
  }

  buildAdminOrderWhatsAppUrl(order: OrderRecord): string {
    const digits = String(order.whatsapp_phone || order.phone || '').replace(/\D/g, '');
    const message =
      this.lang() === 'ar'
        ? `مرحباً ${order.full_name}، معكم فريق Mokiko Sport بخصوص طلبكم رقم ${order.order_number} (${order.total} د.م). يرجى تأكيد توقيت الاستلام المناسب لكم.`
        : `Bonjour ${order.full_name}, ici Mokiko Sport concernant votre commande ${order.order_number} (${order.total} MAD). Merci de confirmer votre disponibilité pour la livraison.`;
    return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  }

  async submitOrder(
    customer: CustomerDetails,
    idempotencyKey: string
  ): Promise<{ orderNumber: string; total: number }> {
    const items = this.cart();
    if (!items.length) {
      throw new Error(this.lang() === 'ar' ? 'سلة التسوق فارغة.' : 'Votre panier est vide.');
    }

    const data = await this.db.submitOrder(this.baseUrl(), {
      idempotencyKey,
      customer,
      items: items.map((item) => ({
        productId: item.product.id,
        variantId: item.variant?.id ?? null,
        quantity: item.quantity,
      })),
    });
    await this.syncStorefrontFromApi();
    return { orderNumber: data.orderNumber, total: Number(data.total ?? this.subtotal()) };
  }

  async loadAdminAuthStatus(): Promise<void> {
    if (!this.isBrowser) return;
    if (this.isRemoteWorker()) {
      this.authMode.set('remote');
      this.authStatusLoaded.set(true);
      return;
    }
    try {
      const data = await this.db.getAdminAuthStatus();
      if (data.mode === 'env' || data.mode === 'claimed' || data.mode === 'unclaimed') {
        this.authMode.set(data.mode);
      }
    } catch {
      // Keep default mode
    } finally {
      this.authStatusLoaded.set(true);
    }
  }

  async setupInitialAdminPin(pin: string): Promise<void> {
    const clean = pin.trim();
    if (!/^[0-9]{4,8}$/.test(clean)) {
      throw new Error(
        this.lang() === 'ar'
          ? 'اختر رمز PIN رقمياً بين 4 و 8 أرقام.'
          : 'Choisissez un code PIN numérique entre 4 et 8 chiffres.'
      );
    }
    const data = await this.db.setupInitialAdminPin(clean);
    this.adminToken.set(String(data.token || ''));
    this.authMode.set('claimed');
    await this.loadAllAdminData();
  }

  async verifyAndUnlockAdmin(enteredPin: string, customApiUrl?: string): Promise<void> {
    const trimmedPin = enteredPin.trim();
    if (!trimmedPin) {
      throw new Error(
        this.lang() === 'ar' ? 'أدخل رمز PIN الخاص بالإدارة.' : 'Saisissez votre code PIN.'
      );
    }

    if (customApiUrl !== undefined) {
      this.setApiUrl(customApiUrl);
    }

    const base = this.baseUrl();
    if (base) {
      const remoteProducts = await this.db.getAdminProducts(base, trimmedPin);
      this.adminToken.set(trimmedPin);
      this.authMode.set('remote');
      if (Array.isArray(remoteProducts)) {
        this.allProducts.set(this.mapRemoteProducts(remoteProducts, false));
      }
      await this.loadAllAdminData();
      return;
    }

    const data = await this.db.loginAdmin(trimmedPin);
    this.adminToken.set(String(data.token || ''));
    if (data.mode === 'env' || data.mode === 'claimed') {
      this.authMode.set(data.mode);
    }
    await this.loadAllAdminData();
  }

  lockAdmin(): void {
    const token = this.adminToken();
    const isRemote = this.isRemoteWorker();
    this.adminToken.set('');
    this.orders.set([]);
    this.notifications.set([]);
    this.stockMovements.set([]);
    this.serverAuditRows.set(null);
    if (token && !isRemote && this.isBrowser) {
      void this.db.logoutAdmin(token);
    }
  }

  setApiUrl(url: string): void {
    const clean = url.trim().replace(/\/$/, '');
    this.apiUrl.set(clean);
    this.writeString(STORAGE_KEYS.apiUrl, clean);
    if (this.isBrowser) {
      void this.syncStorefrontFromApi();
      void this.loadAdminAuthStatus();
    }
  }

  setOwnerWhatsApp(whatsapp: string): void {
    const clean = whatsapp.trim();
    this.ownerWhatsApp.set(clean);
    this.writeString(STORAGE_KEYS.whatsapp, clean);
  }

  // CRM Product & Multi-Colour Image CRUD
  async createProduct(input: {
    name: string;
    slug?: string;
    category: ProductCategory;
    tag?: string;
    fabricNote?: string;
    fitNote?: string;
    description: string;
    price: number;
    status: ProductStatus;
    initialVariant?: { size: string; color: string; colorHex?: string; stock: number };
    imageUploads?: Array<{ variants: ImageVariant[]; color: string; colorHex: string }>;
    onImageProgress?: (progress: ImagePipelineProgress, index: number, total: number) => void;
  }): Promise<Product> {
    const name = input.name.trim();
    if (!name) {
      throw new Error(
        this.lang() === 'ar' ? 'اسم المنتج مطلوب.' : 'Le nom du produit est requis.'
      );
    }
    const price = Number(input.price);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(
        this.lang() === 'ar' ? 'أدخل سعراً صحيحاً بالدرهم.' : 'Saisissez un prix valide en MAD.'
      );
    }

    const slug = (
      input.slug?.trim() ||
      name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    ).slice(0, 160);

    const base = this.baseUrl();
    const token = this.adminToken();
    const created = await this.db.createProduct(base, token, {
      name,
      slug,
      category: input.category,
      tag: input.tag?.trim() || '',
      fabricNote: input.fabricNote?.trim() || '',
      fitNote: input.fitNote?.trim() || '',
      description: input.description.trim(),
      price: Math.round(price),
      status: input.status === 'active' ? 'active' : 'draft',
    });

    if (input.initialVariant && input.initialVariant.size.trim() && input.initialVariant.color.trim()) {
      await this.createVariant(created.id, input.initialVariant, false);
    }

    if (input.imageUploads?.length) {
      const total = input.imageUploads.length;
      for (let idx = 0; idx < total; idx++) {
        const entry = input.imageUploads[idx];
        await this.imagePipeline.upload(
          created.id,
          entry.color ? `${name} · ${entry.color}` : name,
          entry.variants,
          base,
          token,
          entry.color,
          entry.colorHex,
          idx,
          (progress) => input.onImageProgress?.(progress, idx, total)
        );
      }
    }

    await Promise.all([
      this.refreshAdminCatalog(),
      this.refreshInventoryAudit(),
      this.refreshStockMovements(),
    ]);
    return this.allProducts().find((p) => p.id === created.id) ?? created;
  }

  async updateProduct(
    id: number,
    updates: {
      name: string;
      category: ProductCategory;
      tag?: string;
      fabricNote?: string;
      fitNote?: string;
      description: string;
      price: number;
      status: ProductStatus;
    }
  ): Promise<void> {
    await this.db.updateProduct(this.baseUrl(), this.adminToken(), {
      id,
      name: updates.name.trim(),
      category: updates.category,
      tag: updates.tag?.trim() || '',
      fabricNote: updates.fabricNote?.trim() || '',
      fitNote: updates.fitNote?.trim() || '',
      description: updates.description.trim(),
      price: Math.round(Number(updates.price)),
      status: updates.status,
    });
    await this.refreshAdminCatalog();
  }

  async deleteProduct(id: number): Promise<void> {
    await this.db.deleteProduct(this.baseUrl(), this.adminToken(), id);
    await Promise.all([
      this.refreshAdminCatalog(),
      this.refreshInventoryAudit(),
      this.refreshStockMovements(),
    ]);
  }

  async createVariant(
    productId: number,
    draft: { size: string; color: string; colorHex?: string; stock: number },
    refreshAfter = true
  ): Promise<void> {
    const size = draft.size.trim();
    const color = draft.color.trim();
    const colorHex = draft.colorHex?.trim() || '#2F3234';
    const stock = Math.max(0, Math.round(Number(draft.stock) || 0));
    if (!size || !color) {
      throw new Error(
        this.lang() === 'ar' ? 'المقاس واللون مطلوبان.' : 'La taille et la couleur sont requises.'
      );
    }

    await this.db.createVariant(this.baseUrl(), this.adminToken(), {
      productId,
      size,
      color,
      colorHex,
      stock,
    });
    if (refreshAfter) {
      await Promise.all([
        this.refreshAdminCatalog(),
        this.refreshInventoryAudit(),
        this.refreshStockMovements(),
      ]);
    }
  }

  async adjustVariantStock(
    variantId: number,
    delta: number,
    reason = 'Ajustement manuel CRM'
  ): Promise<void> {
    await this.db.adjustVariantStock(this.baseUrl(), this.adminToken(), variantId, delta, reason);
    await Promise.all([
      this.refreshAdminCatalog(),
      this.refreshInventoryAudit(),
      this.refreshStockMovements(),
    ]);
  }

  async uploadProductImage(
    productId: number,
    altText: string,
    variants: ImageVariant[],
    color = '',
    colorHex = '',
    sortOrder = 0,
    onProgress?: (progress: ImagePipelineProgress) => void
  ): Promise<void> {
    await this.imagePipeline.upload(
      productId,
      color ? `${altText} · ${color}` : altText,
      variants,
      this.baseUrl(),
      this.adminToken(),
      color,
      colorHex,
      sortOrder,
      onProgress
    );
    await this.refreshAdminCatalog();
  }

  async updateProductImageColor(imageId: number, color: string, colorHex: string): Promise<void> {
    await this.db.updateProductImageColor(this.baseUrl(), this.adminToken(), imageId, color, colorHex);
    await this.refreshAdminCatalog();
  }

  async deleteProductImage(imageId: number): Promise<void> {
    await this.db.deleteProductImage(this.baseUrl(), this.adminToken(), imageId);
    await this.refreshAdminCatalog();
  }

  async setPriceVisibility(visible: boolean): Promise<void> {
    await this.db.updateStoreSettings(this.baseUrl(), this.adminToken(), visible);
    this.priceVisible.set(visible);
  }

  async updateOrderStatus(orderId: number, nextStatus: OrderStatus): Promise<void> {
    await this.db.updateOrderStatus(this.baseUrl(), this.adminToken(), orderId, nextStatus);
    await Promise.all([
      this.refreshAdminOrders(),
      this.refreshAdminCatalog(),
      this.refreshInventoryAudit(),
      this.refreshStockMovements(),
    ]);
  }

  async markNotificationRead(id: number): Promise<void> {
    await this.db.markNotificationRead(this.baseUrl(), this.adminToken(), id);
    this.notifications.update((rows) => rows.map((n) => (n.id === id ? { ...n, is_read: 1 } : n)));
  }

  async markAllNotificationsRead(): Promise<void> {
    const unread = this.notifications().filter((n) => !n.is_read);
    for (const n of unread) {
      await this.markNotificationRead(n.id);
    }
  }

  async syncStorefrontFromApi(): Promise<void> {
    if (!this.isBrowser) return;
    const base = this.baseUrl();
    this.catalogLoading.set(true);
    try {
      const [settings, rows] = await Promise.all([
        this.db.getStoreSettings(base).catch(() => ({ priceVisible: true })),
        this.db.getPublicProducts(base),
      ]);
      this.priceVisible.set(settings.priceVisible !== false);
      if (Array.isArray(rows)) {
        this.allProducts.set(this.mapRemoteProducts(rows, true));
      }
    } catch {
      // Keep current catalog if temporarily unreachable
    } finally {
      this.catalogLoading.set(false);
    }
  }

  async loadAllAdminData(): Promise<void> {
    if (!this.adminToken()) return;
    await Promise.all([
      this.refreshAdminCatalog().catch(() => undefined),
      this.refreshAdminOrders().catch(() => undefined),
      this.refreshAdminNotifications().catch(() => undefined),
      this.refreshInventoryAudit().catch(() => undefined),
      this.refreshStockMovements().catch(() => undefined),
      this.refreshR2Status().catch(() => undefined),
      this.refreshD1Status().catch(() => undefined),
    ]);
  }

  async refreshD1Status(): Promise<void> {
    const status = await this.db.getD1Status(this.baseUrl(), this.adminToken());
    if (status && status.databaseId) {
      this.d1Status.set(status);
    }
  }

  async refreshR2Status(): Promise<void> {
    const status = await this.db.getR2Status(this.baseUrl(), this.adminToken());
    if (status && status.bucket) {
      this.r2Status.set(status);
    }
  }

  async refreshAdminCatalog(): Promise<void> {
    const rows = await this.db.getAdminProducts(this.baseUrl(), this.adminToken());
    if (Array.isArray(rows)) {
      this.allProducts.set(this.mapRemoteProducts(rows, false));
    }
  }

  async refreshAdminOrders(search = ''): Promise<void> {
    const rows = await this.db.getOrders(this.baseUrl(), this.adminToken(), search);
    if (Array.isArray(rows)) {
      this.orders.set(rows);
    }
  }

  async refreshAdminNotifications(): Promise<void> {
    const rows = await this.db.getNotifications(this.baseUrl(), this.adminToken());
    if (Array.isArray(rows)) {
      this.notifications.set(rows);
    }
  }

  async refreshInventoryAudit(): Promise<void> {
    try {
      const rows = await this.db.getInventoryAudit(this.baseUrl(), this.adminToken());
      if (Array.isArray(rows)) {
        this.serverAuditRows.set(rows);
      }
    } catch {
      this.serverAuditRows.set(null);
    }
  }

  async refreshStockMovements(search = ''): Promise<void> {
    const rows = await this.db.getStockMovements(this.baseUrl(), this.adminToken(), search);
    if (Array.isArray(rows)) {
      this.stockMovements.set(rows);
    }
  }

  exportCatalogJson(): string {
    return JSON.stringify(this.allProducts(), null, 2);
  }

  allowedOrderTransitions(status: OrderStatus): OrderStatus[] {
    return [status, ...(ORDER_TRANSITIONS[status] || [])];
  }

  private mapRemoteProducts(rows: any[], activeOnly: boolean): Product[] {
    return rows.map((p: any) => {
      const images = this.normalizeProductImages(p);
      const primaryImage =
        images[0]?.url || '/assets/images/product_training_tee_1795239482148.jpg';

      const variants: ProductVariant[] = (p.variants || []).map((v: any) => ({
        id: Number(v.id),
        sku: String(v.sku),
        size: String(v.size),
        color: String(v.color),
        color_hex: v.color_hex || '#2F3234',
        stock: Number(v.stock),
      }));

      const colorHexes: string[] = [];
      for (const img of images) {
        if (img.color_hex && !colorHexes.some((c) => c.toLowerCase() === img.color_hex!.toLowerCase())) {
          colorHexes.push(img.color_hex);
        }
      }
      for (const v of variants) {
        if (v.color_hex && !colorHexes.some((c) => c.toLowerCase() === v.color_hex!.toLowerCase())) {
          colorHexes.push(v.color_hex);
        }
      }

      return {
        id: Number(p.id),
        slug: String(p.slug || ''),
        name: String(p.name),
        category: this.inferCategory(p.name, p.category),
        price: p.price === null || p.price === undefined ? null : Number(p.price),
        status: activeOnly ? 'active' : ((p.status as ProductStatus) || 'draft'),
        image: primaryImage,
        images,
        tag: p.tag || (p.status === 'active' ? 'Essentiel' : 'Brouillon'),
        fabricNote: p.fabricNote || p.fabric_note || '',
        fitNote: p.fitNote || p.fit_note || '',
        description: p.description || '',
        colors: colorHexes.length ? colorHexes : ['#2F3234'],
        variants,
      };
    });
  }

  private normalizeProductImages(p: any): ProductImage[] {
    const raw = Array.isArray(p.images) ? p.images : [];
    if (!raw.length) return [];

    if (raw.some((item: any) => item.id !== undefined || item.variants !== undefined)) {
      return raw.map((img: any, idx: number) => ({
        id: Number(img.id || idx + 1),
        url: String(
          img.url ||
            img.variants?.find((v: any) => v.width === 800)?.url ||
            img.variants?.[0]?.url ||
            '/assets/images/product_training_tee_1795239482148.jpg'
        ),
        alt_text: String(img.alt_text || p.name || ''),
        color: String(img.color || ''),
        color_hex: img.color_hex ? String(img.color_hex) : null,
        sort_order: img.sort_order ?? idx,
      }));
    }

    const grouped = new Map<string, ProductImage>();
    for (const row of raw) {
      const key = `${row.color || ''}|${row.color_hex || ''}|${row.alt_text || ''}`;
      const existing = grouped.get(key);
      if (!existing || Number(row.width) === 800) {
        grouped.set(key, {
          id: Number(row.image_asset_id || row.id || grouped.size + 1),
          url: String(row.url),
          alt_text: String(row.alt_text || p.name || ''),
          color: String(row.color || ''),
          color_hex: row.color_hex ? String(row.color_hex) : null,
        });
      }
    }
    return Array.from(grouped.values());
  }

  private inferCategory(name: string, category?: string): ProductCategory {
    if (category === 'Tops' || category === 'Layers' || category === 'Bottoms') return category;
    const lower = name.toLowerCase();
    if (lower.includes('hoodie') || lower.includes('jacket') || lower.includes('veste')) return 'Layers';
    if (lower.includes('jogger') || lower.includes('short') || lower.includes('pantalon')) return 'Bottoms';
    return 'Tops';
  }

  private persistCart(): void {
    this.writeJson(STORAGE_KEYS.cart, this.cart());
  }

  private readLang(): StoreLang {
    const saved = this.readString(STORAGE_KEYS.lang, 'fr');
    return saved === 'ar' ? 'ar' : 'fr';
  }

  private readJson<T>(key: string, fallback: T): T {
    if (!this.isBrowser) return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private writeJson(key: string, value: unknown): void {
    if (!this.isBrowser) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  private readString(key: string, fallback: string): string {
    if (!this.isBrowser) return fallback;
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  private writeString(key: string, value: string): void {
    if (!this.isBrowser) return;
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  }
}
