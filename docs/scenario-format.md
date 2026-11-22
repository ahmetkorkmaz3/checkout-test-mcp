# Scenario format (schema_version 1)

This file is the reference for scenario and fragment YAML files.
Editors can use the generated JSON Schemas for autocomplete:

- Scenario: [schemas/scenario.schema.json](../schemas/scenario.schema.json)
- Fragment: [schemas/fragment.schema.json](../schemas/fragment.schema.json)

Add this line at the top of a file to get autocomplete in VS Code (change the path):

```yaml
# yaml-language-server: $schema=../../schemas/scenario.schema.json
```

Examples:

- [card-3ds-challenge-fail.yaml](../scenarios/demo-store/card-3ds-challenge-fail.yaml): a scenario that uses three fragments.
- [fragments/add-to-cart.yaml](../scenarios/demo-store/fragments/add-to-cart.yaml): a fragment with args and a `when` condition.

## 1. Files and folders

- The server reads every `.yaml` and `.yml` file in `scenario_dirs`, also in subfolders.
- A file with `kind: fragment` is a fragment. The server checks it at startup but never runs it alone.
- Every other file is a scenario. `kind: scenario` is optional.
- Company-specific scenarios belong in a private folder outside this repository. Point `scenario_dirs` in your local config at that folder.

## 2. Scenario keys

| Key | Required | Meaning |
|---|---|---|
| `schema_version` | yes | `1`. |
| `kind` | no | `scenario`. |
| `id` | yes | Kebab-case. Unique in all scenario dirs. The agent uses it in `run_scenario`. |
| `title` | yes | One line. |
| `summary` | yes | What the scenario does and what result it expects. The agent reads it in `list_scenarios`. |
| `tags` | no | Free words for filters. |
| `compatible_profiles` | yes | Target profiles where the selectors are valid. |
| `expected_outcome` | yes | `order_placed`, `payment_declined`, `validation_error`, or `custom`. |
| `params` | no | Inputs the agent can set. See section 3. |
| `data` | no | Named test data files, relative to `test_data_dir`. Values are `{{data.<name>.<field>}}`. |
| `timeouts` | no | `step_ms` (default 15000) and `run_ms` (default 180000). |
| `ignore` | no | `console: [{ pattern }]` (substring) and `network: [{ url }]` (glob). Matching items never count as failures. |
| `steps` | yes | Ordered list. See section 4. |
| `outcome` | no | Final checks after the last step. See section 7. |

## 3. Params

Every param needs `type`, `description`, and `default` or `required: true`.

| Type | Extra keys |
|---|---|
| `string` | |
| `integer`, `number` | `minimum`, `maximum` |
| `boolean` | |
| `enum` | `values` (list of strings) |
| `test_card` | `constraints.behaviour` (for example `challenge_required`) |

- A `test_card` param takes a card id from the built-in registry, never a card number.
- A string that contains a Luhn-valid 13 to 19 digit number is refused in params, scenario files, fragment files, and test data files.

## 4. Steps

A step has `id` (snake_case), `title`, and exactly one of these keys:

| Key | Value |
|---|---|
| `goto` | Path relative to `base_url`. An absolute URL must be on an allowed host. |
| `click` | Locator. |
| `fill` | Locator, plus `value`. |
| `select` | Locator, plus `option` (label or value of a native `<select>`). |
| `check` / `uncheck` | Locator. |
| `press` | Locator, plus `key` (for example `Enter`). |
| `fill_form` | List of `{ field: Locator, value }` or `{ field: Locator, select }`. |
| `wait_for` | One expectation (section 6). |
| `include` | Path of a fragment file (section 5). |

Optional keys for an action step:

- `within: { frame: Locator }`: run the actions of this step inside an iframe. Expectations do not use it.
- `then`: a list of more actions in the same step, for example "click, then click continue".
- `expect`: a list of expectations. All must pass.
- `timeout_ms`: timeout for this step. `options.timeout_multiplier` scales it.
- `on_failure.hint`: author text. The result shows it in `failure.likely_causes`.
- `when`: run the step only when the condition passes (section 5.3).

## 5. Reuse: include and when

### 5.1 Fragments

A fragment holds steps that more than one scenario needs, for example "log in", "add to cart", or "fill the address".

```yaml
schema_version: 1
kind: fragment
id: shop-login
description: Logs in with the test member account.
args:
  email:
    description: Email of the member.
  start_path:
    description: Page to open first.
    default: /giris
steps:
  - id: open
    title: Open the login page
    goto: "{{args.start_path}}"
  - id: fill
    title: Fill the login form
    fill_form:
      - field: { label: E-posta }
        value: "{{args.email}}"
      - field: { label: Şifre }
        value: "{{secrets.member_password}}"
```

