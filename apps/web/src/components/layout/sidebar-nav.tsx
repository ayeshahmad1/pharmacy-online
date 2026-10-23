import { NavLink } from 'react-router';
import { BrandMark } from '@/components/brand-mark';
import { useCurrentUser } from '@/features/auth/auth-context';
import { navForRole, navLabel } from '@/lib/navigation';
import { cn } from '@/lib/utils';

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const user = useCurrentUser();

  return (
    <div className="flex h-full flex-col text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4">
        <BrandMark />
        <span className="font-semibold">Pharmacy POS</span>
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto p-3" aria-label="Main">
        {navForRole(user.role).map((section) => (
          <div key={section.title}>
            <p className="mb-1 px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {section.title}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        isActive
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'hover:bg-sidebar-accent/60',
                      )
                    }
                  >
                    <item.icon className="size-5 shrink-0" />
                    {navLabel(item, user.role)}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
