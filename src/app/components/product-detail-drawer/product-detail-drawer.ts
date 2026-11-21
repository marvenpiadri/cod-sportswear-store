import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ProductImage, ProductVariant } from '../../models/store.models';
import { StoreState } from '../../services/store-state';

type SizeMeasureRow = { size: string; chest: string; waist: string; length: string };
type DetailColorOption = { color: string; hex: string };

const BODY_MEASURES: SizeMeasureRow[] = [
  { size: 'S', chest: '92–97', waist: '76–81', length: '170–176' },
  { size: 'M', chest: '98–103', waist: '82–87', length: '176–182' },
  { size: 'L', chest: '104–110', waist: '88–94', length: '182–188' },
  { size: 'XL', chest: '111–118', waist: '95–102', length: '186–192' },
];

const GARMENT_MEASURES: SizeMeasureRow[] = [
  { size: 'S', chest: '52.0', waist: '49.5', length: '68.5' },
  { size: 'M', chest: '55.0', waist: '52.5', length: '70.5' },
  { size: 'L', chest: '58.0', waist: '55.5', length: '72.5' },
  { size: 'XL', chest: '61.5', waist: '59.0', length: '74.5' },
];

@Component({
  selector: 'store-product-detail-drawer',
  templateUrl: './product-detail-drawer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class ProductDetailDrawer {
  readonly store = inject(StoreState);
  readonly product = this.store.selectedProduct;

  readonly selectedVariant = signal<ProductVariant | null>(null);
  readonly selectedColorHex = signal<string | null>(null);
  readonly selectedImageId = signal<number | null>(null);
  readonly sizeGuideOpen = signal<boolean>(false);
  readonly sizeGuideMode = signal<'body' | 'garment'>('body');
  readonly imageFailed = signal<boolean>(false);

  readonly isAr = computed(() => this.store.lang() === 'ar');

  readonly sizeRows = computed(() =>
    this.sizeGuideMode() === 'body' ? BODY_MEASURES : GARMENT_MEASURES
  );

  readonly colorOptions = computed<DetailColorOption[]>(() => {
    const p = this.product();
    if (!p) return [];
    const map = new Map<string, DetailColorOption>();
    for (const img of p.images || []) {
      if (img.color_hex) {
        const key = img.color_hex.toLowerCase();
        if (!map.has(key)) {
          map.set(key, { color: img.color || img.color_hex, hex: img.color_hex });
        }
      }
    }
    if (!map.size) {
      for (const v of p.variants || []) {
        if (v.color_hex) {
          const key = v.color_hex.toLowerCase();
          if (!map.has(key)) {
            map.set(key, { color: v.color || v.color_hex, hex: v.color_hex });
          }
        }
      }
    }
    return Array.from(map.values());
  });

  readonly activeImage = computed<ProductImage | null>(() => {
    const p = this.product();
    if (!p || !p.images?.length) return null;
    const pickedId = this.selectedImageId();
    if (pickedId !== null) {
      const byId = p.images.find((img) => img.id === pickedId);
      if (byId) return byId;
    }
    const hex = this.selectedColorHex();
    if (hex) {
      const byHex = p.images.find((img) => img.color_hex?.toLowerCase() === hex.toLowerCase());
      if (byHex) return byHex;
    }
    return p.images[0] ?? null;
  });

  readonly activeImageUrl = computed(() => {
    const active = this.activeImage();
    if (active) return active.url;
    return this.product()?.image || '';
  });

  readonly activeColorName = computed(() => {
    const hex = this.selectedColorHex();
    if (hex) {
      const opt = this.colorOptions().find((o) => o.hex.toLowerCase() === hex.toLowerCase());
      if (opt) return opt.color;
    }
    const imgColor = this.activeImage()?.color;
    if (imgColor) return imgColor;
    const v = this.selectedVariant();
    if (v) return v.color;
    return this.isAr() ? 'قياسي' : 'Standard';
  });

  readonly canPurchase = computed(() => {
    const p = this.product();
    if (!p) return false;
    if (!this.store.priceVisible()) return true;
    if (!p.variants.length) return true;
    const v = this.selectedVariant();
    return Boolean(v && v.stock > 0);
  });

  readonly inquiryUrl = computed(() => {
    const p = this.product();
    if (!p) return '#';
    return this.store.buildInquiryUrl(p, this.selectedVariant() ?? undefined);
  });

  constructor() {
    effect(() => {
      const p = this.product();
      const preferredHex = this.store.preferredDetailColorHex();
      this.imageFailed.set(false);
      this.sizeGuideOpen.set(false);
      if (!p) {
        this.selectedVariant.set(null);
        this.selectedColorHex.set(null);
        this.selectedImageId.set(null);
        return;
      }

      const preferredVariant = preferredHex
        ? p.variants.find(
            (v) => v.color_hex?.toLowerCase() === preferredHex.toLowerCase() && v.stock > 0
          ) ?? p.variants.find((v) => v.color_hex?.toLowerCase() === preferredHex.toLowerCase())
        : undefined;

      const initialVariant =
        preferredVariant ?? p.variants.find((v) => v.stock > 0) ?? p.variants[0] ?? null;
      this.selectedVariant.set(initialVariant);

      const initialHex =
        preferredHex ?? initialVariant?.color_hex ?? p.images?.[0]?.color_hex ?? p.colors[0] ?? null;
      this.selectedColorHex.set(initialHex);

      const initialImg =
        (initialHex
          ? p.images?.find((img) => img.color_hex?.toLowerCase() === initialHex.toLowerCase())
          : undefined) ?? p.images?.[0] ?? null;
      this.selectedImageId.set(initialImg?.id ?? null);
    });
  }

  categoryLabel(category: string): string {
    if (!this.isAr()) {
      if (category === 'Tops') return 'Hauts';
      if (category === 'Layers') return 'Vestes & Sweats';
      if (category === 'Bottoms') return 'Bas';
      return category;
    }
    if (category === 'Tops') return 'تيشيرتات وقمصان';
    if (category === 'Layers') return 'هوديز وسترات';
    if (category === 'Bottoms') return 'سراويل وشورتات';
    return category;
  }

  selectImage(img: ProductImage): void {
    this.imageFailed.set(false);
    this.selectedImageId.set(img.id);
    if (img.color_hex) {
      this.selectedColorHex.set(img.color_hex);
    }
    const p = this.product();
    if (!p) return;
    const match =
      (img.color_hex
        ? p.variants.find(
            (v) => v.color_hex?.toLowerCase() === img.color_hex?.toLowerCase() && v.stock > 0
          ) ?? p.variants.find((v) => v.color_hex?.toLowerCase() === img.color_hex?.toLowerCase())
        : undefined) ??
      (img.color
        ? p.variants.find((v) => v.color.toLowerCase() === img.color.toLowerCase() && v.stock > 0) ??
          p.variants.find((v) => v.color.toLowerCase() === img.color.toLowerCase())
        : undefined);
    if (match) {
      this.selectedVariant.set(match);
    }
  }

  selectVariant(variant: ProductVariant): void {
    this.selectedVariant.set(variant);
    if (variant.color_hex) {
      this.selectedColorHex.set(variant.color_hex);
      const p = this.product();
      const imgMatch = p?.images?.find(
        (img) => img.color_hex?.toLowerCase() === variant.color_hex?.toLowerCase()
      );
      if (imgMatch) {
        this.imageFailed.set(false);
        this.selectedImageId.set(imgMatch.id);
      }
    }
  }

  selectColor(hex: string): void {
    this.imageFailed.set(false);
    this.selectedColorHex.set(hex);
    const p = this.product();
    if (!p) return;

    const imgMatch = p.images?.find((img) => img.color_hex?.toLowerCase() === hex.toLowerCase());
    if (imgMatch) {
      this.selectedImageId.set(imgMatch.id);
    }

    const match =
      p.variants.find((v) => v.color_hex?.toLowerCase() === hex.toLowerCase() && v.stock > 0) ??
      p.variants.find((v) => v.color_hex?.toLowerCase() === hex.toLowerCase());
    if (match) {
      this.selectedVariant.set(match);
    }
  }

  addSelectedToCart(): void {
    const p = this.product();
    if (!p) return;
    const variant = this.selectedVariant() ?? undefined;
    this.store.addToCart(p, variant);
    this.store.closeProduct();
  }

  onEscape(): void {
    if (this.product()) {
      this.store.closeProduct();
    }
  }
}
