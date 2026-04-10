import { createDashboard } from "./lib/dashboard.js";

createDashboard().catch((error) => {
  console.error(error);
  const pill = document.querySelector("#connection-pill");
  const source = document.querySelector("#source-label");

  if (pill) {
    pill.textContent = "error";
    pill.className = "status-pill status-pill--error";
  }

  if (source) {
    source.textContent = error instanceof Error ? error.message : String(error);
  }
});