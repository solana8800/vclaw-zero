import { describe, expect, it } from "vitest";
import { buildLinkedInConnectRequest } from "../skills/head-hunter/scripts/linkedin-voyager-connect.mjs";

describe("LinkedIn voyager connect request builder", () => {
  it("builds the invite request without a note", () => {
    const request = buildLinkedInConnectRequest({
      inviteeProfileUrn: "urn:li:fsd_profile:ACoAACqZBc4B3GkmfohAsSG5cFKss4Re6AA-auc",
      csrfToken: "ajax:123",
      language: "en-US",
      pageInstance: "urn:li:page:d_UNKNOWN_ROUTE_preload.custom-invite;abc",
      liTrack: { mpName: "voyager-web" },
    });

    expect(request.url).toContain("voyagerRelationshipsDashMemberRelationships");
    expect(request.headers["csrf-token"]).toBe("ajax:123");
    expect(request.headers["x-li-lang"]).toBe("en_US");
    expect(request.headers["x-li-page-instance"]).toBe(
      "urn:li:page:d_UNKNOWN_ROUTE_preload.custom-invite;abc",
    );
    expect(JSON.parse(request.body)).toEqual({
      invitee: {
        inviteeUnion: {
          memberProfile: "urn:li:fsd_profile:ACoAACqZBc4B3GkmfohAsSG5cFKss4Re6AA-auc",
        },
      },
    });
  });

  it("adds customMessage when a note is provided", () => {
    const request = buildLinkedInConnectRequest({
      inviteeProfileUrn: "urn:li:fsd_profile:ACoAACqZBc4B3GkmfohAsSG5cFKss4Re6AA-auc",
      customMessage: "Hi from test",
      csrfToken: "ajax:123",
      language: "en-US",
      pageInstance: "urn:li:page:d_UNKNOWN_ROUTE_preload.custom-invite;abc",
      liTrack: { mpName: "voyager-web" },
    });

    expect(JSON.parse(request.body)).toEqual({
      invitee: {
        inviteeUnion: {
          memberProfile: "urn:li:fsd_profile:ACoAACqZBc4B3GkmfohAsSG5cFKss4Re6AA-auc",
        },
      },
      customMessage: "Hi from test",
    });
  });
});
