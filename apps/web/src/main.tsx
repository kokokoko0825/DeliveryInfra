import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { App } from './router';
import { TooltipProvider } from './components/ui/tooltip';
import { Toaster } from './components/ui/sonner';
import { AuthProvider } from './features/auth/AuthProvider';
import { AppErrorBoundary } from './components/app/AppErrorBoundary';
import { installGlobalErrorHandlers } from './lib/diagnostics';
import './lib/zod-ja';
import './index.css';

installGlobalErrorHandlers();
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } });
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppErrorBoundary>
            <AuthProvider>
              <TooltipProvider><App /></TooltipProvider>
            </AuthProvider>
          </AppErrorBoundary>
        </BrowserRouter>
        <Toaster position="top-center" />
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
