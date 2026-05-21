function cleanLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSelectorList(selectorOrSelectors) {
  if (Array.isArray(selectorOrSelectors)) {
    return selectorOrSelectors.map(cleanLine).filter(Boolean);
  }
  const selector = cleanLine(selectorOrSelectors);
  return selector ? [selector] : [];
}

function isEmptyValue(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  const text = cleanLine(value);
  return !text || text === "N/A" || /^\d+$/.test(text);
}

function cleanSearchName(value) {
  return cleanLine(value)
    .replace(/\s*•\s*(?:1st|2nd|3rd\+?|3rd)\b.*$/i, "")
    .trim();
}

function resolveChildPath(root, path) {
  const indexes = Array.isArray(path) ? path : [];
  let current = root;
  for (const index of indexes) {
    if (!current?.children || !current.children[index]) return null;
    current = current.children[index];
  }
  return current || null;
}

async function readDomText(locator, path) {
  return locator.evaluate((root, childPath) => {
    let current = root;
    for (const index of Array.isArray(childPath) ? childPath : []) {
      if (!current?.children || !current.children[index]) return "";
      current = current.children[index];
    }
    return (current?.innerText || current?.textContent || "").replace(/\s+/g, " ").trim();
  }, path);
}

async function readDomHref(locator, path) {
  return locator.evaluate((root, childPath) => {
    let current = root;
    for (const index of Array.isArray(childPath) ? childPath : []) {
      if (!current?.children || !current.children[index]) return "";
      current = current.children[index];
    }
    return current?.getAttribute?.("href") || "";
  }, path);
}

async function runSearchTemplateStrategy(strategy, { card }) {
  if (!strategy || typeof strategy !== "object") return undefined;
  if (strategy.type === "domText") {
    if (!card?.evaluate) return undefined;
    const value = await readDomText(card, strategy.path);
    if (strategy.trimDegree) return cleanSearchName(value);
    return cleanLine(value);
  }
  if (strategy.type === "domHref") {
    if (!card?.evaluate) return undefined;
    const value = await readDomHref(card, strategy.path);
    return cleanLine(value);
  }
  if (strategy.type === "cssText") {
    if (!card?.locator) return undefined;
    const selectors = normalizeSelectorList(strategy.selectors ?? strategy.selector);
    for (const selector of selectors) {
      const node = card.locator(selector).first();
      const count = await node.count().catch(() => 0);
      if (!count) continue;
      const value = cleanLine(
        await node.innerText().catch(async () => node.textContent().catch(() => "")),
      );
      if (!isEmptyValue(value)) return value;
    }
    return undefined;
  }
  if (strategy.type === "cssHref") {
    if (!card?.locator) return undefined;
    const selectors = normalizeSelectorList(strategy.selectors ?? strategy.selector);
    for (const selector of selectors) {
      const node = card.locator(selector).first();
      const count = await node.count().catch(() => 0);
      if (!count) continue;
      const href = cleanLine(await node.getAttribute("href").catch(() => ""));
      if (!isEmptyValue(href)) return href;
    }
    return undefined;
  }
  if (strategy.type === "selectorValue") {
    return strategy.value;
  }
  if (strategy.type === "cardText") {
    if (!card?.evaluate) return undefined;
    const value = await card.evaluate((root) =>
      (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim(),
    );
    return cleanLine(value);
  }
  return undefined;
}

export async function applyLinkedInSearchExtractionTemplate({ template, cards = [] }) {
  const fields = template?.fields && typeof template.fields === "object" ? template.fields : {};
  const results = [];

  for (const card of cards) {
    const result = {};
    for (const [fieldName, fieldConfig] of Object.entries(fields)) {
      const strategies = Array.isArray(fieldConfig?.strategies) ? fieldConfig.strategies : [];
      for (const strategy of strategies) {
        const value = await runSearchTemplateStrategy(strategy, { card });
        if (!isEmptyValue(value)) {
          result[fieldName] = cleanLine(value);
          break;
        }
      }
    }
    if (Object.keys(result).length) results.push(result);
  }

  return results;
}

export { cleanSearchName, resolveChildPath };
