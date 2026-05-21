const SECTION_HEADINGS = [
  "Highlights",
  "About",
  "Activity",
  "Experience",
  "Education",
  "Licenses & certifications",
  "Licenses and certifications",
  "Skills",
  "Projects",
  "Languages",
  "Recommendations",
  "Interests",
  "More profiles for you",
];

function cleanLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function textLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);
}

function isSectionHeading(line) {
  const normalized = cleanLine(line).toLowerCase();
  return SECTION_HEADINGS.some((heading) => normalized === heading.toLowerCase());
}

function sectionLines(text, heading) {
  const lines = textLines(text);
  const start = lines.findIndex((line) => cleanLine(line).toLowerCase() === heading.toLowerCase());
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isSectionHeading(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

export function extractProfileBasicsFromText(text) {
  const lines = textLines(text);
  let name = "N/A";
  let headline = "N/A";
  let location = "N/A";

  const inlineConnectionIndex = lines.findIndex((line) =>
    /\s·\s*(1st|2nd|3rd\+?|3rd)\b/i.test(line),
  );
  if (inlineConnectionIndex >= 0) {
    const line = lines[inlineConnectionIndex];
    name = cleanLine(line.replace(/\s*·\s*(1st|2nd|3rd\+?|3rd).*$/i, "")) || "N/A";
    headline =
      lines[inlineConnectionIndex + 1] && lines[inlineConnectionIndex + 1] !== "Message"
        ? lines[inlineConnectionIndex + 1]
        : "N/A";
    const locationCandidate = lines
      .slice(inlineConnectionIndex + 2, inlineConnectionIndex + 7)
      .find((line) => line !== "·" && !/^contact info$/i.test(line) && line !== "Message");
    location = locationCandidate
      ? locationCandidate.replace(/\s*·?\s*Contact info\s*$/i, "")
      : "N/A";
  } else {
    const markerIndex = lines.findIndex((line) => /^·\s*(1st|2nd|3rd\+?|3rd)\b/i.test(line));
    if (markerIndex > 0) {
      name = lines[markerIndex - 1] || "N/A";
      headline = lines[markerIndex + 1] || "N/A";
      const locationCandidate = lines
        .slice(markerIndex + 2, markerIndex + 7)
        .find((line) => line !== "·" && !/^contact info$/i.test(line) && line !== "Message");
      location = locationCandidate
        ? locationCandidate.replace(/\s*·?\s*Contact info\s*$/i, "")
        : "N/A";
    }
  }

  return {
    name: cleanLine(name),
    headline: cleanLine(headline),
    location: cleanLine(location),
  };
}

export function extractProfileSectionTextFromText(text, heading) {
  return sectionLines(text, heading)
    .filter((line) => !/^\d[\d,.\s]*\s+followers?$/i.test(line))
    .join(" ")
    .replace(/\s*…\s*more\s*$/i, "")
    .trim();
}

function looksLikeNewExperienceItem(line, current) {
  if (current.length < 3) return false;
  if (/^(on-site|hybrid|remote)$/i.test(line)) return false;
  const hasDate = current.some((item) => /\b(19|20)\d{2}\b|present|hiện tại/i.test(item));
  const hasCompany = current.some((item) => item.includes("·"));
  const looksLikeTitle =
    /\bat\b|@|architect\b|developer|engineer|manager|lead|officer|consultant|specialist|designer|founder|director|head|intern/i.test(
      line,
    );
  return hasDate && hasCompany && looksLikeTitle && /^[A-ZÀ-Ỹ]/.test(line);
}

export function extractProfileSectionItemsFromText(text, heading) {
  const lines = sectionLines(text, heading).filter((line) => {
    if (/^show all\b/i.test(line)) return false;
    if (/^\d[\d,.\s]*\s+followers?$/i.test(line)) return false;
    return true;
  });
  if (lines.length === 0) return [];

  const items = [];
  let current = [];
  for (const line of lines) {
    if (looksLikeNewExperienceItem(line, current)) {
      items.push(current.join(" ").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length) items.push(current.join(" ").trim());

  return [...new Set(items.filter((item) => item.length >= 12))].slice(0, 15);
}
