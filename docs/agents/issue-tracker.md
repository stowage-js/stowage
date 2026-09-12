# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `stowage-js/stowage`.

Use the `github` MCP server declared in `.mcp.json` for every operation, through the
`mcp__github__*` tools. Do not use the `gh` CLI, plain `git` against the API, or `WebFetch`.

Pass `owner: stowage-js` and `repo: stowage` on every call. Parameter names below are a
summary; read the tool schema for the exact shape.

## Conventions

- **Create an issue**: `mcp__github__issue_write` with `method: create`.
- **Read an issue**: `mcp__github__issue_read` — `method: get` for the body, `get_comments`
  for the discussion, `get_labels` for the current labels.
- **List issues**: `mcp__github__list_issues`, filtered by `state` and `labels`.
- **Find issues**: `mcp__github__search_issues` for anything that needs full-text or
  multi-criteria matching.
- **Comment**: `mcp__github__add_issue_comment`.
- **Apply / remove labels**: `mcp__github__issue_write` with `method: update` and the full
  `labels` list. `mcp__github__get_label` checks whether a label already exists.
- **Close**: `mcp__github__issue_write` with `method: update`, `state: closed`, and a
  `state_reason`; add the closing note as a separate comment.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature
requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using
`mcp__github__list_pull_requests` and `mcp__github__pull_request_read` (`method: get`,
`get_diff`, `get_comments`). Keep only authors outside the org. GitHub shares one number
space across issues and PRs, so a bare `#42` may be either: try `pull_request_read` and fall
back to `issue_read`.

Opening a PR (`mcp__github__create_pull_request`) is allowed. Pushing branch content is not —
no `push_files`, `create_or_update_file`, `edit_files`, `delete_file`, or `create_branch`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read the issue plus its comments via `mcp__github__issue_read`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: an issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: an issue attached to the map with `mcp__github__sub_issue_write`
  (`method: add`). Labels: `wayfinder:<type>` (`research` / `prototype` / `grilling` / `task`).
  Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's native issue dependencies are not exposed over this MCP server, so
  put a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when
  every blocker is closed.
- **Frontier query**: list the map's open children, drop any with an open blocker in its
  `Blocked by` line or with an assignee; first in map order wins.
- **Claim**: `mcp__github__issue_write` with `method: update` and yourself as assignee, the
  session's first write.
- **Resolve**: comment the answer, close the issue, then append a context pointer to the map's
  Decisions-so-far.
