import {
  createUserBodySchema,
  PASSWORD_MIN_LENGTH,
  ROLE_CODES,
  updateUserBodySchema,
  type RoleCode,
  type UserDto,
} from '@pharmacy/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2Icon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Field, FormAlert } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { useCurrentUser } from '@/features/auth/auth-context';
import { errorMessage } from '@/lib/api';
import { parseForm, type FieldErrors } from '@/lib/form';
import {
  changedFields,
  createUserInput,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  selfGuards,
  updateUserInput,
  userFormErrors,
  type UserFormValues,
} from './user-rules';
import { usersApi, usersKeys } from './users-api';

/** Create (user = null) or edit a user's name, email and role. Mount with a `key` per record. */
export function UserFormDialog({ user, onClose }: { user: UserDto | null; onClose: () => void }) {
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const guards = user ? selfGuards(user, me) : null;
  const [values, setValues] = useState<UserFormValues>({
    username: user?.username ?? '',
    fullName: user?.fullName ?? '',
    email: user?.email ?? '',
    role: user?.role ?? 'CASHIER',
    password: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    // Create and update parse different schemas; each passes its own typed call.
    mutationFn: (send: () => Promise<UserDto>) => send(),
    meta: { skipErrorToast: true },
    onSuccess: async (saved) => {
      toast.success(
        user ? `Saved ${saved.fullName}` : `Added ${saved.fullName} (${saved.username})`,
      );
      onClose();
      await queryClient.invalidateQueries({ queryKey: usersKeys.all });
    },
    onError: (err) => {
      const fields = userFormErrors(err);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFormError(errorMessage(err));
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (!user) {
      const parsed = parseForm(createUserBodySchema, createUserInput(values));
      if (!parsed.ok) return setErrors(parsed.errors);
      setErrors({});
      return save.mutate(() => usersApi.create(parsed.data));
    }
    const parsed = parseForm(updateUserBodySchema, updateUserInput(values));
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors({});
    const changes = changedFields(user, parsed.data);
    if (Object.keys(changes).length === 0) {
      toast.info('No changes to save');
      return onClose();
    }
    save.mutate(() => usersApi.update(user.id, changes));
  }

  const input = (field: keyof UserFormValues) => ({
    value: values[field],
    onChange: (e: { target: { value: string } }) =>
      setValues((v) => ({ ...v, [field]: e.target.value })),
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{user ? `Edit ${user.username}` : 'New user'}</DialogTitle>
          <DialogDescription>
            {user
              ? 'Name, email and role. Use “Reset password” to set a new password.'
              : 'They sign in with this username and password; ask them to keep it private.'}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={handleSubmit} noValidate>
          {formError && <FormAlert>{formError}</FormAlert>}
          {!user && (
            <Field
              id="user-username"
              label="Username"
              error={errors.username}
              hint="Lowercase letters, digits, dot, dash or underscore. Cannot be changed later."
              required
            >
              <Input
                {...input('username')}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
              />
            </Field>
          )}
          <Field id="user-fullname" label="Full name" error={errors.fullName} required>
            <Input {...input('fullName')} autoComplete="off" autoFocus={!!user} />
          </Field>
          <Field id="user-email" label="Email" error={errors.email}>
            <Input {...input('email')} type="email" autoComplete="off" />
          </Field>
          <Field
            id="user-role"
            label="Role"
            error={errors.role}
            hint={guards?.roleLocked ?? ROLE_DESCRIPTIONS[values.role]}
            required
          >
            <NativeSelect
              value={values.role}
              onChange={(e) => setValues((v) => ({ ...v, role: e.target.value as RoleCode }))}
              disabled={!!guards?.roleLocked}
            >
              {ROLE_CODES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {!user && (
            <Field
              id="user-password"
              label="Password"
              error={errors.password}
              hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
              required
            >
              <Input {...input('password')} type="password" autoComplete="new-password" />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2Icon className="animate-spin" />}
              {user ? 'Save changes' : 'Add user'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
