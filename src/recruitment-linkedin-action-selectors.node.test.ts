import { describe, expect, it } from "vitest";
import {
  linkedInConnectButtonName,
  linkedInConnectLabelFragment,
  linkedInMessageButtonName,
  linkedInProfileActionElementSelector,
  linkedInMoreButtonName,
  linkedInPendingButtonName,
  linkedInSendInvitationButtonName,
} from "../skills/head-hunter/scripts/linkedin-action-selectors.mjs";

describe("LinkedIn profile action selector patterns", () => {
  it("matches profile action buttons with candidate names appended", () => {
    expect(linkedInConnectButtonName.test("Connect Nguyen Van A")).toBe(true);
    expect(linkedInConnectButtonName.test("Kết nối Nguyễn Văn A")).toBe(true);
    expect(linkedInMessageButtonName.test("Message Nguyen Van A")).toBe(true);
    expect(linkedInMessageButtonName.test("Nhắn tin Nguyễn Văn A")).toBe(true);
  });

  it("matches LinkedIn invitation labels when Connect is not visible text", () => {
    expect(linkedInConnectLabelFragment.test("Invite Nguyen Van A to connect")).toBe(true);
    expect(linkedInConnectLabelFragment.test("Mời Nguyễn Văn A kết nối")).toBe(true);
    expect(linkedInConnectLabelFragment.test("Send message to Nguyen Van A")).toBe(false);
  });

  it("searches profile actions across LinkedIn button-like elements", () => {
    expect(linkedInProfileActionElementSelector).toContain("button");
    expect(linkedInProfileActionElementSelector).toContain("a");
    expect(linkedInProfileActionElementSelector).toContain('div[role="button"]');
  });

  it("matches overflow and invitation states LinkedIn uses on profile pages", () => {
    expect(linkedInMoreButtonName.test("More actions")).toBe(true);
    expect(linkedInMoreButtonName.test("Thêm hành động")).toBe(true);
    expect(linkedInPendingButtonName.test("Pending Nguyen Van A")).toBe(true);
    expect(linkedInPendingButtonName.test("Invitation sent")).toBe(true);
    expect(linkedInSendInvitationButtonName.test("Send invitation")).toBe(true);
    expect(linkedInSendInvitationButtonName.test("Gửi lời mời")).toBe(true);
  });

  it("does not match unrelated profile actions", () => {
    expect(linkedInConnectButtonName.test("Follow Nguyen Van A")).toBe(false);
    expect(linkedInMessageButtonName.test("Subscribe to Nguyen Van A")).toBe(false);
    expect(linkedInSendInvitationButtonName.test("Cancel")).toBe(false);
  });
});