- `{{args.<name>}}` works only inside a fragment. The server replaces it when it loads the scenario.
- A fragment can also use `{{params.*}}`, `{{data.*}}`, `{{card.*}}`, and `{{secrets.*}}` of the scenario that includes it.
- A `when` condition inside a fragment refers to the params of the scenario that includes it.

### 5.2 Include step

```yaml
steps:
  - id: login
    title: Log in as member
    include: fragments/login.yaml        # relative to this file
    with:
      email: "{{data.member.email}}"
    when: { param: customer_type, equals: member }
```

- An include step allows only `id`, `title`, `include`, `with`, and `when`.
- `with` gives values for the fragment `args`. A value can contain other templates. An unknown arg or a missing arg without a default stops the load.
- The expanded steps get ids like `login__open` and `login__fill`. Results and `compare_runs` use these ids.
- Fragments can include other fragments, up to 5 levels deep. A cycle stops the load.
- A fragment file must be inside one of the `scenario_dirs`.
- The scenario hash includes the fragment text. `compare_runs` warns when a fragment changes between two runs.

### 5.3 when

`when` is one condition, or a list of conditions that must all pass. A condition has `param` and exactly one operator:

```yaml
when: { param: customer_type, equals: member }
when: { param: quantity, not_equals: 1 }
when: { param: payment_method, in: [card, gift_card] }
when:
  - { param: customer_type, equals: member }
  - { param: payment_method, equals: gift_card }
```

- The server checks the conditions with the resolved params (defaults applied) before the run starts.
- Steps and outcome checks that do not pass are left out of the run. They do not show in the result.
- An include step `when` applies to every step of the fragment, together with the fragment step conditions.
- Secrets are needed only for the steps that run. A guest run does not need the member password.
- Values compare as text, so `equals: 1` matches the integer `1` and the string `"1"`.
- A condition on a param that the scenario does not declare stops the load.

## 6. Locators and expectations

### 6.1 Locators

A locator maps one-to-one to a Playwright locator. Prefer the top rows.

| YAML | Playwright |
|---|---|
| `{ role, name?, level?, exact? }` | `getByRole(role, { name, level, exact })` |
| `{ test_id }` | `getByTestId(test_id)`. The target config sets the attribute (`test_id_attribute`). |
| `{ label }` | `getByLabel(label)` |
| `{ placeholder }` | `getByPlaceholder(placeholder)` |
| `{ text }` | `getByText(text)` |
| `{ css }` | `locator(css)`. Fallback only. |

`name`, `label`, and `text` can be a string or `{ matches: "<regex>" }`. The regex is case-insensitive.

### 6.2 Expectations

| Shape | Passes when |
|---|---|
| `visible: Locator` or `visible: { within: { frame }, locator }` | The element is visible before the timeout. |
| `hidden: ...` (same shapes) | The element is hidden or absent. |
| `text: { <locator keys>, within?, equals \| contains \| matches }` | The element text matches. `matches` is a regex. |
| `url: { matches \| regex \| equals }` | The page URL matches. `matches` is a glob: `*` stays in one path segment, `**` matches anything. |
| `response: { method?, url, status? }` | A matching response arrived during this step. `status` is a number or `"2xx"`, `"4xx"`, and so on. |
| `no_response: { method?, url, status? }` | No matching response arrived during the whole run. |

Every expectation can have `timeout_ms`.

Note: `role: alert` has no accessible name from its text. Check alert text with `text: { role: alert, matches: ... }`.

## 7. Outcome checks

Outcome checks run after the last step. Each one has an `id`, one expectation, and an optional `when`. Each check gets its own result, also when an earlier check fails.

## 8. Templates

| Token | Value |
|---|---|
| `{{params.<name>}}` | Resolved param value. |
| `{{data.<name>.<field>}}` | Field of a test data file. |
| `{{card.number}}`, `{{card.expiry}}`, `{{card.cvc}}` | The test card, when the scenario has exactly one `test_card` param. |
| `{{cards.<param>.number}}` | The test card of a named param. |
| `{{secrets.<name>}}` | Env var mapped in the target `secrets` config. |
| `{{args.<name>}}` | Fragment arg. Only inside a fragment. |

- Templates are plain substitution. No expressions, no code.
- An unknown token stops the run before the browser starts.
- Secret and card values are redacted in logs and results.
