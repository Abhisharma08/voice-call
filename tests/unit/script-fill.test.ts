import { describe, it, expect } from "vitest";
import { fill, firstName } from "@/lib/providers/voice/script-fill";

/**
 * Script templating for a spoken call.
 *
 * The failure this exists to prevent is concrete: a script drafted in the
 * admin UI with `[Name]` in it was read down the phone as the literal word
 * "Name", brackets and all, to a real person.
 *
 * Imported from the pure module rather than the route: a unit test should not
 * have to pull in a route handler and open a database pool.
 */

describe("fill", () => {
  const lead = { name: "Rahul", requirement: "uPVC windows for a 3BHK" };

  it("substitutes the double-brace form", () => {
    expect(fill("Namaste {{name}}, about your {{requirement}} enquiry.", lead)).toBe(
      "Namaste Rahul, about your uPVC windows for a 3BHK enquiry.",
    );
  });

  it("substitutes the bracket form people type by hand", () => {
    expect(fill("Hi [Name], calling about [product/service].", lead)).toBe(
      "Hi Rahul, calling about uPVC windows for a 3BHK.",
    );
  });

  it("drops a placeholder with no value rather than saying 'undefined'", () => {
    const anonymous = { name: null, requirement: null };
    // The lead hears a plainer sentence, not a broken one.
    expect(fill("Namaste {{name}}, about your {{requirement}} enquiry.", anonymous)).toBe(
      "Namaste, about your enquiry.",
    );
  });

  it("drops an unknown placeholder instead of reading it aloud", () => {
    expect(fill("Hello {{unknown_field}} there.", lead)).toBe("Hello there.");
  });

  it("leaves a script with no placeholders untouched", () => {
    const plain = "Namaste, this is Alu Empire calling about your enquiry.";
    expect(fill(plain, lead)).toBe(plain);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(fill("Hi {{ name }}.", lead)).toBe("Hi Rahul.");
  });
});

describe("firstName", () => {
  it("takes the first word, which is what a caller would say", () => {
    expect(firstName("Rahul Sharma")).toBe("Rahul");
  });

  it("returns null for a missing or blank name", () => {
    expect(firstName(null)).toBeNull();
    expect(firstName("   ")).toBeNull();
  });
});
