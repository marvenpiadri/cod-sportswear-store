import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { CustomerDetails } from '../../models/store.models';
import { StoreState } from '../../services/store-state';

@Component({
  selector: 'store-checkout-drawer',
  imports: [ReactiveFormsModule],
  templateUrl: './checkout-drawer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class CheckoutDrawer {
  readonly store = inject(StoreState);
  readonly isAr = computed(() => this.store.lang() === 'ar');

  readonly submitting = signal<boolean>(false);
  readonly orderError = signal<string>('');
  readonly orderNumber = signal<string>('');
  readonly orderComplete = signal<boolean>(false);
  readonly copiedSummary = signal<boolean>(false);
  readonly idempotencyKey = signal<string>('');
  readonly capturedCustomer = signal<CustomerDetails | null>(null);
  readonly capturedItems = signal(this.store.cart());
  readonly capturedSubtotal = signal<number>(0);

  readonly checkoutForm = new FormGroup({
    fullName: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(120)],
    }),
    phone: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.pattern(/^\+?[0-9\s().-]{5,25}$/),
      ],
    }),
    whatsapp: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.pattern(/^\+?[0-9\s().-]{5,25}$/),
      ],
    }),
    city: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(100)],
    }),
    address: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(500)],
    }),
    note: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(500)],
    }),
  });

  async submitOrder(): Promise<void> {
    if (this.checkoutForm.invalid) {
      this.checkoutForm.markAllAsTouched();
      return;
    }
    if (this.submitting() || this.orderComplete()) return;

    this.orderError.set('');
    if (!this.idempotencyKey()) {
      this.idempotencyKey.set(crypto.randomUUID());
    }

    const customer = this.checkoutForm.getRawValue();
    const itemsSnapshot = [...this.store.cart()];
    const subtotalSnapshot = this.store.subtotal();

    this.submitting.set(true);
    try {
      const result = await this.store.submitOrder(customer, this.idempotencyKey());
      this.capturedCustomer.set(customer);
      this.capturedItems.set(itemsSnapshot);
      this.capturedSubtotal.set(result.total || subtotalSnapshot);
      this.orderNumber.set(result.orderNumber);
      this.orderComplete.set(true);
      this.store.clearCart();
    } catch (err) {
      this.orderError.set(
        err instanceof Error
          ? err.message
          : this.isAr()
            ? 'تعذر تسجيل الطلب. يرجى المحاولة مرة أخرى.'
            : 'Impossible d’enregistrer la commande. Veuillez réessayer.'
      );
    } finally {
      this.submitting.set(false);
    }
  }

  whatsAppConfirmationUrl(): string {
    const customer = this.capturedCustomer();
    if (!customer) return '#';
    return this.store.buildCustomerOrderWhatsAppUrl(
      this.orderNumber(),
      customer,
      this.capturedItems(),
      this.capturedSubtotal()
    );
  }

  copyOrderDetails(): void {
    const customer = this.capturedCustomer();
    if (!customer) return;
    const isAr = this.isAr();
    const lines = [
      isAr
        ? `طلب MOKIKO SPORT (الدفع عند الاستلام) · ${this.orderNumber()}`
        : `COMMANDE MOKIKO SPORT (COD) · ${this.orderNumber()}`,
      `${isAr ? 'الاسم' : 'Nom'} : ${customer.fullName}`,
      `${isAr ? 'الهاتف' : 'Téléphone'} : ${customer.phone}`,
      `WhatsApp : ${customer.whatsapp}`,
      `${isAr ? 'المدينة' : 'Ville'} : ${customer.city}`,
      `${isAr ? 'العنوان' : 'Adresse'} : ${customer.address}`,
      customer.note ? `${isAr ? 'ملاحظة' : 'Note'} : ${customer.note}` : '',
      `${isAr ? 'المنتجات' : 'Articles'} : ${this.capturedItems()
        .map(
          (i) =>
            i.product.name +
            (i.variant ? ` (${i.variant.size} · ${i.variant.color})` : '') +
            ` x${i.quantity}`
        )
        .join(', ')}`,
      `${isAr ? 'المجموع' : 'Total'} : ${this.store.formatMAD(this.capturedSubtotal())}`,
      isAr ? 'الدفع: نقداً عند الاستلام' : 'Paiement : Espèces à la livraison',
    ].filter(Boolean);

    navigator.clipboard?.writeText(lines.join('\n'));
    this.copiedSummary.set(true);
    setTimeout(() => this.copiedSummary.set(false), 2500);
  }

  finishAndClose(): void {
    this.orderComplete.set(false);
    this.orderNumber.set('');
    this.orderError.set('');
    this.idempotencyKey.set('');
    this.capturedCustomer.set(null);
    this.checkoutForm.reset();
    this.store.checkoutOpen.set(false);
  }

  onEscape(): void {
    if (this.store.checkoutOpen()) {
      this.store.checkoutOpen.set(false);
    }
  }
}
