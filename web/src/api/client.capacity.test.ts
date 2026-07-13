import { describe, expect, it } from "vitest";
import {
  ApiError,
  isCapacityCursorInvalidError,
  shouldRetryCapacityQuery,
} from "./client";

describe("isCapacityCursorInvalidError", () => {
  it("uses the structured capacity error code", () => {
    expect(
      isCapacityCursorInvalidError(
        new ApiError("cursor expired", 400, {
          error_code: "capacity_cursor_invalid",
        }),
      ),
    ).toBe(true);
  });

  it("does not infer cursor failures from status or message text", () => {
    expect(
      isCapacityCursorInvalidError(new ApiError("cursor expired", 400)),
    ).toBe(false);
    expect(
      isCapacityCursorInvalidError(
        new ApiError("unrelated", 400, { code: "another_error" }),
      ),
    ).toBe(false);
  });
});

describe("shouldRetryCapacityQuery", () => {
  it("does not retry stable client or authorization failures", () => {
    expect(shouldRetryCapacityQuery(0, new ApiError("invalid since", 400))).toBe(
      false,
    );
    expect(shouldRetryCapacityQuery(0, new ApiError("forbidden", 403))).toBe(
      false,
    );
    expect(shouldRetryCapacityQuery(0, new ApiError("not found", 404))).toBe(
      false,
    );
  });

  it("bounds retries for transient failures", () => {
    expect(shouldRetryCapacityQuery(0, new ApiError("unavailable", 503))).toBe(
      true,
    );
    expect(shouldRetryCapacityQuery(3, new ApiError("unavailable", 503))).toBe(
      false,
    );
  });
});
