# Security

## Reporting a vulnerability

Report a vulnerability privately, through
[GitHub's private vulnerability reporting](https://github.com/stowage-js/stowage/security/advisories/new)
on this repository. Do not open a public issue or pull request for it.

A report that names the package and version, what an attacker can do, and the calls that show it
is the one that can be acted on. The discussion stays in the advisory until a fix is published.
No deadline is stated for an answer or for a fix.

## Which line receives a fix

A fix lands in the current line alone: below 1.0 the newest minor release, from 1.0 on the newest
major. An older line receives no fix, and the way to one is the current line
([spec 9](docs/spec.md#9-versions)).
