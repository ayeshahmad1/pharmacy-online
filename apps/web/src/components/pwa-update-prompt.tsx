import { useEffect } from 'react';
import { toast } from 'sonner';
import { useRegisterSW } from 'virtual:pwa-register/react';

const UPDATE_TOAST_ID = 'pwa-update';

/**
 * Registers the service worker and, when a new version has been downloaded,
 * offers a reload instead of reloading on its own (which could drop a cart).
 */
export function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    if (!needRefresh) return;
    toast.info('A new version of the app is available.', {
      id: UPDATE_TOAST_ID,
      duration: Infinity,
      action: { label: 'Reload', onClick: () => void updateServiceWorker(true) },
    });
  }, [needRefresh, updateServiceWorker]);

  return null;
}
