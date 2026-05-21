const DEFAULT_AUTOMATION_WIDTH = 560;
const DEFAULT_AUTOMATION_HEIGHT = 760;
const DEFAULT_AUTOMATION_LEFT = 40;
const DEFAULT_AUTOMATION_TOP = 80;

function envFlag(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function envNumber(name, defaultValue) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultValue;
}

export function shouldFocusLinkedInAutomationPage({ manual = false } = {}) {
  if (manual) return true;
  return envFlag("LINKEDIN_AUTOMATION_FOCUS", false);
}

export function buildLinkedInAutomationPopupFeatures() {
  const width = envNumber("LINKEDIN_AUTOMATION_WIDTH", DEFAULT_AUTOMATION_WIDTH);
  const height = envNumber("LINKEDIN_AUTOMATION_HEIGHT", DEFAULT_AUTOMATION_HEIGHT);
  const left = envNumber("LINKEDIN_AUTOMATION_LEFT", DEFAULT_AUTOMATION_LEFT);
  const top = envNumber("LINKEDIN_AUTOMATION_TOP", DEFAULT_AUTOMATION_TOP);

  return ["popup=yes", `width=${width}`, `height=${height}`, `left=${left}`, `top=${top}`].join(
    ",",
  );
}
