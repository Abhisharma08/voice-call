/**
 * Script templating for a spoken call.
 *
 * Kept out of the route module deliberately: this is pure string work, and a
 * test for it should not have to import a route handler and open a database
 * pool to run.
 *
 * The failure it exists to prevent is concrete. A script drafted in the admin
 * UI with `[Name]` in it was read down the phone to a real person as the
 * literal word "Name", brackets included.
 */

export interface ScriptFields {
  name: string | null;
  requirement: string | null;
}

/**
 * Substitute lead details into a script or question.
 *
 * Supports `{{name}}` and `{{requirement}}`, and also the `[Name]` and
 * `[product/service]` forms people naturally type when drafting a script.
 *
 * An unknown or absent field collapses to nothing rather than leaving the
 * placeholder in place, and the surrounding whitespace is tidied, so a lead
 * whose name never reached HubSpot hears a slightly plainer sentence instead
 * of the word "undefined".
 */
export function fill(template: string, fields: ScriptFields): string {
  const value = (key: string): string => {
    const k = key.trim().toLowerCase();
    if (k === "name" || k === "first_name" || k === "firstname") return fields.name ?? "";
    if (k === "requirement" || k === "product" || k === "product/service" || k === "enquiry") {
      return fields.requirement ?? "";
    }
    return "";
  };

  return template
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key: string) => value(key))
    .replace(/\[([^\]]+)\]/g, (_, key: string) => value(key))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.?!])/g, "$1")
    .trim();
}

/** A first name is what a caller would actually use out loud. */
export function firstName(full: string | null): string | null {
  const first = full?.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : null;
}
