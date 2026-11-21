import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { CartDrawer } from '../../components/cart-drawer/cart-drawer';
import { CheckoutDrawer } from '../../components/checkout-drawer/checkout-drawer';
import { ProductDetailDrawer } from '../../components/product-detail-drawer/product-detail-drawer';
import { Product, ProductCategory, SortOption } from '../../models/store.models';
import { StoreState } from '../../services/store-state';

export interface SwatchOption {
  color: string;
  hex: string;
}

@Component({
  selector: 'store-front',
  imports: [ReactiveFormsModule, ProductDetailDrawer, CartDrawer, CheckoutDrawer],
  templateUrl: './storefront.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Storefront {
  readonly store = inject(StoreState);

  readonly announcementDismissed = signal<boolean>(false);
  readonly searchControl = new FormControl('', { nonNullable: true });
  readonly categories: ReadonlyArray<'All' | ProductCategory> = ['All', 'Tops', 'Layers', 'Bottoms'];
  readonly failedImages = signal<Record<string, boolean>>({});
  readonly selectedCardColor = signal<Record<number, string>>({});
  readonly infoModal = signal<'sizes' | 'shipping' | null>(null);

  readonly isAr = computed(() => this.store.lang() === 'ar');

  readonly pageNumbers = computed(() =>
    Array.from({ length: this.store.totalPages() }, (_, idx) => idx + 1)
  );

  constructor() {
    this.searchControl.valueChanges.subscribe((value) => {
      this.store.setSearch(value);
    });
  }

  categoryLabel(cat: 'All' | ProductCategory): string {
    if (!this.isAr()) {
      switch (cat) {
        case 'All':
          return 'Tout';
        case 'Tops':
          return 'Hauts';
        case 'Layers':
          return 'Vestes & Sweats';
        case 'Bottoms':
          return 'Bas';
      }
    }
    switch (cat) {
      case 'All':
        return 'الكل';
      case 'Tops':
        return 'تيشيرتات وقمصان';
      case 'Layers':
        return 'هوديز وسترات';
      case 'Bottoms':
        return 'سراويل وشورتات';
    }
  }

  selectCategoryAndScroll(cat: 'All' | ProductCategory): void {
    this.store.setCategory(cat);
    this.scrollToSection('collection');
  }

  onSortChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as SortOption;
    this.store.setSort(value);
  }

  clearFilters(): void {
    this.searchControl.setValue('');
    this.store.setCategory('All');
    this.store.setSort('featured');
  }

  scrollToSection(id: string): void {
    if (typeof document === 'undefined') return;
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  changePage(page: number): void {
    this.store.changePage(page);
    this.scrollToSection('collection');
  }

  /**
   * Dynamically derives colour swatches from the product's SQLite colour-tagged images
   * (`image_assets`), falling back to product variants only when no colour-tagged photos exist.
   */
  cardSwatches(product: Product): SwatchOption[] {
    const map = new Map<string, SwatchOption>();
    for (const img of product.images || []) {
      if (img.color_hex) {
        const key = img.color_hex.toLowerCase();
        if (!map.has(key)) {
          map.set(key, { color: img.color || img.color_hex, hex: img.color_hex });
        }
      }
    }
    if (!map.size) {
      for (const v of product.variants || []) {
        if (v.color_hex) {
          const key = v.color_hex.toLowerCase();
          if (!map.has(key)) {
            map.set(key, { color: v.color || v.color_hex, hex: v.color_hex });
          }
        }
      }
    }
    return Array.from(map.values());
  }

  activeCardColor(product: Product): string | null {
    const picked = this.selectedCardColor()[product.id];
    if (picked) return picked;
    const swatches = this.cardSwatches(product);
    return swatches[0]?.hex ?? null;
  }

  activeCardColorLabel(product: Product): string {
    const active = this.activeCardColor(product);
    if (!active) return '';
    const match = this.cardSwatches(product).find(
      (s) => s.hex.toLowerCase() === active.toLowerCase()
    );
    return match?.color ?? '';
  }

  cardImageUrl(product: Product): string {
    const active = this.activeCardColor(product);
    if (active && product.images?.length) {
      const imgMatch = product.images.find(
        (img) => img.color_hex?.toLowerCase() === active.toLowerCase()
      );
      if (imgMatch) return imgMatch.url;
    }
    return product.images?.[0]?.url || product.image;
  }

  previewCardColor(product: Product, hex: string): void {
    this.selectedCardColor.update((prev) => ({ ...prev, [product.id]: hex }));
  }

  selectCardColor(product: Product, hex: string, event: Event): void {
    event.stopPropagation();
    this.selectedCardColor.update((prev) => ({ ...prev, [product.id]: hex }));
  }

  isImageFailed(product: Product): boolean {
    return Boolean(this.failedImages()[this.cardImageUrl(product)]);
  }

  markImageFailed(url: string): void {
    this.failedImages.update((prev) => ({ ...prev, [url]: true }));
  }

  quickView(product: Product): void {
    this.store.openProduct(product, this.activeCardColor(product));
  }
}
