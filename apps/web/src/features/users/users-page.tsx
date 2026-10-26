import { ROLE_CODES, type UserDto } from '@pharmacy/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, PencilIcon, PlusIcon, PowerIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import {
  ListToolbar,
  PageIntro,
  STATUS_FILTER_DEFAULT,
  StatusFilter,
  statusQuery,
} from '@/components/data/filters';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { RowActions } from '@/components/data/row-actions';
import { SearchInput } from '@/components/data/search-input';
import { RecordStatusBadge } from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCurrentUser } from '@/features/auth/auth-context';
import { formatDateTime } from '@/lib/format';
import { useListParams } from '@/lib/list-params';
import { ResetPasswordDialog } from './reset-password-dialog';
import { UserFormDialog } from './user-form-dialog';
import { ROLE_LABELS, selfGuards } from './user-rules';
import { usersApi, usersKeys } from './users-api';

/** Staff accounts (ADMIN only). Users are never deleted, only deactivated. */
export function UsersPage() {
  const me = useCurrentUser();
  const { params, update } = useListParams(['role', 'status'], { status: STATUS_FILTER_DEFAULT });
  const query = {
    q: params.q || undefined,
    role: ROLE_CODES.find((r) => r === params.filters.role),
    status: statusQuery(params.filters.status),
    page: params.page,
    pageSize: params.pageSize,
  };
  const users = useQuery({
    queryKey: usersKeys.list(query),
    queryFn: ({ signal }) => usersApi.list(query, signal),
    placeholderData: keepPreviousData,
  });

  const [formTarget, setFormTarget] = useState<UserDto | 'new' | null>(null);
  const [resetting, setResetting] = useState<UserDto | null>(null);
  const [activation, setActivation] = useState<UserDto | null>(null);
  const filtered =
    !!params.q || params.filters.role !== '' || params.filters.status !== STATUS_FILTER_DEFAULT;

  return (
    <div className="space-y-4">
      <PageIntro description="Who can sign in, and what they may do. Deactivated users cannot sign in; their sales and records are kept." />
      <ListToolbar
        actions={
          <Button onClick={() => setFormTarget('new')}>
            <PlusIcon /> New user
          </Button>
        }
      >
        <SearchInput
          value={params.q}
          onChange={(q) => update({ q }, { replace: true })}
          placeholder="Search username or name"
          className="sm:w-72"
        />
        <NativeSelect
          value={params.filters.role}
          onChange={(e) => update({ role: e.target.value })}
          aria-label="Role"
          className="w-full sm:w-40"
        >
          <option value="">All roles</option>
          {ROLE_CODES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </NativeSelect>
        <StatusFilter value={params.filters.status} onChange={(status) => update({ status })} />
      </ListToolbar>

      <ListView
        query={users}
        filtered={filtered}
        onClearFilters={() => update({ q: '', role: '', status: STATUS_FILTER_DEFAULT })}
        onFirstPage={() => update({ page: 1 })}
        columns={5}
        empty={
          <EmptyState
            icon={UsersIcon}
            title="No users yet"
            description="Add a login for each pharmacist and cashier."
            action={
              <Button onClick={() => setFormTarget('new')}>
                <PlusIcon /> New user
              </Button>
            }
          />
        }
      >
        {(data) => (
          <div className="space-y-3">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead className="hidden lg:table-cell">Email</TableHead>
                    <TableHead className="hidden md:table-cell">Last sign-in</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((user) => {
                    const guards = selfGuards(user, me);
                    return (
                      <TableRow key={user.id}>
                        <TableCell>
                          <div className="flex items-center gap-2 font-medium">
                            {user.fullName}
                            {guards.isSelf && <Badge variant="outline">You</Badge>}
                          </div>
                          <p className="font-mono text-xs text-muted-foreground">{user.username}</p>
                        </TableCell>
                        <TableCell>{ROLE_LABELS[user.role]}</TableCell>
                        <TableCell className="hidden lg:table-cell">{user.email ?? '—'}</TableCell>
                        <TableCell className="hidden whitespace-nowrap md:table-cell">
                          {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}
                        </TableCell>
                        <TableCell>
                          <RecordStatusBadge status={user.status} />
                        </TableCell>
                        <TableCell>
                          <RowActions label={`Actions for ${user.username}`}>
                            <DropdownMenuItem onSelect={() => setFormTarget(user)}>
                              <PencilIcon /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setResetting(user)}>
                              <KeyRoundIcon /> Reset password
                            </DropdownMenuItem>
                            {user.status === 'INACTIVE' ? (
                              <DropdownMenuItem onSelect={() => setActivation(user)}>
                                <PowerIcon /> Activate
                              </DropdownMenuItem>
                            ) : guards.deactivateLocked ? (
                              <DropdownMenuItem disabled className="flex-col items-start gap-0.5">
                                <span className="flex items-center gap-2">
                                  <PowerIcon /> Deactivate
                                </span>
                                <span className="text-xs">{guards.deactivateLocked}</span>
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setActivation(user)}
                              >
                                <PowerIcon /> Deactivate
                              </DropdownMenuItem>
                            )}
                          </RowActions>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPageChange={(page) => update({ page })}
              onPageSizeChange={(pageSize) => update({ pageSize })}
            />
          </div>
        )}
      </ListView>

      {formTarget && (
        <UserFormDialog
          key={formTarget === 'new' ? 'new' : formTarget.id}
          user={formTarget === 'new' ? null : formTarget}
          onClose={() => setFormTarget(null)}
        />
      )}
      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          isSelf={resetting.id === me.id}
          onClose={() => setResetting(null)}
        />
      )}
      <UserActivationDialog target={activation} onClose={() => setActivation(null)} />
    </div>
  );
}

function UserActivationDialog({
  target,
  onClose,
}: {
  target: UserDto | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const activate = target?.status === 'INACTIVE';
  const mutation = useMutation({
    mutationFn: (user: UserDto) => usersApi.setActive(user.id, user.status === 'INACTIVE'),
    onSuccess: async (saved) => {
      toast.success(`${saved.username} ${saved.status === 'ACTIVE' ? 'activated' : 'deactivated'}`);
      onClose();
      await queryClient.invalidateQueries({ queryKey: usersKeys.all });
    },
  });

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`${activate ? 'Activate' : 'Deactivate'} ${target?.username ?? ''}?`}
      description={
        activate
          ? 'They can sign in again with their current password.'
          : 'They are signed out on every device and can no longer sign in. Their sales, returns and history are kept, and you can activate them again.'
      }
      confirmLabel={activate ? 'Activate' : 'Deactivate'}
      destructive={!activate}
      pending={mutation.isPending}
      onConfirm={() => target && mutation.mutate(target)}
    />
  );
}
