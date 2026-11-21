import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/storefront/storefront').then((m) => m.Storefront),
    title: 'MOKIKO SPORT — Vêtements de Sport & Performance',
  },
  {
    path: 'admin',
    loadComponent: () =>
      import('./pages/admin/admin-page').then((m) => m.AdminPage),
    title: 'MOKIKO SPORT — Administration',
  },
  {
    path: '**',
    redirectTo: '',
  },
];
