import { describe, expect, it } from "vitest";
import {
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
});
