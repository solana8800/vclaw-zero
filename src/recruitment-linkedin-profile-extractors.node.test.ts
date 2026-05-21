import { describe, expect, it } from "vitest";
import {
  applyLinkedInProfileExtractionTemplate,
  extractProfileBasicsFromText,
  extractProfileSectionItemsFromText,
  extractProfileSectionTextFromText,
} from "../skills/head-hunter/scripts/linkedin-profile-extractors.mjs";

const PROFILE_TEXT = [
  "Tuan Tran · 1st",
  "Solutions Architect @ Sun Group | GenAI, Agentic AI",
  "Hanoi Capital Region · Contact info",
  "Sun Group",
  "FPT University",
  "Message",
  "Highlights",
  "Tuan is a new connection",
  "About",
  "Sun Group relies on a Solutions Architect with over nine years of experience in software development.",
  "Previous roles at XanhSM and VinBigdata honed their skills in backend architecture.",
  "Activity",
  "3,602 followers",
  "Experience",
  "Solutions Architect",
  "Sun Group · Full-time",
  "Jun 2024 - Present · 2 yrs",
  "On-site",
  "Solution Architecture",
  "Solutions Architect at XanhSM",
  "GSM - Xanh SM · Full-time",
  "Education",
  "FPT University",
  "Bachelor of Technology - BTech, Computer Software Engineering",
  "2008 – 2012",
  "Interests",
].join("\n");

describe("LinkedIn profile extraction from current text-first markup", () => {
  it("extracts top-card basics when LinkedIn no longer renders stable top-card classes", () => {
    expect(extractProfileBasicsFromText(PROFILE_TEXT)).toEqual({
      name: "Tuan Tran",
      headline: "Solutions Architect @ Sun Group | GenAI, Agentic AI",
      location: "Hanoi Capital Region",
    });
  });

  it("extracts about from a text heading when #about is absent", () => {
    expect(extractProfileSectionTextFromText(PROFILE_TEXT, "About")).toBe(
      "Sun Group relies on a Solutions Architect with over nine years of experience in software development. Previous roles at XanhSM and VinBigdata honed their skills in backend architecture.",
    );
  });

  it("extracts experience items from heading-based sections", () => {
    expect(extractProfileSectionItemsFromText(PROFILE_TEXT, "Experience")).toEqual([
      "Solutions Architect Sun Group · Full-time Jun 2024 - Present · 2 yrs On-site Solution Architecture",
      "Solutions Architect at XanhSM GSM - Xanh SM · Full-time",
    ]);
  });

  it("runs profile extraction from a template while preserving selector-first fallback order", async () => {
    const result = await applyLinkedInProfileExtractionTemplate({
      template: {
        fields: {
          name: {
            strategies: [
              { type: "selectorValue", key: "name" },
              { type: "profileBasic", field: "name" },
            ],
          },
          headline: {
            strategies: [
              { type: "selectorValue", key: "headline" },
              { type: "profileBasic", field: "headline" },
            ],
          },
          about: {
            strategies: [
              { type: "selectorValue", key: "about" },
              { type: "sectionText", heading: "About" },
            ],
          },
          experiences: {
            strategies: [
              { type: "selectorList", key: "experiences" },
              { type: "sectionItems", heading: "Experience" },
            ],
          },
        },
      },
      pageText: PROFILE_TEXT,
      selectorValues: {
        name: "N/A",
        headline: "N/A",
        about: "",
        experiences: [],
      },
    });

    expect(result).toMatchObject({
      name: "Tuan Tran",
      headline: "Solutions Architect @ Sun Group | GenAI, Agentic AI",
      about:
        "Sun Group relies on a Solutions Architect with over nine years of experience in software development. Previous roles at XanhSM and VinBigdata honed their skills in backend architecture.",
      experiences: [
        "Solutions Architect Sun Group · Full-time Jun 2024 - Present · 2 yrs On-site Solution Architecture",
        "Solutions Architect at XanhSM GSM - Xanh SM · Full-time",
      ],
    });
  });

  it("can read direct CSS selectors from the template before falling back to text parsing", async () => {
    const selectors = {
      "main h1": ["Tuan Tran"],
      "main .text-body-medium": ["Solutions Architect @ Sun Group | GenAI, Agentic AI"],
      "section:has(#about) div.inline-show-more-text": [
        "Sun Group relies on a Solutions Architect with over nine years of experience.",
      ],
      "section:has(#experience) li.pvs-list__paged-list-item": [
        "Solutions Architect Sun Group · Full-time Jun 2024 - Present · 2 yrs",
        "Solutions Architect at XanhSM GSM - Xanh SM · Full-time",
      ],
    };

    const page = {
      locator(selector) {
        const values = selectors[selector] ?? [];
        return {
          first() {
            return this;
          },
          async count() {
            return values.length;
          },
          async innerText() {
            return values[0] ?? "";
          },
          async textContent() {
            return values[0] ?? "";
          },
          async allInnerTexts() {
            return values;
          },
          async allTextContents() {
            return values;
          },
        };
      },
    };

    const result = await applyLinkedInProfileExtractionTemplate({
      template: {
        fields: {
          name: {
            strategies: [
              { type: "cssText", selectors: ["main h1"] },
              { type: "profileBasic", field: "name" },
            ],
          },
          headline: {
            strategies: [
              { type: "cssText", selectors: ["main .text-body-medium"] },
              { type: "profileBasic", field: "headline" },
            ],
          },
          about: {
            strategies: [
              { type: "cssText", selectors: ["section:has(#about) div.inline-show-more-text"] },
              { type: "sectionText", heading: "About" },
            ],
          },
          experiences: {
            strategies: [
              {
                type: "cssList",
                selectors: ["section:has(#experience) li.pvs-list__paged-list-item"],
              },
              { type: "sectionItems", heading: "Experience" },
            ],
          },
        },
      },
      page,
      pageText: PROFILE_TEXT,
      selectorValues: {
        name: "N/A",
        headline: "N/A",
        about: "",
        experiences: [],
      },
    });

    expect(result).toMatchObject({
      name: "Tuan Tran",
      headline: "Solutions Architect @ Sun Group | GenAI, Agentic AI",
      about: "Sun Group relies on a Solutions Architect with over nine years of experience.",
      experiences: [
        "Solutions Architect Sun Group · Full-time Jun 2024 - Present · 2 yrs",
        "Solutions Architect at XanhSM GSM - Xanh SM · Full-time",
      ],
    });
  });
});
