import type { RecordStatus } from '@pharmacy/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { invalidateAfterCatalogWrite } from './catalog-api';

export type ActivationTarget = { id: string; name: string; status: RecordStatus };

const CONSEQUENCES = {
  medicine: 'It will no longer be sold at the counter or received into stock. Its history is kept.',
  category: 'New medicines cannot be added to it. Existing medicines keep it.',
  supplier: 'Stock can no longer be received from it. Earlier deliveries are kept.',
};

/**
 * Confirms deactivating (or re-activating) a catalogue record. Nothing is
 * ever deleted, so a deactivated record can always be brought back.
 */
export function ActivationDialog({
  entity,
  target,
  onClose,
  setActive,
}: {
  entity: 'medicine' | 'category' | 'supplier';
  target: ActivationTarget | null;
  onClose: () => void;
  setActive: (id: string, active: boolean) => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const activate = target?.status === 'INACTIVE';
  const mutation = useMutation({
    mutationFn: (t: ActivationTarget) => setActive(t.id, t.status === 'INACTIVE'),
    onSuccess: async (_data, t) => {
      toast.success(`${t.name} ${t.status === 'INACTIVE' ? 'activated' : 'deactivated'}`);
      onClose();
      await invalidateAfterCatalogWrite(queryClient, entity);
    },
  });

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`${activate ? 'Activate' : 'Deactivate'} ${target?.name ?? ''}?`}
      description={
        activate ? `It will be available again as an active ${entity}.` : CONSEQUENCES[entity]
      }
      confirmLabel={activate ? 'Activate' : 'Deactivate'}
      destructive={!activate}
      pending={mutation.isPending}
      onConfirm={() => target && mutation.mutate(target)}
    />
  );
}
