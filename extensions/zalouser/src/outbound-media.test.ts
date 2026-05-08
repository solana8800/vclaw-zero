import { describe, expect, it } from "vitest";
import { prepareZalouserOutboundFromText } from "./outbound-media.js";

describe("prepareZalouserOutboundFromText", () => {
  it("không tách URL Unsplash không có extension thành mediaUrl", () => {
    const result = prepareZalouserOutboundFromText(
      "Ve Ba Na Hills https://images.unsplash.com/photo-1562790351-d273a2b0e0f2",
    );

    expect(result).toEqual({
      message: "Ve Ba Na Hills https://images.unsplash.com/photo-1562790351-d273a2b0e0f2",
    });
  });

  it("tách URL ảnh chính chủ có extension thành mediaUrl", () => {
    const result = prepareZalouserOutboundFromText(
      "Ve Ba Na Hills https://sun-ecommerce-cdn.azureedge.net/ecommerce/service-sites/asset/SunWorldBaNaHill/swold/he-thong-cap-treo/cap-treo-01-1.jpg",
    );

    expect(result).toEqual({
      message: "Ve Ba Na Hills",
      mediaUrl:
        "https://sun-ecommerce-cdn.azureedge.net/ecommerce/service-sites/asset/SunWorldBaNaHill/swold/he-thong-cap-treo/cap-treo-01-1.jpg",
    });
  });
});
