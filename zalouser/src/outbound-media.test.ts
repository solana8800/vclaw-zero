import { describe, expect, it } from "vitest";
import { prepareZalouserOutboundFromText } from "./outbound-media.js";

describe("prepareZalouserOutboundFromText", () => {
  it("tách VietQR img.vietqr.io thành mediaUrl và bỏ URL khỏi caption", () => {
    const result = prepareZalouserOutboundFromText(
      "Chuyen khoan 35k https://img.vietqr.io/image/TCB-69696969321-print.png?amount=35000&addInfo=hoadon123",
    );
    expect(result).toEqual({
      message: "Chuyen khoan 35k",
      mediaUrl:
        "https://img.vietqr.io/image/TCB-69696969321-print.png?amount=35000&addInfo=hoadon123",
    });
  });

  it("giữ nguyên khi đã có mediaUrl explicit", () => {
    const msg = "Caption only";
    expect(
      prepareZalouserOutboundFromText(msg, "https://img.vietqr.io/image/X-compact.png"),
    ).toEqual({
      message: msg,
      mediaUrl: "https://img.vietqr.io/image/X-compact.png",
    });
  });
});
