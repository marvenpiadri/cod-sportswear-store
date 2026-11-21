import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { StoreState } from '../../services/store-state';

@Component({
  selector: 'store-cart-drawer',
  templateUrl: './cart-drawer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class CartDrawer {
  readonly store = inject(StoreState);
  readonly isAr = computed(() => this.store.lang() === 'ar');

  openCheckout(): void {
    this.store.cartOpen.set(false);
    this.store.checkoutOpen.set(true);
  }

  onEscape(): void {
    if (this.store.cartOpen()) {
      this.store.cartOpen.set(false);
    }
  }
}
