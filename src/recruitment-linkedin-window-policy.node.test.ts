import { describe, expect, it } from "vitest";
import {
  buildLinkedInAutomationPopupFeatures,
  shouldFocusLinkedInAutomationPage,
} from "../skills/head-hunter/scripts/linkedin-window-policy.mjs";

describe("LinkedIn automation window policy", () => {
  it("does not focus automation pages by default", () => {
    expect(shouldFocusLinkedInAutomationPage({ manual: false })).toBe(false);
  });

  it("focuses only manual login/open-browser actions", () => {
    expect(shouldFocusLinkedInAutomationPage({ manual: true })).toBe(true);
  });

  it("opens a small desktop popup for automation", () => {
    const features = buildLinkedInAutomationPopupFeatures();

    expect(features).toContain("popup=yes");
    expect(features).toContain("width=560");
    expect(features).toContain("height=760");
    expect(features).toContain("left=");
    expect(features).toContain("top=");
  });
});
