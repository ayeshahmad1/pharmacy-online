import type { RoleCode } from '@pharmacy/shared';
import { describe, expect, it } from 'vitest';
import { findNavItem, homePathFor, navForRole, navLabel } from './navigation';

const pathsFor = (role: RoleCode) =>
  navForRole(role).flatMap((section) => section.items.map((item) => item.path));

describe('role-based navigation', () => {
  it('shows a cashier only billing, their own sales, returns and offline sales', () => {
    expect(pathsFor('CASHIER')).toEqual(['/billing', '/sales', '/returns', '/offline-sales']);
    expect(navForRole('CASHIER').map((s) => s.title)).toEqual(['Counter']);
  });

  it('shows a pharmacist everything except user management', () => {
    const paths = pathsFor('PHARMACIST');
    expect(paths).toContain('/inventory');
    expect(paths).toContain('/reports');
    expect(paths).not.toContain('/users');
  });

  it('shows an admin every item', () => {
    expect(pathsFor('ADMIN')).toEqual([
      '/dashboard',
      '/billing',
      '/sales',
      '/returns',
      '/offline-sales',
      '/medicines',
      '/categories',
      '/inventory',
      '/suppliers',
      '/reports',
      '/users',
    ]);
  });

  it('labels sales as "My sales" for a cashier', () => {
    const sales = findNavItem('/sales')!;
    expect(navLabel(sales, 'CASHIER')).toBe('My sales');
    expect(navLabel(sales, 'ADMIN')).toBe('Sales');
  });

  it('sends cashiers to billing and staff to the dashboard after login', () => {
    expect(homePathFor('CASHIER')).toBe('/billing');
    expect(homePathFor('PHARMACIST')).toBe('/dashboard');
    expect(homePathFor('ADMIN')).toBe('/dashboard');
  });

  it('matches nested paths to their nav item', () => {
    expect(findNavItem('/medicines/123')?.path).toBe('/medicines');
    expect(findNavItem('/medicinesx')).toBeUndefined();
  });
});
