import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles/theme.css';
import './styles/base.css';

/**
 * One cache for the tab.
 *
 * `staleTime` is short because the SSE stream is the real freshness mechanism — a frame
 * invalidates what it touched, and this only bounds how long a query that *nobody* pushed an
 * event for can be reused. `retry: 1` is one retry, not the default three: a request that
 * failed twice is more likely to be a real refusal than a blip, and three attempts turn a
 * broken page into a six-second wait before it says so.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
      // A reconnect is exactly when the client has missed frames — the stream contract is
      // "refetch via REST, then resume" — so this is the safety net, not a duplicate.
      refetchOnReconnect: true,
    },
  },
});

const container = document.getElementById('root');
if (container === null) {
  // A missing mount point means index.html and this bundle disagree. Failing here names the
  // reason; rendering nothing would leave a blank page and no clue.
  throw new Error('index.html has no #root element to mount into');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
