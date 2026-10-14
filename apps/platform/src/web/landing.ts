import { html } from '@kvarm/ui';

export function landingPage(origin: string): string {
  const mcpUrl = `${origin}/mcp`;
  return html`
<section class="hero-x wrap m-human" id="top" aria-labelledby="human-title">
  <div class="hero-x-grid">
    <div>
      <p class="stamp"><b>[ 00 ]</b> Git for people and their agents</p>
      <h1 class="h1" id="human-title">One tree.<br><span class="ink">Many hands.</span></h1>
    </div>
    <div class="actions">
      <p class="lede">Coordinate work across repositories. Agents declare intent, inspect overlap and propose changes; people handle the approvals and escalations that need a decision.</p>
      <div class="flex gap2">
        <a class="btn btn-primary" href="/auth/login">Sign in</a>
        <a class="btn" href="#how">How it works</a>
      </div>
      <p class="sub">Sign-in and identity are handled by WorkOS.</p>
    </div>
  </div>
  <div class="app frame" role="img" aria-label="Example Kvarm review screen for example/api">
    <i class="c-tr"></i><i class="c-bl"></i>
    <div class="app-bar"><svg class="mark" aria-hidden="true"><use href="#mark"/></svg><span class="mono crumbs"><span class="steel">example /</span> <b class="bone">api</b></span><span class="spacer"></span><span class="tag">Example</span></div>
    <div class="screen-hud hud"><span>Example</span><span>Review · example/api</span></div>
    <div class="hfield">
      <section class="hcol">
        <h3 class="hh">Needs a decision</h3>
        <article class="ask">
          <p class="ask-q">Review the proposed request validation change</p>
          <p class="ask-why">Example review item. Inspect the candidates and checks before choosing an outcome.</p>
          <a class="btn btn-primary btn-sm" href="#product">View example</a>
        </article>
      </section>
      <section class="hcol">
        <h3 class="hh">Workspace activity</h3>
        <ul class="work">
          <li><b>Example intent</b><span>src/api/ · declared paths</span></li>
          <li><b>Example candidate</b><span>Request validation · review pending</span></li>
          <li><b>Example decision</b><span>Recorded with its reason</span></li>
        </ul>
      </section>
    </div>
    <canvas class="ambient" data-ambient="orbit" aria-hidden="true"></canvas>
  </div>
</section>

<section class="hero-x wrap m-agent" aria-labelledby="agent-title">
  <div class="hero-x-grid">
    <div>
      <p class="stamp"><b>[ 00 ]</b> MCP · REST · CLI</p>
      <h1 class="h1" id="agent-title">Start with<br><span class="ink">intent.</span></h1>
    </div>
    <div class="actions">
      <p class="lede">Declare the paths your workspace will touch. Kvarm can forecast overlapping work before you write, then keep decisions and reasons available as context.</p>
      <p class="sub">MCP endpoint: <a class="mono" href="${mcpUrl}">${mcpUrl}</a></p>
      <a class="btn btn-primary" href="/mcp">Connect over MCP</a>
    </div>
  </div>
  <div class="term frame">
    <div class="term-head hud"><span>Example commands · example/api</span><span>CLI</span></div>
    <pre><span class="prompt">$</span> kvarm workspace create example/api --task "Add request validation" --intent '{"paths":["src/api/"]}'
<span class="prompt">$</span> kvarm nexus forecast example/api --paths src/api/
<span class="prompt">$</span> kvarm decision context example/api --path src/api/</pre>
  </div>
</section>

<section class="sec wrap" id="how">
  <p class="stamp"><b>[ 01 ]</b> A shared workflow</p>
  <div class="thesis">
    <h2 class="h1">Work in parallel.<br><span class="ink">Keep one source of truth.</span></h2>
    <p class="thesis-copy lede">Workspaces make parallel changes visible. Intent forecasts surface possible overlap; composed work is checked on the exact tree that would ship.</p>
  </div>
  <ol class="steps">
    <li><span class="n">01</span><h3>Describe</h3><p>Create a workspace for a task and declare the paths it expects to change.</p></li>
    <li><span class="n">02</span><h3>Forecast</h3><p>Review declared and observed overlap before writing. Semantic matches are advisory.</p></li>
    <li><span class="n">03</span><h3>Develop</h3><p>Agents work in their own server-side workspace refs and can pin to an exact revision.</p></li>
    <li><span class="n">04</span><h3>Compare</h3><p>Compare candidate attempts and compose compatible pieces into one change.</p></li>
    <li><span class="n">05</span><h3>Check</h3><p>Required checks run against the exact composed tree before publication.</p></li>
    <li><span class="n">06</span><h3>Remember</h3><p>Decisions and reasons are recorded for the next person or agent.</p></li>
  </ol>
  <p class="youcome"><b>People stay in control.</b> Required approvals and escalations are handled by people.</p>
</section>

<section class="sec wrap" id="product">
  <p class="stamp"><b>[ 02 ]</b> Product · illustrative screens</p>
  <div class="screen-label hud"><span class="tag">Example</span> Field · example/api</div>
  <div class="app frame">
    <i class="c-tr"></i><i class="c-bl"></i>
    <div class="app-bar"><svg class="mark" aria-hidden="true"><use href="#mark"/></svg><span class="mono crumbs">example / <b class="bone">api</b> · field</span><span class="spacer"></span><span class="hud">EXAMPLE</span></div>
    <div class="field-body">
      <section class="territory">
        <div class="t t-xl"><b>src/api/handlers.ts</b><span>Example declared path</span></div>
        <div class="t"><b>src/api/validation.ts</b><span>Example workspace intent</span></div>
        <canvas class="ambient" data-ambient="field" aria-hidden="true"></canvas>
      </section>
      <aside class="panel">
        <div class="panel-head hud"><b>Example overlap review</b><span>example/service</span></div>
        <p class="panel-copy">A possible path overlap is shown for review. Forecasts are advisory.</p>
        <div class="panel-row"><span class="mono">src/api/handlers.ts</span><span class="tag">Example</span></div>
      </aside>
    </div>
  </div>

  <div class="split">
    <div>
      <div class="screen-label hud"><span class="tag">Example</span> Intent · example/worker</div>
      <div class="mock frame">
        <div class="mock-bar hud">example/worker <span class="tag">Example</span></div>
        <div class="mock-content">
          <p class="hud">Workspace intent</p>
          <h3>Update request validation</h3>
          <p class="mono">src/api/</p>
          <div class="mock-rule"><span>Potential overlap</span><b>src/api/handlers.ts</b></div>
          <p class="sub">Illustrative forecast output · review before writing.</p>
        </div>
      </div>
      <p class="screen-cap">Declare intent, then inspect overlap evidence before work begins.</p>
    </div>
    <div>
      <div class="screen-label hud"><span class="tag">Example</span> Decisions · example/api</div>
      <div class="mock frame">
        <div class="mock-bar hud">example/api <span class="tag">Example</span></div>
        <div class="mock-content">
          <p class="hud">Example change · request validation</p>
          <h3>Compare candidates</h3>
          <div class="mock-rule"><span>Candidate A</span><b>Example workspace</b></div>
          <div class="mock-rule"><span>Candidate B</span><b>Example workspace</b></div>
          <div class="mock-rule"><span>Checks</span><b>Run on the composed tree</b></div>
        </div>
      </div>
      <p class="screen-cap">Recorded decisions preserve the selected or rejected approach and its reason.</p>
    </div>
  </div>
</section>

<section class="sec wrap" id="agents">
  <p class="stamp"><b>[ 03 ]</b> People and agents · shared tools</p>
  <div class="split">
    <div>
      <h2 class="h1">Bring work.<br><span class="ink">Keep context.</span></h2>
      <p class="lede">Kvarm exposes repository operations through MCP, REST and the CLI. Agents use scoped identities and repository grants; people can revoke access.</p>
      <ul class="harness" aria-label="Interfaces"><li>MCP</li><li>Git smart HTTP</li><li>REST</li><li>kvarm CLI</li></ul>
    </div>
    <ol class="hlist">
      <li id="connect"><span class="n">01</span><div><b>Connect through MCP</b><p>Use the endpoint at <a class="mono" href="${mcpUrl}">${mcpUrl}</a>.</p></div></li>
      <li><span class="n">02</span><div><b>Declare an intent</b><p>List the paths a workspace expects to touch, then review the advisory forecast.</p></div></li>
      <li><span class="n">03</span><div><b>Carry decisions forward</b><p>Read recorded choices and reasons before repeating prior work.</p></div></li>
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
          <a class="btn btn-primary m-agent" href="/mcp">Connect to MCP <span aria-hidden="true">→</span></a>
          <p class="sub m-human">Choose the repositories an agent may access.</p>
          <p class="sub mono m-agent">${mcpUrl}</p>
        </div>
      </div>
    </div>

    <dl class="plate hud" aria-label="Platform facts">
      <div><dt>Storage</dt><dd>Cloudflare Artifacts</dd></div>
      <div><dt>Protocols</dt><dd>MCP · Git smart HTTP · REST</dd></div>
      <div><dt>Identity</dt><dd>WorkOS</dd></div>
      <div><dt>License</dt><dd>MIT</dd></div>
      <div><dt>UTC</dt><dd class="tabular" id="ft-clock">--:--:--</dd></div>
    </dl>

    <div class="rail" aria-hidden="true"><div class="rail-track"><i></i><i></i><i></i><i></i><i></i></div></div>

    <div class="ft-mark" aria-hidden="true"><svg class="mark"><use href="#mark"/></svg><span class="wordmark-foot">KVARM</span></div>
    <div class="ft-cols">
      <nav aria-label="Product"><p class="hud">Product</p><a href="#how">How it works</a><a href="#product">Example screens</a><a href="#agents">Interfaces</a></nav>
      <nav aria-label="For agents"><p class="hud">For agents</p><a href="/mcp">MCP endpoint</a><a href="#connect">Connection details</a></nav>
      <nav aria-label="Page"><p class="hud">Page</p><a href="#top">Back to top ↑</a><a href="/auth/login">Sign in</a></nav>
    </div>
    <div class="ft-sign hud"><span>Kvarm · git for people and their agents</span><span>MIT</span><span>MCP · Git smart HTTP · REST</span></div>
  </div>
</footer>
`;
}
