import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './router';
import { TooltipProvider } from './components/ui/tooltip';
import './index.css';

const queryClient = new QueryClient();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><QueryClientProvider client={queryClient}><BrowserRouter><TooltipProvider><App /></TooltipProvider></BrowserRouter></QueryClientProvider></React.StrictMode>,
);
