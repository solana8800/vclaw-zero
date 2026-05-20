export function parseLinkedInMessagingThreadId(url) {
  const match = String(url || "").match(/\/messaging\/thread\/([^/?#\s]+)/);
  return match?.[1] || null;
}

export function normalizeLinkedInLanguage(language) {
  return String(language || "en_US").replace("-", "_");
}

export function buildLinkedInConversationUrn({ mailboxUrn, threadId }) {
  if (!mailboxUrn?.startsWith("urn:li:fsd_profile:")) {
    throw new Error("mailboxUrn không hợp lệ");
  }
  if (!threadId) {
    throw new Error("Thiếu LinkedIn messaging thread id");
  }
  return `urn:li:msg_conversation:(${mailboxUrn},${threadId})`;
}

export function buildLinkedInDashMessageRequest({
  message,
  mailboxUrn,
  threadId,
  csrfToken,
  language,
  pageInstance,
  liTrack,
  originToken,
  trackingId,
}) {
  if (!message?.trim()) {
    throw new Error("Nội dung tin nhắn trống");
  }
  if (!csrfToken) {
    throw new Error("Thiếu CSRF token LinkedIn");
  }
  if (!originToken) {
    throw new Error("Thiếu originToken LinkedIn");
  }
  if (!trackingId) {
    throw new Error("Thiếu trackingId LinkedIn");
  }

  const headers = {
    accept: "application/json",
    "content-type": "text/plain;charset=UTF-8",
    "csrf-token": csrfToken,
    "x-li-lang": normalizeLinkedInLanguage(language),
    "x-li-track": JSON.stringify(liTrack),
    "x-restli-protocol-version": "2.0.0",
  };
  if (pageInstance) {
    headers["x-li-page-instance"] = pageInstance;
  }

  return {
    url: "/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage",
    headers,
    body: JSON.stringify({
      message: {
        body: { attributes: [], text: message },
        renderContentUnions: [],
        conversationUrn: buildLinkedInConversationUrn({ mailboxUrn, threadId }),
        originToken,
      },
      mailboxUrn,
      trackingId,
      dedupeByClientGeneratedToken: false,
    }),
  };
}
