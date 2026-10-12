# Veyr-9 — aesthetic inspiration

Reference material for a collaborative paper-design session, **not a UI specification**. Borrow the visual language, not the source images' information architecture or implied data meanings.

Veyr-9 is the working platform name; Nexus is the coordination concept. Names are provisional; this is not a trademark-clearance claim.

## Sources

The local archive contains five supplied still images and one supplied video. The still-image observations below describe only visible cues; the video has not been viewed for motion.

| Local media | Visible subject |
| --- | --- |
| [bio-scan-orbital.jpg](bio-scan-orbital.jpg) | Luminous biological scan with orbital arcs |
| [orbital-event-map.jpg](orbital-event-map.jpg) | Orbital node field beside a compact event log |
| [temporal-flow-dashboard.jpg](temporal-flow-dashboard.jpg) | Wide temporal relationship map and instrument strip |
| [temporal-flow-detail.jpg](temporal-flow-detail.jpg) | Close-up of the temporal relationship field |
| [catalog-depth-map.jpg](catalog-depth-map.jpg) | Perspective catalog plot |
| [post-2107553909162356906-poster.jpg](post-2107553909162356906-poster.jpg) | Existing still with query, catalog, and ownership panels |
| [post-2107553909162356906-video-1080p.mp4](post-2107553909162356906-video-1080p.mp4) | Existing local video; SHA-256 matches the supplied video, so no duplicate was saved. Not viewed for motion. |

All filenames above are relative to `<repo-root>/planning/aesthetic/`.

## Visual observations

Colors are approximate visual estimates, not sampled design tokens. Text sizes describe the supplied image scale, not proposed CSS sizes. Small labels are sometimes too faint to read confidently.

### Bio scan — orbital biology image

[bio-scan-orbital.jpg](bio-scan-orbital.jpg)

- **Field:** a near-black ground frames a luminous biological subject, with blue and cyan light, magenta-violet areas, and warm orange-pink highlights.
- **Geometry:** fine wireframe orbit arcs loop around the subject. Hairline rectangular callouts and small uppercase monospace section labels sit over the image.
- **Use as reference:** the bright scan can inspire a focused focal point surrounded by precise, quiet annotation. The image does not establish any data or status semantics.

### Orbital event map — node field and log

[orbital-event-map.jpg](orbital-event-map.jpg)

- **Layout:** a near-black, wide composition pairs a dense orbital node-and-thread field on the left with a narrow event-log column on the right.
- **Geometry and light:** faint orbital arcs and fine connections surround clustered pale nodes; a muted red glow accents part of the field. Small monospace labels remain subordinate to the visualization.
- **Use as reference:** combine a relational overview with a compact textual stream, keeping the linework delicate and the annotations legible.

### Temporal flow dashboard — panoramic connection map and instrument strip

[temporal-flow-dashboard.jpg](temporal-flow-dashboard.jpg)

- **Layout:** a nearly full-width relationship visualization occupies roughly the upper two-thirds. A small issue-like ledger sits at upper left. Red ring nodes step diagonally upward from the left; teal ring nodes form a vertical cluster near the center. Hundreds of fine connections converge toward a bowed, slanted date ribbon, then fan outward to the right.
- **Lower strip:** five adjoining instrument panels: catalog, owners, arrivals, a dotted globe-like graphic, and stream. The catalog previews the spike plot enlarged in the [catalog depth map](catalog-depth-map.jpg); owners is a tiny list; arrivals is a sparse starfield; stream resembles timestamped terminal output.
- **Palette:** near-black `#080A09`, charcoal panel fill `#0E1110`, hairlines `#242827`, subdued gray `#707974`, off-white `#C5CCC8`, teal `#28B79C`, and vermilion `#DA4437`. Thin red and teal traces carry almost all the chromatic energy.
- **Typography:** narrow, technical monospaced text, mostly regular/light weight; tiny identifiers, timestamps, and ledger rows (roughly 5–9 image pixels). Uppercase section labels are widely tracked. There is no oversized headline competing with the data.
- **Density:** very high relationship density above, with deliberate black negative space around node groups. The bottom tiles turn that complex field into bounded, local readings.
- **Borders/lines:** extremely thin rectangular panel divisions; almost invisible rounded outer corners; a faint horizontal ruler separates map and instruments. Connection lines are sharper than the enclosing chrome.
- **Iconography:** outlined circles for entities, small colored squares for panel markers, points for activity. Little conventional pictorial iconography; geometry does the labeling work.
- **Motion cues:** the fan of traces and tilted date band imply flow and navigation through time; the globe and arrivals field suggest live instruments. These are still-image cues, not verified animation behavior.
- **Notable pattern:** one large connective overview plus small, specialized readouts. Relationships are the hero; individual objects remain addressable through IDs.

