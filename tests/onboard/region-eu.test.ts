// A restaurant in Madrid onboarded with "United Kingdom" because the form had nowhere closer: money in pounds, the note
// at London time. The form offers more countries than the backend had defaults for (Canada, Ireland, New Zealand,
// Singapore), and none of the euro countries. Now each has its currency, time zone and privacy law.
import { describe, it, expect } from "vitest";
import { regionOf, regionOfDomain, resolveRegion } from "../../src/onboard/region.js";

describe("regions beyond the first five markets", () => {
  it("knows the countries the web form offers and the biggest euro markets, by name and by domain ending", () => {
    expect(resolveRegion({ country: "Spain" })).toMatchObject({ country: "Spain", countryCode: "ES", currency: "EUR", timeZone: "Europe/Madrid", privacyRegime: "eu_gdpr", from: "owner" });
    expect(resolveRegion({ country: "Germany" })).toMatchObject({ currency: "EUR", timeZone: "Europe/Berlin" });
    expect(resolveRegion({ country: "France" })).toMatchObject({ currency: "EUR", timeZone: "Europe/Paris" });
    expect(resolveRegion({ country: "Italy" })).toMatchObject({ currency: "EUR", timeZone: "Europe/Rome" });
    expect(resolveRegion({ country: "Netherlands" })).toMatchObject({ currency: "EUR", timeZone: "Europe/Amsterdam" });
    expect(resolveRegion({ country: "Austria" })).toMatchObject({ currency: "EUR", timeZone: "Europe/Vienna" });
    expect(resolveRegion({ country: "Ireland" })).toMatchObject({ currency: "EUR", timeZone: "Europe/Dublin", locale: "en-IE" });
    expect(resolveRegion({ country: "Canada" })).toMatchObject({ currency: "CAD", timeZone: "America/Toronto", locale: "en-CA" });
    expect(resolveRegion({ country: "New Zealand" })).toMatchObject({ currency: "NZD", timeZone: "Pacific/Auckland" });
    expect(resolveRegion({ country: "Singapore" })).toMatchObject({ currency: "SGD", timeZone: "Asia/Singapore" });
    expect(regionOfDomain("botin.es")?.countryCode).toBe("ES");
    expect(regionOfDomain("cafecentral.wien")?.countryCode).toBeUndefined();   // a city ending says nothing we can use
    expect(regionOfDomain("shop.de")?.countryCode).toBe("DE");
    expect(regionOf("España")?.countryCode).toBeUndefined();                    // names are English; the form sends English
  });

  it("keeps the English spelling of every region: the team writes in English for the owner", () => {
    for (const c of ["Spain", "Germany", "France", "Italy", "Netherlands", "Austria"]) expect(resolveRegion({ country: c }).locale, c).toMatch(/^en-/);
  });

  it("still leaves a country it has no defaults for as written", () => {
    expect(resolveRegion({ country: "Brazil" })).toEqual({ country: "Brazil", from: "owner" });
  });
});
