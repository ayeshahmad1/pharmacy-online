import {
  PASSWORD_MIN_LENGTH,
  resetPasswordBodySchema,
  type ResetPasswordBody,
  type UserDto,
} from '@pharmacy/shared';
import { useMutation } from '@tanstack/react-query';
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
import { errorMessage } from '@/lib/api';
import { parseForm, serverFieldErrors, type FieldErrors } from '@/lib/form';
import { usersApi } from './users-api';

/** Sets a new password for a user. The API also signs them out on every device. */
export function ResetPasswordDialog({
  user,
  isSelf,
  onClose,
}: {
  user: UserDto;
  isSelf: boolean;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const reset = useMutation({
    mutationFn: (body: ResetPasswordBody) => usersApi.resetPassword(user.id, body),
    meta: { skipErrorToast: true },
    onSuccess: () => {
      toast.success(`New password set for ${user.username}`);
      onClose();
    },
    onError: (err) => {
      const fields = serverFieldErrors(err);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFormError(errorMessage(err));
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = parseForm(resetPasswordBodySchema, { newPassword: password });
    const found: FieldErrors = parsed.ok ? {} : { ...parsed.errors };
    if (!found.newPassword && confirm !== password) found.confirm = 'The passwords do not match';
    setErrors(found);
    if (parsed.ok && Object.keys(found).length === 0) reset.mutate(parsed.data);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !reset.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reset password for {user.username}</DialogTitle>
          <DialogDescription>
            {isSelf
              ? 'You will be signed out on every device, including this one, and sign in again with the new password.'
              : `${user.fullName} is signed out on every device and signs in again with the new password. Tell them in person.`}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          {formError && <FormAlert>{formError}</FormAlert>}
          <Field
            id="reset-password"
            label="New password"
            error={errors.newPassword}
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
            required
          >
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
            />
          </Field>
          <Field id="reset-confirm" label="Repeat new password" error={errors.confirm} required>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={reset.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={reset.isPending}>
              {reset.isPending && <Loader2Icon className="animate-spin" />}
              Set new password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