### Temporal flow detail — close-up of the connective field

[temporal-flow-detail.jpg](temporal-flow-detail.jpg)

- **Layout:** cropped into the main map. Red ID nodes climb diagonally across the left; teal owner/device-like labels and ring nodes stack toward the right. A dark, curved date rail cuts down the far-right edge.
- **Connections:** long, almost horizontal red traces meet a tightly interwoven bundle of teal and gray threads. The composition is asymmetrical: open black space at left, dense crossings near the temporal boundary.
- **Palette:** black `#080A09`, gray threads around `#545C58`, faint rail text `#909892`, teal `#2ABDA3`, red `#E24638`, and pale labels `#C9D0CC`. No filled neon surfaces or colorful gradients.
- **Typography:** compact mono identifiers, short names, dates, and secondary counts; about 8–12 image pixels for the larger labels. Regular weight, narrow glyphs, mixed case for names, color-matched small labels above red nodes.
- **Density:** relationships are dense but nodes are spatially separated. A tiny footer contains aggregate totals, rather than a large summary card.
- **Borders/lines:** ring outlines are about one pixel; threads vary in brightness rather than thickness. The date rail has a stronger dark silhouette than any panel frame.
- **Iconography:** ring size varies; one lower node uses a dotted perimeter rather than a continuous teal ring. That is a useful visual distinction, but its actual status meaning is not established.
- **Motion cues:** the skewed rail and long traces create a sense of scrubbing or looking obliquely through a time slice. Subtle scanline-like texture adds an analog-monitor feeling.
- **Notable pattern:** identity and connectivity share a single visual plane. This suggests provenance without relying on profile portraits, cards, or chat bubbles.

### Catalog depth map — catalog as a spatial instrument

[catalog-depth-map.jpg](catalog-depth-map.jpg)

- **Layout:** one large framed panel, titled `CATALOG` at upper left after a teal square. A perspective trapezoid occupies the lower-middle area, containing a cloud of tiny gray square points and upright red/teal stems capped by circles.
- **Axes/readings:** visible labels include `7d`, `30d`, `90d`, `desktop`, and `tui`; a large, very faint `1,201` appears at bottom left. These imply temporal and environment groupings, but the plot's precise semantics should not be assumed.
- **Palette:** background `#090C0B`, panel border `#272D29`, gray particles `#626B65`, faint total `#202823`, red `#D9473A`, teal `#29B99D`, and heading `#CDD3CD`.
- **Typography:** narrow mono; uppercase heading with generous letter spacing (roughly 18–22 image pixels); plot labels roughly 14–18 pixels; total much larger but deliberately low emphasis. All are light/regular rather than bold.
- **Density:** sparse upper half, highly populated plot toward the right/back edge. A few tall red stems punctuate the field; many shorter teal stems stay near the plane.
- **Borders/lines:** a hairline rounded rectangular frame; thin perspective grid divisions. Tall stems use saturated color while the grid nearly disappears.
- **Iconography:** square particles, circular endpoints, vertical stems, one square title marker. It feels like measurement equipment, not a decorative illustration.
- **Motion cues:** perspective and varied stem heights suggest rotation, reveal, or live updates, but none can be confirmed from the still. Horizontal texture gives the panel a softly scanned appearance.
- **Notable pattern:** a quiet container around a visually rich local model; a count is present without becoming a headline.

