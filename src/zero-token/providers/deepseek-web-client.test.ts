import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekWebClient } from "./deepseek-web-client.js";

describe("DeepSeekWebClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps DeepSeek native web search disabled by default", async () => {
    const client = new DeepSeekWebClient({ cookie: "ds_session_id=test" });
    vi.spyOn(client, "createPowChallenge").mockResolvedValue({
      algorithm: "sha256",
      challenge: "challenge",
      difficulty: 1,
      salt: "salt",
      signature: "signature",
    });
    vi.spyOn(client, "solvePow").mockResolvedValue(1);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => "text/event-stream",
      },
      body: new ReadableStream(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await client.chatCompletions({
      sessionId: "session-1",
      message: "Tu van san pham trong database",
      model: "deepseek-chat",
    });

    const request = fetchMock.mock.calls.at(-1)?.[1] as { body?: string } | undefined;
    expect(JSON.parse(request?.body || "{}")).toMatchObject({
      search_enabled: false,
    });
  });
});
