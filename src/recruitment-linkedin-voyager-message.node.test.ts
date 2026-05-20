import { describe, expect, it } from "vitest";
import {
  buildLinkedInDashMessageRequest,
  parseLinkedInMessagingThreadId,
} from "../skills/head-hunter/scripts/linkedin-voyager-message.mjs";

describe("LinkedIn Voyager Dash message request", () => {
  it("parses the messaging thread id from LinkedIn thread URLs", () => {
    expect(
      parseLinkedInMessagingThreadId(
        "https://www.linkedin.com/messaging/thread/2-OGE3Y2MyZGQtODczOC00NzQxLTg0NzctYTRmM2RiYmZiYmMxXzEwMA==/",
      ),
    ).toBe("2-OGE3Y2MyZGQtODczOC00NzQxLTg0NzctYTRmM2RiYmZiYmMxXzEwMA==");
  });

  it("builds the current Dash createMessage endpoint, headers, and body shape", () => {
    const request = buildLinkedInDashMessageRequest({
      message: "Xin chào",
      mailboxUrn: "urn:li:fsd_profile:ACoAACS_KzQBXsG2FPbAI7fV_6xuW7AzJapMLNk",
      threadId: "2-OGE3Y2MyZGQtODczOC00NzQxLTg0NzctYTRmM2RiYmZiYmMxXzEwMA==",
      csrfToken: "ajax:3002149811277091494",
      language: "en_US",
      pageInstance:
        "urn:li:page:d_flagship3_messaging_conversation_detail;ojZ6fSnhToKdb73l80LvGw==",
      liTrack: {
        clientVersion: "1.13.44259",
        mpVersion: "1.13.44259",
        osName: "web",
        timezoneOffset: 7,
        timezone: "Asia/Saigon",
        deviceFormFactor: "DESKTOP",
        mpName: "voyager-web",
        displayDensity: 1,
        displayWidth: 2560,
        displayHeight: 1440,
      },
      originToken: "3bda8834-30e4-41ca-a26f-2ae9c904ad04",
      trackingId: "tracking-id",
    });

    expect(request.url).toBe(
      "/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage",
    );
    expect(request.headers).toMatchObject({
      accept: "application/json",
      "content-type": "text/plain;charset=UTF-8",
      "csrf-token": "ajax:3002149811277091494",
      "x-li-lang": "en_US",
      "x-li-page-instance":
        "urn:li:page:d_flagship3_messaging_conversation_detail;ojZ6fSnhToKdb73l80LvGw==",
      "x-restli-protocol-version": "2.0.0",
    });
    expect(JSON.parse(request.body)).toEqual({
      message: {
        body: { attributes: [], text: "Xin chào" },
        renderContentUnions: [],
        conversationUrn:
          "urn:li:msg_conversation:(urn:li:fsd_profile:ACoAACS_KzQBXsG2FPbAI7fV_6xuW7AzJapMLNk,2-OGE3Y2MyZGQtODczOC00NzQxLTg0NzctYTRmM2RiYmZiYmMxXzEwMA==)",
        originToken: "3bda8834-30e4-41ca-a26f-2ae9c904ad04",
      },
      mailboxUrn: "urn:li:fsd_profile:ACoAACS_KzQBXsG2FPbAI7fV_6xuW7AzJapMLNk",
      trackingId: "tracking-id",
      dedupeByClientGeneratedToken: false,
    });
  });
});