### Video poster — query, catalog, and ownership

[post-2107553909162356906-poster.jpg](post-2107553909162356906-poster.jpg)

- **Layout:** a thin top ruler sits above a framed command/query row reading `› is:issue is:open`. Beneath it, a wide catalog plot occupies about three-quarters of the panel; a narrow `OWNERS` list occupies the right quarter.
- **Catalog:** another perspective point cloud with red and teal stems, gray/white endpoints, age labels, and `desktop`/`tui` annotations. It is angled differently from photo 3 and appears more compact.
- **Owners:** names such as `maria@studio`, `dev@desk`, and `sam@laptop` appear above rows of small filled circles; most circles are white, with a teal row near the bottom. Their meanings are not established by the image.
- **Palette:** almost-black `#090C0B`, subtle frame/divider `#29312C`, muted gray `#78817B`, pale text/dots `#D7DEDA`, teal `#2CBD9F`, and red `#DF493C`.
- **Typography:** all visibly mono, narrow and regular; query roughly 15–18 image pixels, names roughly 13–16, uppercase panel headings roughly 12–15 with wide tracking. Numeric totals are large, dark, and recessive.
- **Density:** compact and information-rich, but cleanly partitioned. The command row gives the scene an explicit scope; the adjacent owners list explains one aspect of the plotted field.
- **Borders/lines:** subtle rounded outer frame, straight vertical divider, restrained horizontal rules. No raised cards, chunky shadows, or filled toolbar buttons.
- **Iconography:** prompt chevron, teal heading squares, white/teal dot rows, plot endpoints. Repeated geometry forms a consistent vocabulary.
- **Motion cues:** the associated video was not viewed; transitions, timing, camera movement, and interaction are unverified. Do not treat the differing plot angles across images as evidence of a particular animation.
- **Notable pattern:** textual query → scoped visual field → compact ownership readout. The interface feels operable, not merely cinematic.

## Core aesthetic

- **Connective tissue:** fine threads bind nodes, time, and activity into a coherent whole. For Veyr-9, this could connect code, agent, session, candidate, checks, and merge outcome.
- **Intelligence through relationships:** many small signals coexist in one organized field; sophistication comes from visible connections, not a large “AI” badge.
- **Focused darkness:** near-black surfaces and subdued chrome recede, leaving selected nodes and meaningful traces in relief.
- **Restricted signal palette:** teal, red, and neutral light points feel purposeful. Their source meanings are unknown; Veyr-9 needs its own explicit semantics.
- **Instrument-panel precision:** mono labels, stable alignment, thin rules, small totals, and specialized readouts evoke a workstation measuring ongoing work.
- **Agentic rather than conversational:** owners, temporal rails, commands, and streams suggest multiple actors progressing independently, not one chatbot dominating a page.
- **Controlled futurism:** perspective, fine threads, and monitor texture supply atmosphere without giant gradients, glass cards, or oversized marketing typography.

## Adapting to Veyr-9

Ideas to sketch and debate—not commitments to implement the screenshots literally.

