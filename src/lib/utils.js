export function truncateMiddle(value, start = 10, end = 8) {
  if (!value) {
    return "--";
  }

  if (value.length <= start + end + 3) {
    return value;
  }

  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function toAttributesObject(attributes = []) {
  return Object.fromEntries(attributes);
}

export function now() {
  return Date.now();
}

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function hashString(input) {
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

export function sparklinePath(values, width, height) {
  if (!values.length) return { line: "", area: "" };

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;

  const pts = values.map((v, i) => ({
    x: (i / Math.max(1, values.length - 1)) * width,
    y: pad + (1 - (v - min) / span) * (height - pad * 2)
  }));

  // smooth cubic bezier through points
  const lineParts = pts.map((p, i) => {
    if (i === 0) return `M${p.x.toFixed(2)},${p.y.toFixed(2)}`;
    const prev = pts[i - 1];
    const cpx = (prev.x + p.x) / 2;
    return `C${cpx.toFixed(2)},${prev.y.toFixed(2)} ${cpx.toFixed(2)},${p.y.toFixed(2)} ${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  });

  const line = lineParts.join(" ");
  const last = pts[pts.length - 1];
  const first = pts[0];
  const area = `${line} L${last.x.toFixed(2)},${height} L${first.x.toFixed(2)},${height} Z`;

  return { line, area };
}

export function formatRelativeAge(timestamp) {
  const delta = Math.max(0, now() - timestamp);
  const seconds = Math.floor(delta / 1000);

  if (seconds < 1) {
    return "now";
  }

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}