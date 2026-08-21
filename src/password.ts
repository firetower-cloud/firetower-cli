import { randomInt } from "node:crypto";

/**
 * Three words and a number, the same shape the control plane invents for
 * itself.
 *
 * Matched deliberately: whichever of the two produced it, the operator sees one
 * kind of temporary password, reads it off a terminal once, and types it into a
 * browser once. It exists to be replaced — the account can do nothing else
 * until it is.
 */
const WORDS = [
  "amber", "anchor", "beacon", "cedar", "cobalt", "copper", "ember", "harbor",
  "hollow", "ivory", "kestrel", "lantern", "meadow", "onyx", "quarry", "quiet",
  "ridge", "river", "saffron", "silver", "summit", "thicket", "timber",
  "velvet", "walnut", "willow",
] as const;

export function invent(): string {
  const word = () => WORDS[randomInt(WORDS.length)];
  return `${word()}-${word()}-${word()}-${100 + randomInt(900)}`;
}