| Veyr-9 surface | Possible translation |
| --- | --- |
| **Repo tree** | A compact mono file ledger with fine separators, understated directory glyphs, and a visible path spine. A selected file could expose its last agent/session and change-set membership in an adjacent detail rail. Keep filenames readable; do not turn the tree into a spatial graph. |
| **1M-LOC compare/diff** | Treat the diff as the main instrument: aligned gutters, crisp code, restrained addition/deletion tint, and a small change-distribution overview. A thin side rail can mark hunks, unresolved threads, and check-linked locations. Show loaded/windowed versus total scope honestly. |
| **Agent workspaces dashboard** | Bounded panels with workspace, branch/base, agent/session, current operation, last event, and snapshot readiness. A small connectivity overview may summarize shared bases or dependencies; the primary view remains a sortable list. |
| **Candidate compare** | Two equally sized, aligned lanes for two agents' attempts against the same base. Shared paths/hunks establish the connective spine; labels expose agent, session, candidate SHA, tests, and divergence. Distinguish candidates by lane labels/shapes, not red = bad and teal = good. |
| **Merge queue** | A readable ordered rail: candidate → checks → queued → merging → merged, with explicit dependencies and blocked reasons. Thin connectors may explain why an item waits; text must communicate ordering even without the diagram. |
| **Attribution/provenance** | An expandable commit ledger linking commit → git-notes attribution → agent/session → change set/workspace → snapshot. Small ring nodes could echo the references, but distinguish recorded attribution from verified identity; show missing notes explicitly. |
| **CI check runs** | A compact instrument strip/list of named checks, result, duration, attempt, and log link. Provide textual passed/failed/pending/canceled states with distinct symbols; a tiny timeline can convey parallel execution. |
| **MCP/agent activity feed** | Timestamped mono event rows grouped by workspace/session: tool or operation, target, result, and drill-down. A query row scopes the feed. Surface human-needed events above routine noise; distinguish tool activity from actual committed code changes. |

### Constraints that should shape the sketches

- **Zero client framework:** start with SSR HTML, one stylesheet, and small vanilla JS. Use semantic tables/lists, links, forms, and `<details>` for core navigation. A graph is optional enrichment, never the only way to find a commit or read status.
- **Large-diff performance:** preserve virtualized, fixed-height rows. Avoid wrapping, animated row heights, per-line effects, or rendering the million-line dataset into the DOM. A separate detail area can hold long annotations without disturbing row geometry.
- **Bounded visualizations:** render only a selected neighborhood or aggregated counts; never draw a line per changed line or every repository relationship. Small static SVG summaries may suffice where they add real information.
- **Contrast and type:** borrow the dark hierarchy, not the screenshots' near-illegible text. Target WCAG AA text contrast (4.5:1 for normal text, 3:1 for large text) and 3:1 for required UI boundaries/state graphics. Keep secondary labels legible, with visible keyboard focus.
- **Red/teal ambiguity:** reserve clear meanings for diff additions/deletions and operational results; use signs, words, and symbols in addition to hue. Teal should not simultaneously mean “agent,” “passed,” and “selected” without differentiation.
- **Motion restraint:** if useful, a short selection/focus transition can communicate a relationship. Avoid perpetual particles, spinning graphs, or scanline animation; honor reduced motion. Decorative texture must not interfere with code reading.
- **Stable operating surface:** retain selections and scroll position during activity updates. Explicit refresh or a restrained “new events” indicator is preferable to a feed that constantly rearranges under the user.
- **Atmosphere at the edges:** thin connective motifs belong in overviews and provenance, not behind source code. Veyr-9 should feel like a precise control room while remaining a fast git tool.

## Open questions for the paper session

- Is the main metaphor a connective map, a ledger/control room, or a hybrid—and which view should appear first when opening a repo?
- Which relationship is most valuable to expose visually: commit ancestry, agent/session provenance, candidate divergence, or merge dependencies?
- How much persistent density feels focused rather than exhausting? Which instruments deserve screen space versus on-demand expansion?
- Should teal be a brand accent, active selection, or a state color? How do we prevent conflicts with additions/deletions and checks?
- What must a reviewer see immediately when comparing two agents, and what evidence belongs one click away?
- How should missing attribution, uncertain identity, stale snapshots, and blocked work look without being mistaken for success or inactivity?
- Where, if anywhere, does a spatial graph outperform a list? What is its keyboard-accessible and narrow-screen equivalent?
- How much motion or monitor texture do we want after hours of reviewing code—and should the default be completely still?
