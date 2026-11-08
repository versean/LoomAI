"""Build deck.html from deck.src.html, pulling shared pieces from index.html.

Run:  python build-deck.py
Re-run it whenever the workflow figure or the FIG drawings change on the site.
"""
import re

site = open('index.html', encoding='utf-8').read()
deck = open('deck.src.html', encoding='utf-8').read()

# Workflow figure CSS (drop the site's layout helpers and media queries)
css = site[site.index('/* ───────── Workflow figure ───────── */'):site.index('/* Responsive */')]
css = re.sub(r'@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}\s*', '', css)
css = re.sub(r'\.wf-split[^}]*\}\s*|\.wf-points[^}]*\}\s*', '', css)

# Workflow figure markup
fig = site[site.index('<figure class="wf-fig"'):]
fig = fig[:fig.index('</figure>') + len('</figure>')]
# The deck matches the real backend, which connects Cursor, Claude Code and the Claude app (not Codex)
assert 'Sara <i>(Codex)</i>' in fig
fig = fig.replace('Sara <i>(Codex)</i>', 'Sara <i>(Claude app)</i>').replace("Sara's Codex", "Sara's Claude app")

# Flow figures: copies of the figure for the talk slides, one story each (<!--FLOW:mode-->).
# ids become data-n so several copies can live in one page; the deck's own script animates them.
def flow_figure(mode):
    f = re.sub(r'<figure class="wf-fig"[^>]*>', f'<figure class="wf-fig flow" data-mode="{mode}" aria-hidden="true">', fig, count=1)
    f = re.sub(r'\sid="wf-([a-z0-9]+)"', r' data-n="\1"', f)
    f = re.sub(r'<button class="wf-pause".*?</button>', '', f, flags=re.S)
    f = f.replace('<span>Loom AI</span>', '<span>Conductor</span>', 1)
    if mode.startswith('ex-'):
        f = re.sub(r'Dan <i>\([^)]*\)</i>', 'You <i>(Claude Code)</i>', f, count=1)
    return f


# Workflow figure script (self-contained IIFE)
js_start = site.index('/* ── Workflow figure')
js_end = site.index('})();', site.index('agentLoop(2', js_start)) + len('})();')
js = site[js_start:js_end]
if '<!--WF_FIGURE-->' not in deck:
    js = ''  # no slide shows the animated site figure any more

# FIG columns with line drawings
figs = site[site.index('<div class="figs">'):]
depth, i = 0, 0
for m in re.finditer(r'<div\b|</div>', figs):
    depth += 1 if m.group() == '<div' else -1
    if depth == 0:
        i = m.end(); break
figs = figs[:i].replace(' rv"', '"')
figs = figs.replace('<div class="figs">', '<div class="figs" data-stagger>', 1)

# Icon symbols the figure references (wf-person, wf-shield, ...)
symbols = '\n'.join(re.findall(r'<symbol id="wf-[^"]+".*?</symbol>', site, flags=re.S))
deck = deck.replace('<!--WF_SYMBOLS-->', '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>\n' + symbols + '\n</defs></svg>')

out = (deck.replace('/*WF_CSS*/', css)
           .replace('<!--WF_FIGURE-->', fig)
           .replace('/*WF_JS*/', js)
           .replace('<!--FIGS-->', figs))
out = re.sub(r'<!--FLOW:([a-z-]+)-->', lambda m: flow_figure(m.group(1)), out)
# The deck uses its own logo (the brain mark), including inside pieces pulled from the site
out = re.sub(r'assets/loom-mark\.png(\?v=\d+)?', 'assets/deck-mark.png?v=2', out)
out = re.sub(r'assets/favicon\.png(\?v=\d+)?', 'assets/deck-favicon.png?v=2', out)

for marker in ('/*WF_CSS*/', '<!--WF_FIGURE-->', '/*WF_JS*/', '<!--FIGS-->', '<!--FLOW:'):
    assert marker not in out, marker
open('deck.html', 'w', encoding='utf-8').write(out)
print('deck.html written:', len(out), 'chars')
