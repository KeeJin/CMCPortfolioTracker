import { resolveSplitFetchStartDate } from "../../src/routes/portfolio";

describe("resolveSplitFetchStartDate", () => {
  it("uses real baseline date when estimation is disabled", () => {
    const baselineDate = "2026-01-01";

    const startDate = resolveSplitFetchStartDate(baselineDate, undefined);

    expect(startDate).toBe("2026-01-01");
  });

  it("uses original baseline date in estimation mode", () => {
    const inferredBaselineDate = "2022-06-06";

    const startDate = resolveSplitFetchStartDate(inferredBaselineDate, {
      originalBaselineDate: "2026-01-01",
    });

    expect(startDate).toBe("2026-01-01");
  });
});
