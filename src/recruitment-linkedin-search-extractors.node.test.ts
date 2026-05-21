import { describe, expect, it } from "vitest";
import { applyLinkedInSearchExtractionTemplate } from "../skills/head-hunter/scripts/linkedin-search-extractors.mjs";

function makeNode({ text = "", attrs = {}, children = [] } = {}) {
  return {
    children,
    innerText: text,
    textContent: text,
    getAttribute(name) {
      return attrs[name] ?? "";
    },
  };
}

function makeCard() {
  const nameAnchor = makeNode({
    text: "Vũ Công Hiếu",
    attrs: { href: "https://www.linkedin.com/in/vu-cong-hieu/" },
  });
  const nameP = makeNode({ text: "Vũ Công Hiếu • 2nd", children: [nameAnchor] });
  const headline = makeNode({ text: "React Developer" });
  const location = makeNode({ text: "Vietnam" });
  const infoBlock = makeNode({ children: [nameP, headline, location] });
  const contentBlock = makeNode({
    children: [makeNode(), infoBlock, makeNode({ text: "Follow" })],
  });
  const cardContent = makeNode({ children: [contentBlock, makeNode({ text: "Past: ..." })] });
  const anchor = makeNode({
    attrs: { href: "https://www.linkedin.com/in/vu-cong-hieu/" },
    children: [cardContent],
  });
  const card = makeNode({ children: [anchor, makeNode({ text: "" })] });

  return {
    evaluate(fn, arg) {
      return Promise.resolve(fn(card, arg));
    },
  };
}

describe("LinkedIn search extraction template", () => {
  it("reads search results from card DOM paths and preserves profile URL", async () => {
    const results = await applyLinkedInSearchExtractionTemplate({
      template: {
        fields: {
          name: {
            strategies: [{ type: "domText", path: [0, 0, 0, 1, 0], trimDegree: true }],
          },
          headline: {
            strategies: [{ type: "domText", path: [0, 0, 0, 1, 1] }],
          },
          location: {
            strategies: [{ type: "domText", path: [0, 0, 0, 1, 2] }],
          },
          profile_url: {
            strategies: [{ type: "domHref", path: [0, 0, 0, 1, 0, 0] }],
          },
        },
      },
      cards: [makeCard()],
    });

    expect(results).toEqual([
      {
        name: "Vũ Công Hiếu",
        headline: "React Developer",
        location: "Vietnam",
        profile_url: "https://www.linkedin.com/in/vu-cong-hieu/",
      },
    ]);
  });
});
