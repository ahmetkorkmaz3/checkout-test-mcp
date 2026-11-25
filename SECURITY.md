# Security policy

## Report a vulnerability

Do not open a public issue for a security problem.

Use the private report form of GitHub: open the [Security tab](https://github.com/ahmetkorkmaz3/checkout-test-mcp/security) and click **Report a vulnerability**.

Include these items:

- The version of `checkout-test-mcp`.
- The steps to reproduce the problem.
- What an attacker can do with it.

You get a first answer in 7 days.

## Supported versions

Only the latest release gets security fixes.

## Scope

These are security problems for this project:

- A way to make the server open a host that is not on the allowlist of the target.
- A way to run on a production target without `confirm_production: true`.
- A way to use a card number that is not in the test card registry or in the `live_cards` env vars.
- A secret or a card number in a log, a tool result, a screenshot path, or an error message.
- A way to make the server write a file outside its configured folders.

Do not test against a site that you do not own or do not have permission to test.
