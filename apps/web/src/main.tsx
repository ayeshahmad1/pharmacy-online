import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { PwaUpdatePrompt } from '@/components/pwa-update-prompt';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/features/auth/auth-provider';
import { installGlobalErrorHandlers, reportError } from '@/lib/error-reporting';
import { queryClient } from '@/lib/query-client';
import { router } from '@/router';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

installGlobalErrorHandlers();

createRoot(root, {
  // Both still log to the console, as React does by default.
  onUncaughtError: (error, info) => {
    console.error(error, info.componentStack);
    reportError(error, 'react');
  },
  onCaughtError: (error, info) => {
    console.error(error, info.componentStack);
    reportError(error, 'react-boundary');
  },
}).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
        <Toaster position="top-right" richColors closeButton />
        <PwaUpdatePrompt />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
