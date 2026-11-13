// Reopen even when EventSource treats an HTTP error as terminal. Callers read
// canonical state on open, since events may have been missed during a deploy.
export function subscribeFactoryEvents({ url, onMessage, onOpen, onError }) {
  let disposed = false;
  let stream;
  let retry;
  let attempt = 0;
  const connect = () => {
    if (disposed) return;
    stream = new EventSource(url);
    stream.onmessage = onMessage;
    stream.onopen = () => { attempt = 0; onOpen?.(); };
    stream.onerror = () => {
      stream.onmessage = stream.onopen = stream.onerror = null;
      stream.close();
      onError?.();
      // Silent retries, without end: 2 s, doubling to 30 s.
      if (!disposed) retry = setTimeout(connect, Math.min(30_000, 2000 * 2 ** attempt++));
    };
  };
  connect();
  return () => {
    disposed = true;
    clearTimeout(retry);
    stream.onmessage = stream.onopen = stream.onerror = null;
    stream.close();
  };
}
