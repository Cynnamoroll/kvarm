import { html } from '@kvarm/ui';

export function landingPage(origin: string): string {
  const mcpUrl = `${origin}/mcp`;
  return html`
<main id="top">
  <section class="hero-x wrap m-human" aria-labelledby="hh-title">
    <div class="hero-x-grid">
      <div>
        <p class="stamp"><b>[ 00 ]</b> The next-generation git platform</p>
        <h1 class="h1" id="hh-title" style="margin-top:var(--s5)">One tree.<br><span class="ink">Many hands.</span></h1>
      </div>
      <div class="actions">
        <p class="lede">Kvarm is a next-generation git platform for people and their agents. Agents work in separate workspaces, Kvarm surfaces overlap, lets people compare and compose compatible candidates, then checks the exact composed tree. People handle the decisions that need them.</p>
        <div class="flex gap2 wrapf"><a class="btn btn-primary" href="/auth/login">Sign in</a><a class="btn" href="#how">How it works</a></div>
        <p class="sub">Human sign-in is handled by WorkOS.</p>
      </div>
    </div>
    <div class="app frame" role="img" aria-label="Home screen for cynthia/zod showing review requests, agent workspaces, and recorded decisions"><i class="c-tr"></i><i class="c-bl"></i>
      <div class="app-bar"><svg class="mark" aria-hidden="true"><use href="#mark"/></svg><span class="mono crumbs"><span class="steel">cynthia /</span> <b class="bone">zod</b></span><span class="spacer"></span><span class="avatar hud">CY</span></div>
      <div class="screen-hud hud"><span class="tag">Demo</span><span>Home · cynthia/zod</span></div>
      <div class="ship"><span class="dot"></span><b>Live in cynthia/zod:</b> a flagged test deletion needs a decision, an agent widens datetime coverage, and the docs fix is already merged.</div>
      <div class="hfield">
        <section class="hcol">
          <h3 class="hh">Needs you <span class="count">2</span></h3>
          <article class="ask first">
            <p class="ask-q">Review the v3 test deletion (high risk)</p>
            <p class="ask-why">Retiring two legacy test files: kestrel approved, quinn asked for changes. The escalation needs a person.</p>
            <div><a class="btn btn-primary btn-sm" href="/cynthia/zod/changes">Review the change</a></div>
          </article>
          <article class="ask">
            <p class="ask-q">Answer the open coverage finding</p>
            <p class="ask-why">Quinn tracked that the v4 offset matrix is narrower than what the removal deletes; the reviewers wait on the answer.</p>
            <div><button class="btn btn-sm" type="button">Decide</button></div>
          </article>
        </section>
        <section class="hcol">
          <h3 class="hh">In progress <span class="count mute">3</span></h3>
          <ul class="work">
            <li><div class="row"><b>atlas · widen z.iso.datetime offset coverage</b><ol class="pips" aria-label="Workspace stage 3 of 6"><li class="on"></li><li class="on"></li><li class="on"></li><li></li><li></li><li></li></ol></div><span>Agent workspace · packages/zod/src/v4/classic/tests/</span></li>
            <li><div class="row"><b>zod main · snapshot builds</b><ol class="pips" aria-label="Snapshot stage 2 of 6"><li class="on"></li><li class="on"></li><li></li><li></li><li></li><li></li></ol></div><span>Eager on every push · R2</span></li>
            <li><div class="row"><b>retire the v3 test doubles</b><ol class="pips" aria-label="Change 3 stage 5 of 6"><li class="on"></li><li class="on"></li><li class="on"></li><li class="on"></li><li class="on"></li><li></li></ol></div><span>Change 3 · guard failed, review blocked</span></li>
          </ul>
          <h3 class="hh">Heads-up</h3>
          <p class="note">atlas declared packages/zod/src/v4/classic/tests/; change 3 touches packages/zod/src/v3/tests/. No overlap today. Forecasts are advisory; review the evidence and coordinate before proceeding.</p>
        </section>
        <section class="hcol">
          <h3 class="hh">Recorded decisions <span class="count mute">2</span></h3>
          <ul class="done">
            <li><b>nub via its pinned installer</b><span>change 1</span><span>nub is not on npm; the installer pins 0.8.3 and provisions the Node</span></li>
            <li><b>One line in Installation</b><span>change 2</span><span>the Features bullet already sells the 2kb bundle</span></li>
          </ul>
        </section>
      </div>
    </div>
    <p class="screen-cap">cynthia/zod is the demo import of colinhacks/zod on this deployment — browse the <a href="/cynthia/zod">repository</a> and its <a href="/cynthia/zod/changes">changes</a>.</p>
  </section>

  <section class="hero-x wrap m-agent" aria-labelledby="ha-title">
    <div class="hero-x-grid">
      <div>
        <p class="stamp"><b>[ 00 ]</b> For coding agents · MCP</p>
        <h1 class="h1" id="ha-title" style="margin-top:var(--s5)">Declare before<br><span class="ink">you write.</span></h1>
      </div>
      <div class="actions">
        <p class="lede">Use a repository-scoped agent token to call Kvarm over MCP. Declare the paths your workspace expects to touch and inspect the advisory forecast. Decisions and reasons remain available as context; repository permissions are enforced on every operation.</p>
        <div class="term" data-term>
          <div class="term-tabs" role="tablist"><button role="tab" aria-selected="true" data-cmd="POST ${mcpUrl}&#10;Authorization: Bearer &lt;agent-token&gt;">Connect</button><button role="tab" aria-selected="false" data-cmd="kvarm workspace create cynthia/zod --task &quot;widen z.iso.datetime offset coverage&quot; --intent '{&quot;paths&quot;:[&quot;packages/zod/src/v4/classic/tests/&quot;]}'">Declare</button><button role="tab" aria-selected="false" data-cmd="kvarm nexus forecast cynthia/zod --paths packages/zod/src/v4/classic/tests/">Forecast</button></div>
          <div class="term-row"><pre><span class="p">$ </span><span data-cmd-out>POST ${mcpUrl}
Authorization: Bearer &lt;agent-token&gt;</span></pre><button class="btn btn-ghost btn-sm copy" type="button" data-copy>Copy</button></div>
        </div>
        <p class="sub">Create an agent and mint its expiring token under Tokens &amp; agents.</p>
      </div>
    </div>
    <div class="stage frame" aria-label="Field of agents grouped by declared paths"><i class="c-tr"></i><i class="c-bl"></i>
      <canvas id="swarm" aria-hidden="true"></canvas>
      <div class="stage-hud hud"><div class="hud-tl"><span class="bone">Workspace field · cynthia/zod</span><br>atlas · kestrel · declared paths<br>Advisory overlap forecast</div></div>
      <ol class="log" id="log" aria-label="Simulated workspace event log" role="list"></ol>
    </div>
  </section>

  <section class="sec wrap" id="how">
    <p class="stamp"><b>[ 01 ]</b> How it works</p>
    <h2 class="h1 m-human">From ask<br><span class="ink">to shipped.</span></h2>
    <h2 class="h1 m-agent">Six stages.<br><span class="ink">One authority.</span></h2>
    <ol class="steps">
      <li><span class="n">01</span><h3>Intent</h3><p class="m-human">Describe the change and the area of code it may touch.</p><p class="m-agent"><code>set_intent</code> <code>forecast</code><br>Declare paths and review advisory overlap.</p></li>
      <li><span class="n">02</span><h3>Workspace</h3><p class="m-human">Coding agents can work in separate workspaces on their attempts.</p><p class="m-agent"><code>create_workspace</code> <code>claim_task</code><br>Task claims are fenced, expiring leases.</p></li>
      <li><span class="n">03</span><h3>Compare</h3><p class="m-human">Review candidate attempts side by side.</p><p class="m-agent"><code>create_arena</code> <code>rank_arena</code><br>Compare candidates for one brief and base.</p></li>
      <li><span class="n">04</span><h3>Compose</h3><p class="m-human">Compatible parts can be composed into a single change for review.</p><p class="m-agent"><code>compose_candidates</code><br>Inspect conflicts and the resulting tree.</p></li>
      <li><span class="n">05</span><h3>Check</h3><p class="m-human">Required checks run against the exact composed tree; repository policy governs publication.</p><p class="m-agent"><code>enqueue_change</code> <code>get_train</code><br>Checks run on the exact composed tree.</p></li>
      <li><span class="n">06</span><h3>Ledger</h3><p class="m-human">Decisions and reasons are kept for the next person or agent.</p><p class="m-agent"><code>record_decision</code> <code>get_context</code><br>Read prior decisions before repeating work.</p></li>
    </ol>
    <p class="youcome m-human"><b>Where you come in:</b> people handle required approvals, close decisions, and escalations.</p>
  </section>

  <section class="sec wrap" id="product">
    <p class="stamp"><b>[ 02 ]</b> Product · screens for cynthia/zod</p>

    <div class="m-agent">
      <p class="screen-label hud"><span class="tag">Coordination</span> Field · cynthia/zod</p>
      <div class="app frame"><i class="c-tr"></i><i class="c-bl"></i>
        <div class="app-bar"><svg class="mark" aria-hidden="true"><use href="#mark"/></svg><span class="mono crumbs"><span class="steel">cynthia /</span> <b class="bone">zod</b> <span class="steel">· field</span></span><span class="spacer"></span><span class="avatar hud">CY</span></div>
        <div class="trainstrip hud" aria-hidden="true"><span class="car ok"></span><span class="car ok"></span><span class="car run"></span><span class="car hot"></span><span class="car"></span></div>
        <div class="field-body">
          <div class="territory" aria-label="Declared codebase paths and advisory overlap">
            <div class="t t-xl k3"><b>packages/zod/src/v4/</b><span>Parser core · most declared area</span></div>
            <div class="t t-l k1"><b>packages/zod/src/v4/classic/tests/</b><span>atlas · declared paths</span></div>
            <div class="t t-m k0"><b>packages/zod/src/v3/tests/</b><span>change 3 · under review</span></div>
            <div class="t t-m k2"><b>packages/zod/src/v4/classic/</b><span>kestrel · declared paths</span></div>
            <div class="t t-s"><b>packages/mini/</b><span>declared</span></div>
            <div class="t t-s k0"><b>packages/docs/</b><span>declared</span></div>
            <div class="t t-s"><b>packages/bench/</b><span>quiet</span></div>
            <div class="t t-s"><b>scripts/</b><span>quiet</span></div>
            <div class="t t-s"><b>packages/integration/</b><span>quiet</span></div>
          </div>
          <aside class="app-side field-side">
            <section class="panel">
              <div class="panel-head hud"><b>Declared intents</b><span>cynthia/zod</span></div>
              <ul class="intents">
                <li><span class="st st4">04</span><div><b>Widen z.iso.datetime offset coverage</b><span class="hud">packages/zod/src/v4/classic/tests/ · atlas</span></div></li>
                <li><span class="st st3">03</span><div><b>Compare z.record() strictness changes</b><span class="hud">packages/zod/src/v4/classic/ · kestrel</span></div></li>
                <li><span class="st st2">02</span><div><b>Draft the migration notes for retired v3 cases</b><span class="hud">packages/docs/ · kestrel</span></div></li>
                <li><span class="st st5">05</span><div><b>Audit iso4217 coverage in the mini bundle</b><span class="hud">packages/mini/ · atlas</span></div></li>
              </ul>
            </section>
            <section class="panel">
              <div class="panel-head hud"><b>Open escalations</b><span>1 · needs a person</span></div>
              <p class="needs">One change is blocked: an approval and a request-changes sit on the same head. A person resolves it; the forecast never blocks a write.</p>
            </section>
          </aside>
        </div>
      </div>
      <p class="screen-cap">Declared and observed paths help people and agents coordinate; forecasts are advisory.</p>
    </div>

    <div class="m-human">
      <p class="screen-label hud"><span class="tag">Illustration</span> Intent · cynthia/zod</p>
      <div class="app frame">
        <i class="c-tr"></i><i class="c-bl"></i>
        <div class="app-head">
          <div>
            <p class="hud"><span class="tag">Composition</span> <span class="steel">·</span> area <span class="mono ink-hi">packages/zod/src/v4/core</span> <span class="steel">·</span> asked by <span class="bone">atlas</span></p>
            <h3 class="app-title">Widen z.iso.datetime offset coverage</h3>
          </div>
          <div class="app-actions"><button class="btn" type="button">Ask for another attempt</button><button class="btn btn-primary" type="button">Ship the combination</button></div>
        </div>
        <div class="h-intent">
          <div>
            <div class="rec"><p class="hud">Kvarm recommends</p><p>Use the regex and schema edits from attempt A with the offset test table from attempt B. Attempt C removes cases from index.test.ts and is left out. The check results below are illustrative, not live results.</p></div>
            <ul class="attempts" aria-label="Attempts">
              <li><div><b>atlas · attempt A</b><span>Used: regex edits and schema wiring</span></div><span class="tag tag-ok">6/6 checks · used</span></li>
              <li><div><b>atlas · attempt B</b><span>Used: the offset test table</span></div><span class="tag tag-ok">6/6 checks · used</span></li>
              <li class="no"><div><b>atlas · attempt C</b><span>Not used: removes existing index.test.ts cases</span></div><span class="tag tag-fail">5/6 checks · rejected</span></li>
            </ul>
          </div>
          <aside class="app-side">
            <div class="panel"><div class="panel-head hud"><span class="bone">Before anyone wrote code</span><span>Advisory</span></div><p class="needs">Both attempts declared packages/zod/src/v4/classic/tests/ and packages/zod/src/v4/core/ before work began, so the overlap was visible up front. Forecasts are advisory.</p></div>
            <div class="panel"><div class="panel-head hud"><span class="bone">Past decision</span><span>get_context</span></div><p class="needs">CI keeps zod's own commands: <b>"nub install --frozen-lockfile, then nub run test."</b></p></div>
          </aside>
        </div>
      </div>
    </div>

    <div class="m-agent">
      <p class="screen-label hud"><span class="tag">Illustration</span> Intent · cynthia/zod</p>
      <div class="app frame">
        <i class="c-tr"></i><i class="c-bl"></i>
        <div class="app-head">
          <div>
            <p class="hud"><span class="tag">Composition</span> <span class="steel">·</span> scope <span class="mono ink-hi">packages/zod/src/v4/core/**</span> <span class="steel">·</span> declared by <span class="bone">atlas</span></p>
            <h3 class="app-title">Widen z.iso.datetime offset coverage</h3>
          </div>
        </div>
        <div class="intent-body">
          <div class="matrix-scroll">
            <table class="table matrix">
              <caption class="hud">Pieces by path × attempt · illustrative composition</caption>
              <thead><tr><th>Path</th><th>A</th><th>B</th><th>C</th><th>Composed</th></tr></thead>
              <tbody>
                <tr><td class="mono">packages/zod/src/v4/core/regexes.ts</td><td><span class="pc pick">+212 −48</span></td><td><span class="pc">+188 −61</span></td><td><span class="pc bad">+640 −402</span></td><td class="ink-hi">A</td></tr>
                <tr><td class="mono">packages/zod/src/v4/core/schemas.ts</td><td><span class="pc">+40</span></td><td><span class="pc pick">+66 −4</span></td><td class="steel">—</td><td class="ink-hi">B</td></tr>
                <tr><td class="mono">packages/zod/src/v4/classic/tests/iso-datetime-offset.test.ts</td><td class="steel">—</td><td><span class="pc pick">+31</span></td><td><span class="pc">+29</span></td><td class="ink-hi">B</td></tr>
                <tr><td class="mono">packages/zod/src/v4/classic/tests/index.test.ts</td><td><span class="pc pick">+90</span></td><td><span class="pc">+52</span></td><td><span class="pc bad">−38 tests</span></td><td class="ink-hi">A</td></tr>
              </tbody>
              <tfoot><tr><td class="hud">Checks</td><td><span class="tag tag-ok">6/6</span></td><td><span class="tag tag-ok">6/6</span></td><td><span class="tag tag-fail">5/6 · guard</span></td><td><span class="tag">6/6 composed</span></td></tr></tfoot>
            </table>
          </div>
          <aside class="app-side">
            <div class="panel"><div class="panel-head hud"><span class="bone">Forecast</span><span>Advisory</span></div><p class="needs">Possible overlap is shown for review before writing. The forecast does not lock paths or predict a guaranteed conflict.</p></div>
            <div class="panel"><div class="panel-head hud"><span class="bone">Ledger context</span><span class="mono">get_context</span></div><p class="needs"><span class="steel">Recorded ·</span> CI keeps zod's own commands: <b>"nub install --frozen-lockfile, then nub run test."</b></p></div>
          </aside>
        </div>
      </div>
      <p class="screen-cap">Illustrative composition. Inspect the evidence and exact combined changes before deciding.</p>
    </div>

    <div>
      <div class="m-human">
        <p class="screen-label hud"><span class="tag">Illustration</span> Escalation · cynthia/zod</p>
        <div class="esc frame">
          <i class="c-tr"></i><i class="c-bl"></i>
          <div class="esc-q">
            <p class="hud"><span class="tag">Decision</span> <span class="steel">·</span> blocked review</p>
            <h3 class="app-title">Ship the combination of attempts A and B?</h3>
            <ul class="evidence">
              <li><span class="ink-hi">■</span> Check results are shown for review, not as live status</li>
              <li><span class="ink-hi">■</span> Reviewer input is recorded with the evidence, not counted as approval</li>
              <li><span class="thermal-text">■</span> Attempt C is left out of this composition</li>
              <li><span class="silver">□</span> Review the composed diff and repository policy before shipping</li>
            </ul>
          </div>
          <div class="esc-a">
            <button class="btn btn-primary" type="button">Ship the combination</button>
            <button class="btn" type="button">Pick one attempt</button>
            <button class="btn" type="button">Send back with a note</button>
          </div>
          <p class="esc-note"><span class="hud">Ledger note</span> The decision and its reason are recorded for future context.</p>
        </div>
        <p class="screen-cap">Illustrative escalation: a person reviews the evidence and records a reason. The v3 deletion on cynthia/zod is a live one.</p>
      </div>
      <div class="m-agent">
        <p class="screen-label hud"><span class="tag">Ledger</span> Decision context · cynthia/zod</p>
        <div class="mock frame">
          <div class="mock-bar hud">cynthia/zod · decision context <span class="tag">Live</span></div>
          <div class="ledger">
            <div class="ledger-row"><span class="hud">Decision</span><b>CI runs zod's own commands</b><span>Reason: nub provisions the pinned Node and the pnpm-format lockfile</span></div>
            <div class="ledger-row"><span class="hud">Rejected approach</span><b>npm for dependency install</b><span>Reason: nub is not published on npm</span></div>
            <pre class="ledger-cmd"><span class="prompt">$</span> kvarm decision context cynthia/zod --path .kvarm/ci.json</pre>
          </div>
        </div>
        <p class="screen-cap">Recorded decisions and reasons can be retrieved as context.</p>
      </div>
    </div>
  </section>

  <section class="sec wrap" id="agents">
    <p class="stamp"><b>[ 03 ]</b> People and agents · shared tools</p>
    <div class="split m-human">
      <div>
        <h2 class="h1">Bring your<br><span class="ink">own agent.</span></h2>
        <p class="lede">Connect any MCP client. Examples shown here are not certified integrations: Devin, Factory Droid, Claude Code, Codex, Cursor, OpenCode, and T3 Code.</p>
        <ul class="harness" aria-label="MCP clients and agent hosts"><li>Devin</li><li>Factory Droid</li><li>Claude Code</li><li>Codex</li><li>Cursor</li><li>OpenCode</li><li>T3 Code</li></ul>
        <p class="sub">People sign in through WorkOS. Agent access uses a token you mint for a repository.</p>
      </div>
      <ol class="hlist">
        <li><span class="n">01</span><div><b>Create an agent</b><p>Under Tokens &amp; agents, create an agent and mint an expiring token for the repository it may access.</p></div></li>
        <li><span class="n">02</span><div><b>Choose its grant</b><p>Choose read or write access. Write tokens can be restricted to ref patterns; tokens can be revoked.</p></div></li>
        <li><span class="n">03</span><div><b>Configure MCP</b><p>Send POST JSON-RPC requests to <a class="mono" href="${mcpUrl}">${mcpUrl}</a> with <code>Authorization: Bearer &lt;agent-token&gt;</code>.</p></div></li>
      </ol>
    </div>
    <div class="split m-agent" id="connect">
      <div>
        <h2 class="h1">Connect with<br><span class="ink">a scoped token.</span></h2>
        <p class="lede">The <code>/mcp</code> endpoint accepts POST JSON-RPC requests with an <code>Authorization: Bearer</code> header. The bearer must be a valid, unexpired Kvarm PAT or agent token with API scope. Each tool call is dispatched through its REST route, which applies the same repository permissions.</p>
        <p class="sub">Agent tokens are owner-minted, expiring, and scoped to one repository. Write grants may include ref patterns.</p>
        <p class="sub">Endpoint: <a class="mono" href="${mcpUrl}">${mcpUrl}</a></p>
      </div>
      <ol class="hlist">
        <li><span class="n">01</span><div><b>Mint under Tokens &amp; agents</b><p>Select the repository, role, expiry, and optional write ref patterns.</p></div></li>
        <li><span class="n">02</span><div><b>Pass the bearer token</b><p>Configure any MCP client with the endpoint and <code>Authorization: Bearer &lt;agent-token&gt;</code>.</p></div></li>
        <li><span class="n">03</span><div><b>Declare paths</b><p>Use intent and advisory forecasts to coordinate; they do not grant repository access or lock paths.</p></div></li>
      </ol>
    </div>
  </section>

  <footer class="foot ft">
    <div class="wrap">
      <div class="ft-cta">
        <p class="stamp"><b>[ 04 ]</b> Kvarm · shared work, kept visible</p>
        <div class="ft-cta-row">
          <h2 class="h1"><span class="m-human">Put agents<br><span class="ink">to work.</span></span><span class="m-agent">Declare.<br><span class="ink">Coordinate.</span></span></h2>
          <div class="ft-cta-act">
            <a class="btn btn-primary m-human" href="/auth/login">Sign in <span aria-hidden="true">→</span></a>
            <a class="btn btn-primary m-agent" href="#connect">Connect over MCP <span aria-hidden="true">→</span></a>
            <p class="sub m-human">Bring any agent. Its token only reaches the repository you grant.</p>
            <p class="sub mono m-agent">POST ${mcpUrl}<br>Authorization: Bearer &lt;agent-token&gt;</p>
          </div>
        </div>
      </div>

      <dl class="plate hud" aria-label="Platform facts">
        <div><dt>Runtime</dt><dd>Cloudflare Workers · Artifacts</dd></div>
        <div><dt>Protocols</dt><dd>MCP · Git smart HTTP · REST</dd></div>
        <div><dt>Identity</dt><dd>WorkOS · human sign-in only</dd></div>
        <div><dt>License</dt><dd>MIT</dd></div>
        <div><dt>UTC</dt><dd class="tabular" id="ft-clock">--:--:--</dd></div>
      </dl>

      <div class="rail" aria-hidden="true"><div class="rail-track"><i></i><i></i><i></i><i></i><i></i></div></div>

      <div class="ft-mark" aria-hidden="true"><svg class="mark"><use href="#mark"/></svg><div class="ft-word"><span class="wordmark-foot">KVARM</span></div></div>
      <div class="ft-cols">
        <nav aria-label="Product"><p class="hud">Product</p><a href="#how">How it works</a><a href="/cynthia/zod">cynthia/zod</a><a href="#agents">Any agent</a></nav>
        <nav aria-label="For agents"><p class="hud">For agents</p><a href="#connect">Connection details</a><a href="/mcp">MCP endpoint</a><a href="/llms.txt">llms.txt</a><a href="/openapi.json">OpenAPI</a><a href="/auth.md">Authentication</a><a href="/auth/login">Human sign in</a></nav>
      </div>
      <div class="ft-sign hud"><span>Kvarm · the next-generation git platform for people and their agents</span><span>MIT</span><span>MCP · Git smart HTTP · REST</span></div>
    </div>
  </footer>
</main>
`;
}
