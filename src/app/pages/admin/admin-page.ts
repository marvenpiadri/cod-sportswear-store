import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  OrderRecord,
  OrderStatus,
  Product,
  ProductCategory,
  ProductImage,
  ProductStatus,
} from '../../models/store.models';
import {
  ImagePipelineStage,
  ImageVariant,
  ProductImagePipeline,
} from '../../services/product-image-pipeline';
import { StoreState } from '../../services/store-state';

type CrmTab = 'catalog' | 'add' | 'orders' | 'inventory' | 'settings';

export interface ColorPreset {
  hex: string;
  fr: string;
  ar: string;
}

export const COLOR_PRESETS: ReadonlyArray<ColorPreset> = [
  { hex: '#2F3234', fr: 'Anthracite', ar: 'رمادي داكن' },
  { hex: '#1C1C1B', fr: 'Noir Mat', ar: 'أسود مطفي' },
  { hex: '#C4B399', fr: 'Beige Sable', ar: 'بيج رملي' },
  { hex: '#5D6B63', fr: 'Vert Sauge', ar: 'أخضر فاتح' },
  { hex: '#3E423B', fr: 'Vert Olive', ar: 'أخضر زيتوني' },
  { hex: '#7A7972', fr: 'Gris Ardoise', ar: 'رمادي صخري' },
  { hex: '#8C887F', fr: 'Pierre Mat', ar: 'حجري مطفي' },
  { hex: '#1D2D44', fr: 'Bleu Nuit', ar: 'أزرق ليلي' },
  { hex: '#6B2737', fr: 'Bordeaux', ar: 'عنابي' },
  { hex: '#EAE6DF', fr: 'Blanc Cassé', ar: 'أبيض عاجي' },
];

export interface StagedProductImage {
  id: number;
  variants: ImageVariant[];
  previewUrl: string;
  color: string;
  colorHex: string;
  summary: string;
  compressionNote: string;
}

