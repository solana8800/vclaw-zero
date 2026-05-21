export function normalizeLinkedInLanguage(language) {
  return String(language || "en_US").replace("-", "_");
}

export function buildLinkedInConnectRequest({
  inviteeProfileUrn,
  customMessage,
  csrfToken,
  language,
  pageInstance,
  liTrack,
}) {
  if (!inviteeProfileUrn?.startsWith("urn:li:fsd_profile:")) {
    throw new Error("Thiếu inviteeProfileUrn LinkedIn");
  }
  if (!csrfToken) {
    throw new Error("Thiếu CSRF token LinkedIn");
  }

  const headers = {
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "content-type": "application/json; charset=UTF-8",
    "csrf-token": csrfToken,
    "x-li-deco-include-micro-schema": "true",
    "x-li-lang": normalizeLinkedInLanguage(language),
    "x-li-pem-metadata":
      "Voyager - Profile Actions=topcard-primary-connect-action-click,Voyager - Invitations - Actions=invite-send",
    "x-li-track": JSON.stringify(liTrack),
    "x-restli-protocol-version": "2.0.0",
  };
  if (pageInstance) {
    headers["x-li-page-instance"] = pageInstance;
  }

  const body = {
    invitee: {
      inviteeUnion: {
        memberProfile: inviteeProfileUrn,
      },
    },
  };
  if (customMessage?.trim()) {
    body.customMessage = customMessage.trim().slice(0, 300);
  }

  return {
    url: "/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2",
    headers,
    body: JSON.stringify(body),
  };
}
