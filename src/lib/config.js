const defaultConfig = {
  network: "preprod",
  ws: "",
  geoEndpoint: "built-in",
  originLat: 51.5074,
  originLon: -0.1278,
  originLabel: "local-node"
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function defaultWsCandidates() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const hostname = window.location.hostname || "localhost";

  return unique([
    `${protocol}//${hostname}:8080/ws`,
    `${protocol}//127.0.0.1:8080/ws`,
    `${protocol}//${hostname}:8081/ws`,
    `${protocol}//127.0.0.1:8081/ws`,
    window.location.host ? `${protocol}//${window.location.host}/ws` : ""
  ]);
}

export function readRuntimeConfig() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const origin = params.get("origin");
  const [originLat, originLon] = origin ? origin.split(",").map(Number) : [defaultConfig.originLat, defaultConfig.originLon];
  const explicitWs = params.get("ws") || defaultConfig.ws;

  return {
    ...defaultConfig,
    network: params.get("network") || defaultConfig.network,
    ws: explicitWs,
    wsCandidates: explicitWs ? [explicitWs] : defaultWsCandidates(),
    geoEndpoint: params.get("geo") || defaultConfig.geoEndpoint,
    originLat: Number.isFinite(originLat) ? originLat : defaultConfig.originLat,
    originLon: Number.isFinite(originLon) ? originLon : defaultConfig.originLon,
    originLabel: params.get("originLabel") || defaultConfig.originLabel
  };
}

export function describeSource(config) {
  return config.ws || "probing local websocket endpoints";
}