@Component({
  selector: 'store-admin-page',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './admin-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminPage implements OnInit {
  readonly store = inject(StoreState);
  private imagePipeline = inject(ProductImagePipeline);

  readonly isAr = computed(() => this.store.lang() === 'ar');
  readonly colorPresets = COLOR_PRESETS;

  // PIN Login / Setup state
  readonly showPin = signal<boolean>(false);
  readonly showApiConfig = signal<boolean>(false);
  readonly authBusy = signal<boolean>(false);
  readonly authError = signal<string>('');

  readonly setupForm = new FormGroup({
    pin: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^[0-9]{4,8}$/)],
    }),
    confirmPin: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^[0-9]{4,8}$/)],
    }),
  });

  readonly loginForm = new FormGroup({
    pin: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(4)],
    }),
    apiUrl: new FormControl(this.store.apiUrl(), { nonNullable: true }),
  });

  // CRM Navigation & feedback
  readonly activeTab = signal<CrmTab>('catalog');
  readonly crmBusy = signal<boolean>(false);
  readonly compressingImages = signal<boolean>(false);
  readonly crmFeedback = signal<string>('');
  readonly crmError = signal<string>('');

  readonly rowProgress = signal<{
    productId: number;
    percent: number;
    label: string;
    phase: 'compress' | 'upload';
  } | null>(null);
  readonly addProgress = signal<{
    percent: number;
    label: string;
    phase: 'compress' | 'upload';
  } | null>(null);

  // KPI metrics
  readonly activeProductCount = computed(
    () => this.store.allProducts().filter((p) => p.status === 'active').length
  );
  readonly totalStockUnits = computed(() =>
    this.store
      .allProducts()
      .reduce((sum, p) => sum + p.variants.reduce((vSum, v) => vSum + v.stock, 0), 0)
  );

  // Catalog filter & inline edit
  readonly catalogSearchControl = new FormControl('', { nonNullable: true });
  readonly catalogSearch = signal<string>('');
  readonly catalogStatusFilter = signal<'all' | ProductStatus>('all');
  readonly editingProductId = signal<number | null>(null);
  readonly confirmDeleteProductId = signal<number | null>(null);
  readonly addingVariantForProductId = signal<number | null>(null);
  readonly uploadingImageProductId = signal<number | null>(null);
  readonly pendingRowVariants = signal<ImageVariant[]>([]);
  readonly pendingRowVariantSummary = signal<string>('');
  readonly pendingRowCompressionNote = signal<string>('');
  readonly pendingRowPreviewUrl = signal<string>('');
  readonly editingImageId = signal<number | null>(null);

  readonly filteredCatalog = computed(() => {
    const q = this.catalogSearch().trim().toLowerCase();
    const status = this.catalogStatusFilter();
    return this.store.allProducts().filter((p) => {
      if (status !== 'all' && p.status !== status) return false;
      if (!q) return true;
      return [p.name, p.category, p.slug, p.tag || ''].some((s) => s.toLowerCase().includes(q));
    });
  });

  readonly editProductForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    category: new FormControl<ProductCategory>('Tops', { nonNullable: true }),
    tag: new FormControl('', { nonNullable: true }),
    price: new FormControl<number>(0, { nonNullable: true, validators: [Validators.min(0)] }),
    fabricNote: new FormControl('', { nonNullable: true }),
    fitNote: new FormControl('', { nonNullable: true }),
    description: new FormControl('', { nonNullable: true }),
    status: new FormControl<ProductStatus>('draft', { nonNullable: true }),
  });

  readonly addVariantForm = new FormGroup({
    size: new FormControl('M', { nonNullable: true, validators: [Validators.required] }),
    color: new FormControl('Anthracite', { nonNullable: true, validators: [Validators.required] }),
    colorHex: new FormControl('#2F3234', {
      nonNullable: true,
      validators: [Validators.pattern(/^(#[0-9a-fA-F]{6})?$/)],
    }),
    stock: new FormControl<number>(10, { nonNullable: true, validators: [Validators.min(0)] }),
  });

  readonly rowUploadForm = new FormGroup({
    color: new FormControl('Anthracite', { nonNullable: true }),
    colorHex: new FormControl('#2F3234', {
      nonNullable: true,
      validators: [Validators.pattern(/^(#[0-9a-fA-F]{6})?$/)],
    }),
  });

  readonly editImageColorForm = new FormGroup({
    color: new FormControl('', { nonNullable: true }),
    colorHex: new FormControl('#2F3234', {
      nonNullable: true,
      validators: [Validators.pattern(/^(#[0-9a-fA-F]{6})?$/)],
    }),
  });

  // Dedicated Add Product multi-image staging queue
  private nextStagedId = 1;
  readonly stagedProductImages = signal<StagedProductImage[]>([]);

  readonly createProductForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    slug: new FormControl('', { nonNullable: true }),
    category: new FormControl<ProductCategory>('Tops', { nonNullable: true }),
    tag: new FormControl('Nouveauté', { nonNullable: true }),
    price: new FormControl<number>(299, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(0)],
    }),
    status: new FormControl<ProductStatus>('active', { nonNullable: true }),
    fabricNote: new FormControl('', { nonNullable: true }),
    fitNote: new FormControl('', { nonNullable: true }),
    description: new FormControl('', { nonNullable: true }),
    initialSize: new FormControl('M', { nonNullable: true }),
    initialStock: new FormControl<number>(10, { nonNullable: true, validators: [Validators.min(0)] }),
    imageColor: new FormControl('Anthracite', { nonNullable: true }),
    imageColorHex: new FormControl('#2F3234', {
      nonNullable: true,
      validators: [Validators.pattern(/^(#[0-9a-fA-F]{6})?$/)],
    }),
  });

  // Live colour signals for reactive previews even without OnPush friction
  readonly newProductPhotoHex = signal<string>('#2F3234');
  readonly newProductPhotoName = signal<string>('Anthracite');
  readonly rowUploadHex = signal<string>('#2F3234');
  readonly rowUploadName = signal<string>('Anthracite');
  readonly addVariantHex = signal<string>('#2F3234');
  readonly addVariantName = signal<string>('Anthracite');
  readonly editImgHex = signal<string>('#2F3234');
  readonly editImgName = signal<string>('');

  // Orders filter
  readonly orderSearchControl = new FormControl('', { nonNullable: true });
  readonly orderSearch = signal<string>('');
  readonly filteredOrders = computed(() => {
    const q = this.orderSearch().trim().toLowerCase();
    const list = this.store.orders();
    if (!q) return list;
    return list.filter((o) =>
      [o.order_number, o.full_name, o.phone, o.city, o.status].some((v) =>
        String(v || '').toLowerCase().includes(q)
      )
    );
  });

  // Movements search
  readonly movementSearchControl = new FormControl('', { nonNullable: true });
  readonly movementSearch = signal<string>('');
  readonly filteredMovements = computed(() => {
    const q = this.movementSearch().trim().toLowerCase();
    const list = this.store.stockMovements();
    if (!q) return list;
    return list.filter((m) =>
      [m.product_name, m.sku, m.reason, m.order_number || ''].some((v) =>
        v.toLowerCase().includes(q)
      )
    );
  });

  // Settings form
  readonly settingsForm = new FormGroup({
    apiUrl: new FormControl(this.store.apiUrl(), { nonNullable: true }),
    whatsapp: new FormControl(this.store.ownerWhatsApp(), { nonNullable: true }),
  });

  constructor() {
    this.catalogSearchControl.valueChanges.subscribe((v) => this.catalogSearch.set(v));
    this.orderSearchControl.valueChanges.subscribe((v) => this.orderSearch.set(v));
    this.movementSearchControl.valueChanges.subscribe((v) => this.movementSearch.set(v));

    this.createProductForm.controls.imageColorHex.valueChanges.subscribe((v) =>
      this.newProductPhotoHex.set(this.safeHex(v))
    );
    this.createProductForm.controls.imageColor.valueChanges.subscribe((v) =>
      this.newProductPhotoName.set(v)
    );
    this.rowUploadForm.controls.colorHex.valueChanges.subscribe((v) =>
      this.rowUploadHex.set(this.safeHex(v))
    );
    this.rowUploadForm.controls.color.valueChanges.subscribe((v) => this.rowUploadName.set(v));
    this.addVariantForm.controls.colorHex.valueChanges.subscribe((v) =>
      this.addVariantHex.set(this.safeHex(v))
    );
    this.addVariantForm.controls.color.valueChanges.subscribe((v) => this.addVariantName.set(v));
    this.editImageColorForm.controls.colorHex.valueChanges.subscribe((v) =>
      this.editImgHex.set(this.safeHex(v))
    );
    this.editImageColorForm.controls.color.valueChanges.subscribe((v) => this.editImgName.set(v));
  }

  ngOnInit(): void {
    void this.store.loadAdminAuthStatus();
  }

  presetLabel(preset: ColorPreset): string {
    return this.isAr() ? preset.ar : preset.fr;
  }

  safeHex(hex: string): string {
    const clean = hex.trim();
    return /^#[0-9a-fA-F]{6}$/.test(clean) ? clean.toUpperCase() : '#2F3234';
  }

  pickPhotoColorPreset(preset: ColorPreset): void {
    const name = this.presetLabel(preset);
    this.createProductForm.controls.imageColor.setValue(name);
    this.createProductForm.controls.imageColorHex.setValue(preset.hex);
  }

  onPhotoColorWheel(event: Event): void {
    const hex = (event.target as HTMLInputElement).value.toUpperCase();
    this.createProductForm.controls.imageColorHex.setValue(hex);
    const match = this.colorPresets.find((p) => p.hex.toUpperCase() === hex);
    if (match) {
      this.createProductForm.controls.imageColor.setValue(this.presetLabel(match));
    }
  }

  pickRowUploadPreset(preset: ColorPreset): void {
    const name = this.presetLabel(preset);
    this.rowUploadForm.controls.color.setValue(name);
    this.rowUploadForm.controls.colorHex.setValue(preset.hex);
  }

  onRowUploadWheel(event: Event): void {
    const hex = (event.target as HTMLInputElement).value.toUpperCase();
    this.rowUploadForm.controls.colorHex.setValue(hex);
    const match = this.colorPresets.find((p) => p.hex.toUpperCase() === hex);
    if (match) {
      this.rowUploadForm.controls.color.setValue(this.presetLabel(match));
    }
  }

  pickAddVariantPreset(preset: ColorPreset): void {
    const name = this.presetLabel(preset);
    this.addVariantForm.controls.color.setValue(name);
    this.addVariantForm.controls.colorHex.setValue(preset.hex);
  }

  onAddVariantWheel(event: Event): void {
    const hex = (event.target as HTMLInputElement).value.toUpperCase();
    this.addVariantForm.controls.colorHex.setValue(hex);
    const match = this.colorPresets.find((p) => p.hex.toUpperCase() === hex);
    if (match) {
      this.addVariantForm.controls.color.setValue(this.presetLabel(match));
    }
  }

  pickEditImagePreset(preset: ColorPreset): void {
    const name = this.presetLabel(preset);
    this.editImageColorForm.controls.color.setValue(name);
    this.editImageColorForm.controls.colorHex.setValue(preset.hex);
  }

  onEditImageWheel(event: Event): void {
    const hex = (event.target as HTMLInputElement).value.toUpperCase();
    this.editImageColorForm.controls.colorHex.setValue(hex);
    const match = this.colorPresets.find((p) => p.hex.toUpperCase() === hex);
    if (match) {
      this.editImageColorForm.controls.color.setValue(this.presetLabel(match));
    }
  }

  categoryLabel(cat: ProductCategory): string {
    if (!this.isAr()) {
      if (cat === 'Tops') return 'Hauts';
      if (cat === 'Layers') return 'Vestes & Sweats';
      return 'Bas';
    }
    if (cat === 'Tops') return 'تيشيرتات وقمصان';
    if (cat === 'Layers') return 'هوديز وسترات';
    return 'سراويل وشورتات';
  }

  productStatusLabel(status: ProductStatus): string {
    if (!this.isAr()) {
      if (status === 'active') return 'Actif';
      if (status === 'draft') return 'Brouillon';
      return 'Archivé';
    }
    if (status === 'active') return 'نشط';
    if (status === 'draft') return 'مسودة';
    return 'مؤرشف';
  }

  orderStatusLabel(status: OrderStatus): string {
    if (!this.isAr()) {
      switch (status) {
        case 'pending':
          return 'En attente';
        case 'confirmed':
          return 'Confirmée';
        case 'preparing':
          return 'En préparation';
        case 'shipped':
          return 'Expédiée';
        case 'out_for_delivery':
          return 'En livraison';
        case 'delivered':
          return 'Livrée';
        case 'cancelled':
          return 'Annulée';
        case 'returned':
          return 'Retournée';
      }
    }
    switch (status) {
      case 'pending':
        return 'قيد الانتظار';
      case 'confirmed':
        return 'مؤكد';
      case 'preparing':
        return 'قيد التجهيز';
      case 'shipped':
        return 'تم الشحن';
      case 'out_for_delivery':
        return 'جاري التوصيل';
      case 'delivered':
        return 'تم التسليم';
      case 'cancelled':
        return 'ملغى';
      case 'returned':
        return 'مرتجع';
    }
  }

  async submitInitialSetup(): Promise<void> {
    if (this.setupForm.invalid || this.authBusy()) {
      this.setupForm.markAllAsTouched();
      return;
    }
    const { pin, confirmPin } = this.setupForm.getRawValue();
    if (pin.trim() !== confirmPin.trim()) {
      this.authError.set(
        this.isAr() ? 'رمزا PIN غير متطابقين.' : 'Les deux codes PIN ne correspondent pas.'
      );
      return;
    }
    this.authError.set('');
    this.authBusy.set(true);
    try {
      await this.store.setupInitialAdminPin(pin);
      this.setupForm.reset({ pin: '', confirmPin: '' });
      this.settingsForm.controls.apiUrl.setValue(this.store.apiUrl());
    } catch (err) {
      this.authError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'تعذر حفظ رمز PIN.'
            : 'Impossible d’enregistrer le code PIN.'
      );
    } finally {
      this.authBusy.set(false);
    }
  }

  async submitLogin(): Promise<void> {
    if (this.loginForm.invalid || this.authBusy()) {
      this.loginForm.markAllAsTouched();
      return;
    }
    this.authError.set('');
    this.authBusy.set(true);
    try {
      const { pin, apiUrl } = this.loginForm.getRawValue();
      await this.store.verifyAndUnlockAdmin(pin, this.showApiConfig() ? apiUrl : undefined);
      this.loginForm.controls.pin.setValue('');
      this.settingsForm.controls.apiUrl.setValue(this.store.apiUrl());
    } catch (err) {
      this.authError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'تعذر التحقق من رمز PIN.'
            : 'Impossible de vérifier le code PIN.'
      );
    } finally {
      this.authBusy.set(false);
    }
  }

  lockWorkspace(): void {
    this.store.lockAdmin();
    this.crmFeedback.set('');
    this.crmError.set('');
  }

  startEditingProduct(product: Product): void {
    this.confirmDeleteProductId.set(null);
    if (this.editingProductId() === product.id) {
      this.editingProductId.set(null);
      return;
    }
    this.editingProductId.set(product.id);
    this.editProductForm.setValue({
      name: product.name,
      category: product.category,
      tag: product.tag || '',
      price: product.price ?? 0,
      fabricNote: product.fabricNote || '',
      fitNote: product.fitNote || '',
      description: product.description || '',
      status: product.status,
    });
  }

  async saveEditedProduct(productId: number): Promise<void> {
    if (this.editProductForm.invalid || this.crmBusy()) return;
    this.clearNotices();
    this.crmBusy.set(true);
    try {
      await this.store.updateProduct(productId, this.editProductForm.getRawValue());
      this.editingProductId.set(null);
      this.crmFeedback.set(
        this.isAr()
          ? 'تم تحديث المنتج في قاعدة البيانات.'
          : 'Produit mis à jour et synchronisé avec la boutique.'
      );
    } catch (err) {
      this.crmError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'تعذر تحديث المنتج.'
            : 'Échec de mise à jour du produit.'
      );
    } finally {
      this.crmBusy.set(false);
    }
  }

  async confirmDeleteProduct(product: Product): Promise<void> {
    if (this.crmBusy()) return;
    this.clearNotices();
    this.crmBusy.set(true);
    try {
      await this.store.deleteProduct(product.id);
      this.confirmDeleteProductId.set(null);
      this.crmFeedback.set(
        this.isAr()
          ? `تم حذف "${product.name}" من قاعدة البيانات.`
          : `Produit « ${product.name} » supprimé.`
      );
    } catch (err) {
      this.crmError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'تعذر حذف المنتج.'
            : 'Impossible de supprimer le produit.'
      );
    } finally {
      this.crmBusy.set(false);
    }
  }

  toggleVariantForm(productId: number): void {
    this.confirmDeleteProductId.set(null);
    if (this.addingVariantForProductId() === productId) {
      this.addingVariantForProductId.set(null);
      return;
    }
    this.addingVariantForProductId.set(productId);
    const defaultColor = this.isAr() ? 'رمادي داكن' : 'Anthracite';
    this.addVariantForm.reset({
      size: 'M',
      color: defaultColor,
      colorHex: '#2F3234',
      stock: 8,
    });
  }

  async submitNewVariant(productId: number): Promise<void> {
    if (this.addVariantForm.invalid || this.crmBusy()) return;
    this.clearNotices();
    this.crmBusy.set(true);
    try {
      await this.store.createVariant(productId, this.addVariantForm.getRawValue());
      this.addingVariantForProductId.set(null);
      this.crmFeedback.set(
        this.isAr()
          ? 'تم حفظ المقاس واللون في قاعدة البيانات.'
          : 'Variante taille et coloris enregistrée.'
      );
    } catch (err) {
      this.crmError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'تعذر إضافة المقاس واللون.'
            : 'Impossible d’ajouter la variante.'
      );
    } finally {
      this.crmBusy.set(false);
    }
  }

  async adjustStock(variantId: number, delta: number): Promise<void> {
    if (this.crmBusy()) return;
    this.clearNotices();
    this.crmBusy.set(true);
    try {
      await this.store.adjustVariantStock(
        variantId,
        delta,
        this.isAr() ? 'تعديل يدوي من لوحة التحكم' : 'Ajustement manuel CRM'
      );
      this.crmFeedback.set(
        this.isAr() ? 'تم تحديث المخزون وتسجيل الحركة.' : 'Stock mis à jour et mouvement enregistré.'
      );
    } catch (err) {
      this.crmError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'تعذر تعديل المخزون.'
            : 'Échec de l’ajustement du stock.'
      );
    } finally {
      this.crmBusy.set(false);
    }
  }

  async onRowImagePicked(product: Product, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.clearNotices();
    this.compressingImages.set(true);
    this.crmBusy.set(true);
    this.rowProgress.set({
      productId: product.id,
      percent: 5,
      phase: 'compress',
      label: this.formatProgressLabel('decoding', 5),
    });
    try {
      const result = await this.imagePipeline.compressImage(file, (p) => {
        this.rowProgress.set({
          productId: product.id,
          percent: p.percent,
          phase: 'compress',
          label: this.formatProgressLabel(p.stage, p.percent, p.width),
        });
      });
      this.uploadingImageProductId.set(product.id);
      this.pendingRowVariants.set(result.variants);
      this.pendingRowVariantSummary.set(
        result.variants.map((v) => `${v.width}px (${Math.round(v.bytes / 1024)} Ko)`).join(' · ')
      );
      this.pendingRowCompressionNote.set(
        this.formatCompressionNote(result.originalBytes, result.compressedBytes, result.savingsPercent)
      );
      if (this.pendingRowPreviewUrl()) {
        URL.revokeObjectURL(this.pendingRowPreviewUrl());
      }
      const previewBlob = result.variants.find((v) => v.width === 800)?.blob || result.variants[0].blob;
      this.pendingRowPreviewUrl.set(URL.createObjectURL(previewBlob));

      const firstVariant = product.variants[0];
      this.rowUploadForm.setValue({
        color: firstVariant?.color || (this.isAr() ? 'رمادي داكن' : 'Anthracite'),
        colorHex: firstVariant?.color_hex || '#2F3234',
      });
    } catch (err) {
      this.crmError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'فشل ضغط الصورة.'
            : 'Échec de compression de l’image.'
      );
    } finally {
      this.compressingImages.set(false);
      this.crmBusy.set(false);
      this.rowProgress.set(null);
      input.value = '';
    }
  }

  async uploadRowImage(product: Product): Promise<void> {
    if (
      this.uploadingImageProductId() !== product.id ||
      !this.pendingRowVariants().length ||
      this.rowUploadForm.invalid
    ) {
      this.rowUploadForm.markAllAsTouched();
      return;
    }
    this.clearNotices();
    this.crmBusy.set(true);
    const { color, colorHex } = this.rowUploadForm.getRawValue();
    this.rowProgress.set({
      productId: product.id,
      percent: 5,
      phase: 'upload',
      label: this.formatProgressLabel('presigning', 5),
    });
    try {
      await this.store.uploadProductImage(
        product.id,
        product.name,
        this.pendingRowVariants(),
        color,
        colorHex,
        product.images.length,
        (p) => {
          this.rowProgress.set({
            productId: product.id,
            percent: p.percent,
            phase: 'upload',
            label: this.formatProgressLabel(p.stage, p.percent, p.width),
          });
        }
      );
      this.cancelRowImageUpload();
      this.crmFeedback.set(
        this.isAr()
          ? `تمت إضافة صورة (${color || 'بدون اسم'}) وضغطها بنجاح.`
          : `Photo « ${color || 'standard'} » compressée et enregistrée pour ${product.name}.`
      );
    } catch (err) {
      this.crmError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'فشل رفع الصورة.'
            : 'Échec du téléversement.'
      );
    } finally {
      this.crmBusy.set(false);
      this.rowProgress.set(null);
    }
  }

  cancelRowImageUpload(): void {
    this.uploadingImageProductId.set(null);
    this.pendingRowVariants.set([]);
    this.pendingRowVariantSummary.set('');
    this.pendingRowCompressionNote.set('');
    if (this.pendingRowPreviewUrl()) {
      URL.revokeObjectURL(this.pendingRowPreviewUrl());
      this.pendingRowPreviewUrl.set('');
    }
  }

  startEditImageColor(img: ProductImage): void {
    if (this.editingImageId() === img.id) {
      this.editingImageId.set(null);
      return;
    }
    this.editingImageId.set(img.id);
    this.editImageColorForm.setValue({
      color: img.color || '',
      colorHex: img.color_hex || '#2F3234',
    });
  }

  async saveImageColor(imageId: number): Promise<void> {
    if (this.editImageColorForm.invalid || this.crmBusy()) {
      this.editImageColorForm.markAllAsTouched();
      return;
    }
    this.clearNotices();
    this.crmBusy.set(true);
    const { color, colorHex } = this.editImageColorForm.getRawValue();
    try {
      await this.store.updateProductImageColor(imageId, color, colorHex);
      this.editingImageId.set(null);
      this.crmFeedback.set(
        this.isAr() ? 'تم تحديث لون الصورة.' : 'Coloris de la photo mis à jour.'
      );
    } catch (err) {
      this.crmError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'تعذر تحديث لون الصورة.'
            : 'Impossible de modifier le coloris.'
      );
    } finally {
      this.crmBusy.set(false);
    }
  }

  async removeProductImage(imageId: number): Promise<void> {
    if (this.crmBusy()) return;
    this.clearNotices();
    this.crmBusy.set(true);
    try {
      await this.store.deleteProductImage(imageId);
      if (this.editingImageId() === imageId) {
        this.editingImageId.set(null);
      }
      this.crmFeedback.set(this.isAr() ? 'تم حذف الصورة.' : 'Photo supprimée du produit.');
    } catch (err) {
      this.crmError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'تعذر حذف الصورة.'
            : 'Impossible de supprimer la photo.'
      );
    } finally {
      this.crmBusy.set(false);
    }
  }

  async onNewProductImagePicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    if (!files.length) return;
    if (this.createProductForm.controls.imageColorHex.invalid) {
      this.createProductForm.controls.imageColorHex.markAsTouched();
      input.value = '';
      return;
    }
    this.clearNotices();
    this.compressingImages.set(true);
    this.crmBusy.set(true);
    const color =
      this.createProductForm.controls.imageColor.value.trim() ||
      (this.isAr() ? 'رمادي داكن' : 'Anthracite');
    const colorHex = this.safeHex(this.createProductForm.controls.imageColorHex.value);
    const total = files.length;
    this.addProgress.set({
      percent: 4,
      phase: 'compress',
      label: this.formatProgressLabel('decoding', 4, undefined, 0, total),
    });
    try {
      const additions: StagedProductImage[] = [];
      for (let i = 0; i < total; i++) {
        const file = files[i];
        const result = await this.imagePipeline.compressImage(file, (p) => {
          const combined = Math.round(((i + p.percent / 100) / total) * 100);
          this.addProgress.set({
            percent: combined,
            phase: 'compress',
            label: this.formatProgressLabel(p.stage, combined, p.width, i, total),
          });
        });
        const previewBlob = result.variants.find((v) => v.width === 800)?.blob || result.variants[0].blob;
        additions.push({
          id: this.nextStagedId++,
          variants: result.variants,
          previewUrl: URL.createObjectURL(previewBlob),
          color,
          colorHex,
          summary: result.variants.map((v) => `${v.width}px`).join(' · '),
          compressionNote: this.formatCompressionNote(
            result.originalBytes,
            result.compressedBytes,
            result.savingsPercent
          ),
        });
      }
      this.stagedProductImages.update((prev) => [...prev, ...additions]);
    } catch (err) {
      this.crmError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'فشل ضغط الصورة محلياً.'
            : 'Échec de compression locale de l’image.'
      );
    } finally {
      this.compressingImages.set(false);
      this.crmBusy.set(false);
      this.addProgress.set(null);
      input.value = '';
    }
  }

  removeStagedImage(stagedId: number): void {
    this.stagedProductImages.update((prev) => {
      const target = prev.find((item) => item.id === stagedId);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((item) => item.id !== stagedId);
    });
  }

  async submitCreateProduct(): Promise<void> {
    if (this.createProductForm.invalid || this.crmBusy()) {
      this.createProductForm.markAllAsTouched();
      return;
    }
    this.clearNotices();
    this.crmBusy.set(true);
    const val = this.createProductForm.getRawValue();
    const staged = this.stagedProductImages();
    if (staged.length) {
      this.addProgress.set({
        percent: 5,
        phase: 'upload',
        label: this.formatProgressLabel('presigning', 5, undefined, 0, staged.length),
      });
    }
    try {
      const created = await this.store.createProduct({
        name: val.name,
        slug: val.slug,
        category: val.category,
        tag: val.tag,
        price: Number(val.price),
        status: val.status,
        fabricNote: val.fabricNote,
        fitNote: val.fitNote,
        description: val.description,
        initialVariant: val.initialSize.trim()
          ? {
              size: val.initialSize,
              color: staged[0]?.color || val.imageColor,
              colorHex: staged[0]?.colorHex || val.imageColorHex,
              stock: Number(val.initialStock),
            }
          : undefined,
        imageUploads: staged.length
          ? staged.map((item) => ({
              variants: item.variants,
              color: item.color,
              colorHex: item.colorHex,
            }))
          : undefined,
        onImageProgress: (p, index, total) => {
          const combined = Math.round(((index + p.percent / 100) / Math.max(1, total)) * 100);
          this.addProgress.set({
            percent: combined,
            phase: 'upload',
            label: this.formatProgressLabel(p.stage, combined, p.width, index, total),
          });
        },
      });

      for (const item of staged) {
        URL.revokeObjectURL(item.previewUrl);
      }
      this.stagedProductImages.set([]);

      const defaultColor = this.isAr() ? 'رمادي داكن' : 'Anthracite';
      this.createProductForm.reset({
        name: '',
        slug: '',
        category: 'Tops',
        tag: this.isAr() ? 'جديد' : 'Nouveauté',
        price: 299,
        status: 'active',
        fabricNote: '',
        fitNote: '',
        description: '',
        initialSize: 'M',
        initialStock: 10,
        imageColor: defaultColor,
        imageColorHex: '#2F3234',
      });
      this.activeTab.set('catalog');
      this.crmFeedback.set(
        this.isAr()
          ? `تم حفظ المنتج "${created.name}" (${staged.length} صور مضغوطة) بنجاح.`
          : `Produit « ${created.name} » (${staged.length} photo${staged.length > 1 ? 's' : ''} WebP) enregistré.`
      );
    } catch (err) {
      this.crmError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'تعذر إنشاء المنتج.'
            : 'Impossible de créer le produit.'
      );
    } finally {
      this.crmBusy.set(false);
      this.addProgress.set(null);
    }
  }

  async onOrderStatusChange(order: OrderRecord, event: Event): Promise<void> {
    const nextStatus = (event.target as HTMLSelectElement).value as OrderStatus;
    this.clearNotices();
    this.crmBusy.set(true);
    try {
      await this.store.updateOrderStatus(order.id, nextStatus);
      this.crmFeedback.set(
        this.isAr()
          ? `تم تغيير حالة الطلب ${order.order_number} إلى ${this.orderStatusLabel(nextStatus)}.`
          : `Commande ${order.order_number} passée au statut « ${this.orderStatusLabel(nextStatus)} ».`
      );
    } catch (err) {
      this.crmError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'تعذر تحديث حالة الطلب.'
            : 'Impossible de mettre à jour le statut.'
      );
    } finally {
      this.crmBusy.set(false);
    }
  }

  async refreshDatabaseData(): Promise<void> {
    this.clearNotices();
    this.crmBusy.set(true);
    try {
      await Promise.all([
        this.store.refreshAdminCatalog(),
        this.store.refreshAdminOrders(this.orderSearch()),
        this.store.refreshAdminNotifications(),
        this.store.refreshInventoryAudit(),
        this.store.refreshStockMovements(this.movementSearch()),
        this.store.refreshD1Status().catch(() => undefined),
        this.store.refreshR2Status().catch(() => undefined),
      ]);
      const isD1 = this.store.d1Status().mode === 'cloudflare-d1' || Boolean(this.store.apiUrl());
      this.crmFeedback.set(
        isD1
          ? this.isAr()
            ? 'تمت المزامنة مع قاعدة بيانات Cloudflare D1 (mokiko).'
            : 'Synchronisé avec Cloudflare D1 (mokiko).'
          : this.isAr()
            ? 'تمت المزامنة مع قاعدة البيانات.'
            : 'Synchronisé avec la base de données.'
      );
    } catch (err) {
      this.crmError.set(
        err instanceof Error ? err.message : this.isAr() ? 'فشل التحديث.' : 'Échec de synchronisation.'
      );
    } finally {
      this.crmBusy.set(false);
    }
  }

  async togglePriceVisibility(event: Event): Promise<void> {
    const checked = (event.target as HTMLInputElement).checked;
    this.clearNotices();
    this.crmBusy.set(true);
    try {
      await this.store.setPriceVisibility(checked);
      this.crmFeedback.set(
        checked
          ? this.isAr()
            ? 'الأسعار ظاهرة الآن في المتجر.'
            : 'Les prix sont maintenant visibles sur la boutique.'
          : this.isAr()
            ? 'المتجر في وضع الاستفسار عبر واتساب فقط.'
            : 'Boutique passée en mode demande sur WhatsApp uniquement.'
      );
    } catch (err) {
      this.crmError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'تعذر تحديث إعدادات الأسعار.'
            : 'Impossible de modifier l’affichage des prix.'
      );
    } finally {
      this.crmBusy.set(false);
    }
  }

  saveStoreSettings(): void {
    const { apiUrl, whatsapp } = this.settingsForm.getRawValue();
    this.store.setApiUrl(apiUrl);
    this.store.setOwnerWhatsApp(whatsapp);
    this.crmFeedback.set(
      this.isAr()
        ? 'تم حفظ رابط API ورقم الواتساب.'
        : 'Paramètres API et numéro WhatsApp enregistrés.'
    );
  }

  downloadCatalogJson(): void {
    const json = this.store.exportCatalogJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mokiko-sport-catalog.json';
    a.click();
    URL.revokeObjectURL(url);
    this.crmFeedback.set(
      this.isAr() ? 'تم تصدير الكتالوج بصيغة JSON.' : 'Catalogue exporté au format JSON.'
    );
  }

  totalProductStock(product: Product): number {
    return product.variants.reduce((sum, v) => sum + v.stock, 0);
  }

  private formatCompressionNote(originalBytes: number, compressedBytes: number, savings: number): string {
    const origKb = Math.round(originalBytes / 1024);
    const compKb = Math.round(compressedBytes / 1024);
    const origLabel = origKb >= 1024 ? `${(origKb / 1024).toFixed(2)} Mo` : `${origKb} Ko`;
    const compLabel = `${compKb} Ko`;
    if (this.isAr()) {
      return `ضغط محلي WebP: ${origLabel} → ${compLabel} (توفير ${savings}%)`;
    }
    return `Compressé localement WebP : ${origLabel} → ${compLabel} (3 tailles · −${savings}%)`;
  }

  private formatProgressLabel(
    stage: ImagePipelineStage,
    _percent: number,
    width?: 400 | 800 | 1200,
    index?: number,
    total?: number
  ): string {
    const seq = total && total > 1 && index !== undefined ? ` (${index + 1}/${total})` : '';
    const sizeTxt = width ? ` ${width}px` : '';
    if (this.isAr()) {
      switch (stage) {
        case 'decoding':
          return `قراءة الصورة${seq}…`;
        case 'compressing':
          return `ضغط محلي WebP${sizeTxt}${seq}…`;
        case 'presigning':
          return `تجهيز رابط R2 (mokiko)${seq}…`;
        case 'uploading':
          return `جاري الرفع إلى Cloudflare R2${seq}…`;
        case 'finalizing':
          return `حفظ البيانات في base de données${seq}…`;
        case 'done':
          return `اكتمل${seq}`;
      }
    }
    switch (stage) {
      case 'decoding':
        return `Lecture du fichier${seq}…`;
      case 'compressing':
        return `Compression WebP${sizeTxt}${seq}…`;
      case 'presigning':
        return `Préparation URL signée R2 (mokiko)${seq}…`;
      case 'uploading':
        return `Envoi vers Cloudflare R2${seq}…`;
      case 'finalizing':
        return `Enregistrement${seq}…`;
      case 'done':
        return `Terminé${seq}`;
    }
  }

  private clearNotices(): void {
    this.crmFeedback.set('');
    this.crmError.set('');
  }
}
