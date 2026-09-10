// Reopen even when EventSource treats an HTTP error as terminal. Callers read
// canonical state on open, since events may have been missed during a deploy.
export function subscribeFactoryEvents({ url, onMessage, onOpen, onError }) {
  let disposed = false;
  let stream;
  let retry;
  const connect = () => {
    if (disposed) return;
    stream = new EventSource(url);
    stream.onmessage = onMessage;
    stream.onopen = onOpen;
    stream.onerror = () => {
      stream.onmessage = stream.onopen = stream.onerror = null;
      stream.close();
      onError?.();
      if (!disposed) retry = setTimeout(connect, 2000);
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
