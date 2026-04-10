// Full-screen confetti + synthesised sound burst for epoch crossing events.

const DURATION_MS = 5000;
const PARTICLE_COUNT = 160;

const COLORS = [
  "#4a84ff", // cobalt
  "#ffcc33", // yellow
  "#62d700", // acid
  "#f3a1cc", // pink
  "#ff6b6b", // danger
  "#05205f", // ink
  "#f1efe7", // cream
];

// ── Sound ─────────────────────────────────────────────────────────────────────

function playFanfare() {
  let ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    return;
  }

  // A short ascending chord burst: root + major third + fifth, then octave
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  const startTime = ctx.currentTime;

  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, startTime + i * 0.08);

    gain.gain.setValueAtTime(0, startTime + i * 0.08);
    gain.gain.linearRampToValueAtTime(0.18, startTime + i * 0.08 + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + i * 0.08 + 0.45);

    osc.start(startTime + i * 0.08);
    osc.stop(startTime + i * 0.08 + 0.5);
  });

  // Soft noise burst on the downbeat for texture
  const bufferSize = ctx.sampleRate * 0.15;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let j = 0; j < bufferSize; j++) data[j] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.06, startTime);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.15);
  noise.connect(noiseGain);
  noiseGain.connect(ctx.destination);
  noise.start(startTime);

  // Close context after everything has played
  setTimeout(() => ctx.close(), 1500);
}

// ── Confetti ──────────────────────────────────────────────────────────────────

function randomBetween(a, b) {
  return a + Math.random() * (b - a);
}

function makeParticle(canvasWidth, canvasHeight) {
  return {
    x: randomBetween(0, canvasWidth),
    y: randomBetween(-canvasHeight * 0.2, -10),
    vx: randomBetween(-2.5, 2.5),
    vy: randomBetween(2, 7),
    angle: randomBetween(0, Math.PI * 2),
    spin: randomBetween(-0.15, 0.15),
    size: randomBetween(7, 14),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    shape: Math.random() < 0.5 ? "rect" : "circle",
    // ribbon vs square
    aspect: Math.random() < 0.4 ? randomBetween(0.2, 0.4) : 1,
  };
}

function runConfetti(canvas) {
  const ctx = canvas.getContext("2d");
  let particles = Array.from({ length: PARTICLE_COUNT }, () =>
    makeParticle(canvas.width, canvas.height)
  );
  let startTime = null;
  let rafId;

  function step(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = timestamp - startTime;
    const progress = Math.min(elapsed / DURATION_MS, 1);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Global fade-out in the last 20%
    const alpha = progress > 0.8 ? 1 - (progress - 0.8) / 0.2 : 1;

    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.spin;
      p.vy += 0.12; // gravity

      // Respawn near the top if still early in animation
      if (p.y > canvas.height + 20 && progress < 0.7) {
        Object.assign(p, makeParticle(canvas.width, canvas.height));
      }

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;

      if (p.shape === "circle") {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(
          -p.size / 2,
          -(p.size * p.aspect) / 2,
          p.size,
          p.size * p.aspect
        );
      }
      ctx.restore();
    });

    if (progress < 1) {
      rafId = requestAnimationFrame(step);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  rafId = requestAnimationFrame(step);
  return () => cancelAnimationFrame(rafId);
}

// ── Public API ────────────────────────────────────────────────────────────────

let _cancelConfetti = null;
let _hideTimer = null;

export function triggerEpochCelebration(epochNumber) {
  const overlay = document.getElementById("epoch-celebration");
  const canvas = document.getElementById("epoch-confetti-canvas");
  const label = document.getElementById("epoch-celebration-number");
  if (!overlay || !canvas || !label) return;

  // Cancel any previous running celebration
  if (_cancelConfetti) _cancelConfetti();
  clearTimeout(_hideTimer);

  // Size canvas to match viewport
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  label.textContent = epochNumber;
  overlay.hidden = false;
  overlay.classList.remove("epoch-celebration--fadeout");

  playFanfare();
  _cancelConfetti = runConfetti(canvas);

  // Start fade-out 500 ms before hiding
  _hideTimer = setTimeout(() => {
    overlay.classList.add("epoch-celebration--fadeout");
    setTimeout(() => {
      overlay.hidden = true;
      overlay.classList.remove("epoch-celebration--fadeout");
    }, 500);
  }, DURATION_MS - 500);
}
