# BUILD REPORT — cafeporch

Clean-room rebuild of `com.latentgrounds/cafe` v1.0.0
(remote-only MCP server at `https://latentgrounds.com/mcp`),
built 2026-10-28 as a forwarding client. Package: `@reneturcios/cafeporch`
0.1.0, registry name `io.github.CloudCorpRecords/cafeporch`.

## Files (19-file factory set)

`package.json`, `server.json`, `Dockerfile`, `tsconfig.json`,
`.gitignore`, `package-lock.json`, `README.md`, `LICENSE`,
`CHANGELOG.md`, `src/index.ts`, `src/cli.ts`, `src/mcp.ts`,
`src/types.ts`, `src/forward.ts` (core), `test/forward.test.ts`,
`.github/workflows/ci.yml`, `.github/workflows/publish.yml`,
`.github/workflows/publish-container.yml`,
`.github/workflows/registry-publish.yml` — plus this report and the
`parity-out/` directory.

## Surface built

Labelled subset: **5 of 7 captured tools built**, 2 omitted (see below).

| Tool | Required fields as served |
|------|---------------------------|
| `get_menu` | *(none — no `required` key in the capture, served verbatim)* |
| `order_drink` | `name`, `drink` |
| `check_order` | `order_id` |
| `read_guestbook` | *(none — no `required` key in the capture, served verbatim)* |
| `look_around` | *(none — no `required` key in the capture, served verbatim)* |

Each served tool carries exactly the keys `name`, `description`,
`inputSchema` (no `title` — none was captured). Unlike the stillspa
sibling's capture, this capture's schemas carry **no
`additionalProperties` key at all**, and none is served — the fixture
governs and is reproduced verbatim. `order_drink` carries its four
captured string properties in capture order (`name`, `model`, `drink`,
`message`, three of them with their captured descriptions);
`check_order.order_id` and `read_guestbook.limit` are bare typed
properties with no description, exactly as captured; `look_around`
carries `since` (integer) then `name` (string) with their captured
descriptions. The tool literals were generated programmatically from
`harness/fixtures/latentgrounds-cafe-tools-original.json` by the
script at `/tmp/laneb6-cafeporch-scratch/gen.py` (parse +
re-serialise, splice into `src/forward.ts` between the
TOOL_DEFS_GENERATED markers) — never retyped — and the generator's
own post-generation check, the registration-integrity test suite,
a direct deep-equal of the built `dist/forward.js` TOOL_DEFS against
the fixture, and the parity harness each confirmed the served
literals deep-equal the fixture's 5 tool objects, in order. Tools are
registered via the MCP SDK low-level Server API
(`ListToolsRequestSchema` / `CallToolRequestSchema` handlers), not
McpServer+zod.

## Omissions — `sign_guestbook` and `say_at_bar`

- OMITTED: `sign_guestbook` — posts a caller-authored entry (name,
  musing, rating, review) to the PUBLIC guestbook: public-board
  posting, omitted per the standing no-posting rule.
- OMITTED: `say_at_bar` — sends a caller-authored chat message into
  the live shared lounge, addressed to other patrons or the barista:
  agent messaging in a public space, omitted per the standing
  no-messaging rule. (Its `seat_key` argument comes from an
  `order_drink` receipt; omitting it affects no kept tool —
  `check_order` works on `order_id` alone.)

Absence of both is asserted in tests at three levels: registry level
(`TOOL_DEFS` / `TOOL_NAMES` / `isKnownTool`), MCP layer (an
in-memory-transport `tools/list` response carries exactly the 5
built tools and deep-equals the fixture; `handleCallTool` and MCP
`tools/call` for each omitted tool are rejected before any network
hop), and CLI level (`cafeporch sign_guestbook '{}'` and
`cafeporch say_at_bar '{}'` each exit 2 with usage and are not listed
among the commands). The kept `order_drink` is a free simulated
order inside the fiction — only the caller's own self-chosen display
name for the cup, an optional model string and note; no payment is
taken or representable and nothing real-world is committed — and the
other four kept tools are pure reads.

## Fixture conflicts

**None.** The spec and the fixture agree on the tools' names,
descriptions, the absence of a `required` key on `get_menu`,
`read_guestbook` and `look_around`, the `name`/`drink` required
fields on `order_drink`, the `order_id` required field on
`check_order`, and the property sets and orders. The fixture already
excludes the two omitted tools, exactly as the spec's Omissions
section describes. One sibling difference, not a conflict: the
stillspa capture's schemas carry `additionalProperties: false`;
this capture carries no `additionalProperties` key, and the fixture
was followed verbatim.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://latentgrounds.com/mcp`.
- Env override `LATENTGROUNDS_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no auth
  header is ever sent, under any environment. Tests assert that no
  `Authorization` header (and no `X-API-Key` header) is sent with an
  empty environment, with a `LATENTGROUNDS_API_KEY`-style variable
  present, and with `AUTHORIZATION` / `API_KEY` /
  `LATENTGROUNDS_TOKEN` variables present.
- Error rendering `cafeporch error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; plain-JSON and SSE replies are both parsed. The
  forwarding core takes an injectable fetch; tests stub the
  upstream — no live network calls in tests, and no live call is
  claimed.

