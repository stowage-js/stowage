import { describeAdapters } from "../../targets/src/index.ts";

const enclosingDescribeNames: string[] = [];

// `Deno.test` has no `describe` beside it, so a block becomes the leading part of the
// name of every test registered inside it.
describeAdapters({
  describe(name, body) {
    enclosingDescribeNames.push(name);

    try {
      body();
    } finally {
      enclosingDescribeNames.pop();
    }
  },

  test(name, body) {
    Deno.test([...enclosingDescribeNames, name].join(" > "), body);
  },
});
