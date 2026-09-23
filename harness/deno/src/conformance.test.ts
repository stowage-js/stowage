import { describeAdapters } from "../../targets/src/index.ts";

/** The names of the `describe` blocks a test is registered inside, outermost first. */
const scopes: string[] = [];

// `Deno.test` has no `describe` beside it, so a block becomes the leading part of the
// name of every test registered inside it.
describeAdapters({
  describe(name, body) {
    scopes.push(name);

    try {
      body();
    } finally {
      scopes.pop();
    }
  },

  test(name, body) {
    Deno.test([...scopes, name].join(" > "), body);
  },
});
