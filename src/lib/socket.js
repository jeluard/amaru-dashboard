function emitParsed(rawData, onMessage) {
  const chunks = String(rawData)
    .split(/\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    try {
      onMessage(JSON.parse(chunk));
    } catch (error) {
      console.warn("Failed to parse message chunk", chunk, error);
    }
  }
}

function openSocket(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url);

    const finish = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timer);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
      callback();
    };

    const handleOpen = () => finish(() => resolve(socket));
    const handleError = () => finish(() => reject(new Error("socket error")));
    const handleClose = (event) => finish(() => reject(new Error(`socket closed (${event.code})`)));

    const timer = window.setTimeout(() => {
      finish(() => {
        try {
          socket.close();
        } catch {
          // Ignore close failures during timeout cleanup.
        }
        reject(new Error("socket timeout"));
      });
    }, timeoutMs);

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);
  });
}

function wait(delayMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

export function connectToStream(config, handlers) {
  const { onMessage, onState } = handlers;
  const endpoints = [...new Set([config.ws, ...(config.wsCandidates || [])].filter(Boolean))];
  const retryDelayMs = 1500;
  let socket = null;
  let stopped = false;

  const start = async () => {
    onState({ kind: "connecting", label: endpoints.length ? endpoints[0] : "no websocket endpoint configured" });

    while (!stopped) {
      let lastError = "";

      for (const endpoint of endpoints) {
        if (stopped) {
          return;
        }

        onState({ kind: "connecting", label: `trying ${endpoint}` });

        try {
          socket = await openSocket(endpoint);

          if (stopped) {
            socket.close();
            return;
          }

          onState({ kind: "live", label: endpoint });

          await new Promise((resolve) => {
            const activeSocket = socket;
            let settled = false;

            const finish = () => {
              if (settled) {
                return;
              }

              settled = true;
              activeSocket.removeEventListener("message", handleMessage);
              activeSocket.removeEventListener("close", handleClose);
              activeSocket.removeEventListener("error", handleError);
              resolve();
            };

            const handleMessage = ({ data }) => {
              emitParsed(data, onMessage);
            };

            const handleClose = () => {
              socket = null;
              if (!stopped) {
                onState({ kind: "connecting", label: `disconnected from ${endpoint}, retrying...` });
              }
              finish();
            };

            const handleError = () => {
              socket = null;
              if (!stopped) {
                onState({ kind: "connecting", label: `stream error on ${endpoint}, retrying...` });
              }

              try {
                activeSocket.close();
              } catch {
                // Ignore close failures during reconnect.
              }

              finish();
            };

            activeSocket.addEventListener("message", handleMessage);
            activeSocket.addEventListener("close", handleClose);
            activeSocket.addEventListener("error", handleError);
          });
        } catch (error) {
          lastError = `${endpoint} (${error.message})`;
        }
      }

      if (!stopped) {
        onState({ kind: "connecting", label: lastError ? `retrying localhost endpoints after ${lastError}` : "retrying localhost endpoints" });
        await wait(retryDelayMs);
      }
    }
  };

  start().catch((error) => {
    onState({ kind: "error", label: error.message || "stream error" });
  });

  return () => {
    stopped = true;
    if (socket) {
      socket.close();
    }
  };
}