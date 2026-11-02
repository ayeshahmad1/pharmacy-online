import { ROLE_CODES, type RoleCode } from '@pharmacy/shared';
import {
  ArchiveIcon,
  BarChart3Icon,
  BellIcon,
  BoxesIcon,
  CloudOffIcon,
  LayoutDashboardIcon,
  PillIcon,
  ReceiptTextIcon,
  ScanBarcodeIcon,
  TagsIcon,
  TruckIcon,
  Undo2Icon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';

// Mirrors the server's role rules (CLAUDE.md rule 9). The server enforces
// them; this only decides what the user is shown.
export const ALL_ROLES: readonly RoleCode[] = ROLE_CODES;
export const STAFF_ROLES: readonly RoleCode[] = ['ADMIN', 'PHARMACIST'];
export const ADMIN_ONLY: readonly RoleCode[] = ['ADMIN'];

export type NavItem = {
  path: string;
  label: string;
  /** Shown instead of `label` to a CASHIER, who only sees their own records. */
  cashierLabel?: string;
  icon: LucideIcon;
  roles: readonly RoleCode[];
};

export type NavSection = { title: string; items: NavItem[] };

export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Counter',
    items: [
      { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboardIcon, roles: STAFF_ROLES },
      { path: '/billing', label: 'Billing', icon: ScanBarcodeIcon, roles: ALL_ROLES },
      {
        path: '/sales',
        label: 'Sales',
        cashierLabel: 'My sales',
        icon: ReceiptTextIcon,
        roles: ALL_ROLES,
      },
      { path: '/returns', label: 'Returns', icon: Undo2Icon, roles: ALL_ROLES },
      {
        path: '/offline-sales',
        label: 'Offline sales',
        cashierLabel: 'My offline sales',
        icon: CloudOffIcon,
        roles: ALL_ROLES,
      },
    ],
  },
  {
    title: 'Stock',
    items: [
      { path: '/medicines', label: 'Medicines', icon: PillIcon, roles: STAFF_ROLES },
      { path: '/categories', label: 'Categories', icon: TagsIcon, roles: STAFF_ROLES },
      { path: '/inventory', label: 'Inventory', icon: BoxesIcon, roles: STAFF_ROLES },
      { path: '/suppliers', label: 'Suppliers', icon: TruckIcon, roles: STAFF_ROLES },
      // Everyone sees low-stock and expiry alerts; only staff mark them seen.
      { path: '/alerts', label: 'Alerts', icon: BellIcon, roles: ALL_ROLES },
    ],
  },
  {
    title: 'Admin',
    items: [
      { path: '/reports', label: 'Reports', icon: BarChart3Icon, roles: STAFF_ROLES },
      // Returns and deliveries loaded from the old system (rule 15), read-only.
      { path: '/old-records', label: 'Old system records', icon: ArchiveIcon, roles: STAFF_ROLES },
      { path: '/users', label: 'Users', icon: UsersIcon, roles: ADMIN_ONLY },
    ],
  },
];

/** The sections and items a role may see; empty sections are dropped. */
export function navForRole(role: RoleCode): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.roles.includes(role)),
  })).filter((section) => section.items.length > 0);
}

export function navLabel(item: NavItem, role: RoleCode) {
  return role === 'CASHIER' && item.cashierLabel ? item.cashierLabel : item.label;
}

/** Where a user lands after login: cashiers go straight to the till. */
export function homePathFor(role: RoleCode) {
  return role === 'CASHIER' ? '/billing' : '/dashboard';
}

export function findNavItem(pathname: string): NavItem | undefined {
  return NAV_SECTIONS.flatMap((s) => s.items).find(
    (item) => pathname === item.path || pathname.startsWith(`${item.path}/`),
  );
}
