function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return "";
}

/** Chuẩn hoá nội dung tin (text, card OA, mảng block…) cho luồng inbound. */
export function normalizeZaloInboundTextContent(content: unknown, depth = 0): string {
  if (typeof content === "string") {
    return content;
  }
  if (content == null) {
    return "";
  }
  if (depth > 6) {
    return "";
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item == null) {
        continue;
      }
      if (typeof item === "string") {
        const t = item.trim();
        if (t) {
          parts.push(t);
        }
        continue;
      }
      if (typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const textChunk =
          toStringValue(rec.text) ||
          toStringValue(rec.content) ||
          toStringValue(rec.body) ||
          toStringValue(rec.title);
        const nested = normalizeZaloInboundTextContent(
          rec.payload ?? rec.params ?? rec.message ?? rec.data,
          depth + 1,
        );
        const chunk = [textChunk, nested].filter(Boolean).join("\n").trim();
        if (chunk) {
          parts.push(chunk);
        }
      }
    }
    return parts.join("\n").trim();
  }
  if (typeof content !== "object") {
    return "";
  }
  const record = content as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const href = typeof record.href === "string" ? record.href.trim() : "";
  const caption = toStringValue(record.caption);
  const altText = toStringValue(record.altText) || toStringValue(record.alt);
  const msg = toStringValue(record.msg) || toStringValue(record.message);
  const action = toStringValue(record.action);
  const thumb = toStringValue(record.thumb) || toStringValue(record.thumbUrl);
  const nested = normalizeZaloInboundTextContent(
    record.params ?? record.attach ?? record.attachments ?? record.attachment ?? record.content,
    depth + 1,
  );
  const combined = [
    title,
    description,
    href,
    caption,
    altText,
    msg,
    action,
    thumb ? `thumb:${thumb}` : "",
    nested,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (combined) {
    return combined;
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}
