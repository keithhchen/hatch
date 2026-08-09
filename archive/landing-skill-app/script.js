const canvas = document.getElementById("protocol-canvas");
const ctx = canvas.getContext("2d");

let width = 0;
let height = 0;
let pointer = { x: 0, y: 0, active: false };
let paths = [];

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const lens = { x: width * 0.5, y: height * 0.24 };
  const leftX = Math.max(42, width * 0.13);
  const rightX = Math.min(width - 42, width * 0.87);
  paths = [
    { side: "left", from: { x: leftX, y: lens.y - 78 }, via: { x: width * 0.32, y: lens.y - 128 }, to: lens, color: "143,176,201", phase: 0.0 },
    { side: "left", from: { x: leftX + 46, y: lens.y - 18 }, via: { x: width * 0.34, y: lens.y + 28 }, to: lens, color: "255,248,236", phase: 0.22 },
    { side: "left", from: { x: leftX + 10, y: lens.y + 58 }, via: { x: width * 0.32, y: lens.y + 118 }, to: lens, color: "217,173,104", phase: 0.44 },
    { side: "right", from: { x: rightX, y: lens.y - 70 }, via: { x: width * 0.68, y: lens.y - 122 }, to: lens, color: "217,90,58", phase: 0.12 },
    { side: "right", from: { x: rightX - 40, y: lens.y - 6 }, via: { x: width * 0.66, y: lens.y + 42 }, to: lens, color: "199,161,183", phase: 0.34 },
    { side: "right", from: { x: rightX - 8, y: lens.y + 70 }, via: { x: width * 0.68, y: lens.y + 126 }, to: lens, color: "217,173,104", phase: 0.56 },
  ];
}

function tick() {
  const now = Date.now() * 0.001;
  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#2b1d17");
  gradient.addColorStop(0.5, "#17120f");
  gradient.addColorStop(1, "#312016");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const lens = { x: width * 0.5, y: height * 0.24 };
  const breathe = 0.5 + Math.sin(now * 1.1) * 0.5;
  const driftX = pointer.active ? (pointer.x - width * 0.5) * 0.018 : 0;
  const driftY = pointer.active ? (pointer.y - height * 0.24) * 0.012 : 0;

  if (width > 700) {
    ctx.font = "500 12px Geist, Inter, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 248, 236, 0.42)";
    ctx.letterSpacing = "2px";
    ctx.fillText("USER CONTEXT", Math.max(42, width * 0.13), Math.max(90, height * 0.13));
    ctx.fillText("CREATOR", Math.min(width - 112, width * 0.83), Math.max(90, height * 0.13));
  }

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  paths.forEach((path, index) => {
    const wobble = Math.sin(now * 0.75 + index) * 18;
    const to = { x: lens.x + driftX, y: lens.y + driftY };
    const via = {
      x: path.via.x + Math.sin(now * 0.55 + index * 0.8) * 10,
      y: path.via.y + wobble,
    };

    const opacity = 0.22 + breathe * 0.18;
    ctx.strokeStyle = `rgba(${path.color}, ${opacity})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(path.from.x, path.from.y);
    ctx.quadraticCurveTo(via.x, via.y, to.x, to.y);
    ctx.stroke();

    const t = (now * 0.065 + path.phase) % 1;
    const x = (1 - t) * (1 - t) * path.from.x + 2 * (1 - t) * t * via.x + t * t * to.x;
    const y = (1 - t) * (1 - t) * path.from.y + 2 * (1 - t) * t * via.y + t * t * to.y;
    ctx.fillStyle = `rgba(${path.color}, ${0.26 + breathe * 0.28})`;
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.restore();

  const glowX = lens.x + driftX;
  const glowY = lens.y + driftY;
  ctx.save();
  ctx.globalCompositeOperation = "screen";

  const outerRadius = 118 + breathe * 10;
  const outerGlow = ctx.createRadialGradient(glowX, glowY, 18, glowX, glowY, outerRadius);
  outerGlow.addColorStop(0, `rgba(255, 248, 236, ${0.18 + breathe * 0.04})`);
  outerGlow.addColorStop(0.34, `rgba(217, 173, 104, ${0.12 + breathe * 0.04})`);
  outerGlow.addColorStop(0.72, "rgba(143, 176, 201, 0.045)");
  outerGlow.addColorStop(1, "rgba(217, 173, 104, 0)");
  ctx.fillStyle = outerGlow;
  ctx.beginPath();
  ctx.arc(glowX, glowY, outerRadius, 0, Math.PI * 2);
  ctx.fill();

  const innerGlow = ctx.createRadialGradient(glowX - 10, glowY - 12, 0, glowX, glowY, 48);
  innerGlow.addColorStop(0, "rgba(255, 248, 236, 0.34)");
  innerGlow.addColorStop(0.42, "rgba(217, 173, 104, 0.16)");
  innerGlow.addColorStop(1, "rgba(217, 173, 104, 0)");
  ctx.fillStyle = innerGlow;
  ctx.beginPath();
  ctx.arc(glowX, glowY, 52, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(255, 248, 236, ${0.055 + breathe * 0.025})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(glowX, glowY, 64 + breathe * 2, Math.PI * 1.12, Math.PI * 1.86);
  ctx.stroke();
  ctx.restore();

  requestAnimationFrame(tick);
}

window.addEventListener("resize", resize);
window.addEventListener("pointermove", (event) => {
  pointer = { x: event.clientX, y: event.clientY, active: true };
});
window.addEventListener("pointerleave", () => {
  pointer.active = false;
});

resize();
tick();