## Deviations — environment write-guard (read this)

One verification line could not be satisfied literally, for an
environment reason, documented here rather than papered over. The
VM's exec write guard (the intermittent EPERM/truncation fault
recorded in the workspace AGENTS.md) latched on during this build
and blocked file-derived writes by exec processes for the rest of
the session — it zeroed `npm ci`'s extracted files, refused tsc's
`dist` writes with TS5033 EPERM on all 15 outputs, and refused even
the parity harness's own `parity.json` write. Every affected
artifact was produced by an equivalent verified route instead:

- **Lockfile** — generated clean from birth (Route 3, below) before
  the latch engaged; never modified afterwards.
- **node_modules** — `npm ci --ignore-scripts --offline` was run as
  specified; the guard zeroed its extracted output (1,109 of 3,691
  files on the first run, all of them on re-runs). The tree was then
  restored by hardlink copy (`cp -al`) from the sibling stillspa
  build's `node_modules`, after programmatically verifying that
  stillspa's lockfile and cafeporch's lockfile resolve the identical
  version map (128/128 package entries, same versions throughout) —
  i.e. the exact tree cafeporch's own lockfile prescribes. Result:
  3,692 files, 13 zero-size (the same legitimately-empty files as
  the sibling tree).
- **dist/** — compiled by the real TypeScript compiler (same
  version and tsconfig as `npm run build` runs) with emit captured
  in memory via the compiler API (script at
  `/tmp/laneb6-cafeporch-scratch/emit.mjs`) and the captured outputs
  written through the file tool, which the guard does not affect.
  Every dist file was then hash-compared against a fresh captured
  emit (`/tmp/laneb6-cafeporch-scratch/check-dist.mjs`): all five
  `.d.ts` files byte-exact, all five `.js` files equal modulo one
  trailing newline, all five `.js.map` files JSON-equal with
  byte-identical `mappings` strings (key order canonicalised by the
  file tool). The capture compile reported zero diagnostics. A later
  literal `npm run build` attempt still exited 2 on the guard's
  EPERM and re-zeroed `dist/`; `dist/` was regenerated by the same
  verified bridge and re-verified. So: the compiler's verdict on
  this code is exit 0 (see `tsc --noEmit`, run twice, and the
  zero-diagnostic capture compile), but the `npm run build` command
  itself cannot complete its file writes in this environment at
  this time.
- **parity-out/** — the specified parity command was run; the
  harness's comparison completed but its own file writes were
  EPERM-blocked (it exited 1 at the `parity.json` write, before
  printing its verdict). The report was therefore produced by
  driving the harness's own `build_report` / `render_md` as a
  module and persisting its exact outputs through the file tool;
  `parity.json`'s formatting was compacted by the file tool, its
  content identical. Verdict and percentage are the harness's own:
  **PASS, 100.0**.

No other deviations.

## Lockfile

- Route: generated clean from birth in the build dir with no
  `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`
  (Route 3), then populated with `npm ci --ignore-scripts --offline`
  (see the write-guard note above for how the populated tree was
  restored after the guard zeroed the extraction).
- Parses as JSON; `name` == `@reneturcios/cafeporch`.
- Package entries: **128**.
- sha256: `1afcb566468939511557ba5a761a43d9317b518b7b9bb079ef7cb739f54f1c84`
  (verified unchanged after the `npm ci` run and again at the end of
  the build).

## server.json

- Description exactly: "A free espresso lounge for agents: read the menu, order a drink, check it, and read the guestbook." — **98 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/cafeporch:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio. Dockerfile
  (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/cafeporch"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/cafeporch`
  and its smoke test asserts the server name `cafeporch`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0 (run twice: before the build attempts
   and again on the finished tree).
2. `npm run build` → **blocked by the environment write guard**:
   tsc reports TS5033 EPERM on all 15 outputs and exits 2 (see
   Deviations). The identical compiler + tsconfig compile with emit
   captured in memory completed with zero diagnostics and
   `emitSkipped: false`, and its outputs — hash-verified against the
   captured emit as described above — are the `dist/` on disk
   (cli, forward, index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **73 tests, 73 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 5
   tools; the omission suite asserts `sign_guestbook` and
   `say_at_bar` absent at registry, MCP-layer — tools/list and
   tools/call — and CLI level; plus session handling/reuse, env
   override, the no-Authorization-header assertions under every
   environment, verbatim argument forwarding and result pass-through
   including upstream isError, SSE parsing, error rendering,
   MCP-layer validation, and CLI behaviour).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/latentgrounds-cafe-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/cafeporch/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/cafeporch/parity-out` → the harness's comparison gives **verdict PASS, parity 100.0**
   (5/5 identical, 0 missing, 0 extra, no schema diffs); its file
   writes were guard-blocked and the outputs in `parity-out/` were
   persisted from the harness's own computed report (see
   Deviations).
