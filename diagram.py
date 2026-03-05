#!/usr/bin/env python3
"""Generate architecture diagram for Claude Runner"""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

fig, ax = plt.subplots(1, 1, figsize=(15, 9))
fig.patch.set_facecolor('#0d1117')
ax.set_facecolor('#0d1117')
ax.set_xlim(0, 15)
ax.set_ylim(0, 9)
ax.axis('off')

# Colors
BG_CARD = '#161b22'
BORDER = '#30363d'
BLUE = '#58a6ff'
GREEN = '#3fb950'
PURPLE = '#bc8cff'
ORANGE = '#d29922'
WHITE = '#e6edf3'
GRAY = '#8b949e'

def card(x, y, w, h, title, items, color=BLUE, title_size=13):
    rect = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.1",
                          facecolor=BG_CARD, edgecolor=color, linewidth=2)
    ax.add_patch(rect)
    ax.text(x + w/2, y + h - 0.25, title, ha='center', va='top',
            fontsize=title_size, fontweight='bold', color=color, fontfamily='monospace')
    for i, item in enumerate(items):
        ax.text(x + 0.2, y + h - 0.7 - i*0.32, item, ha='left', va='top',
                fontsize=9, color=GRAY, fontfamily='monospace')

def arrow(x1, y1, x2, y2, label='', color=GRAY):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=2.5))
    if label:
        mx, my = (x1+x2)/2, (y1+y2)/2
        ax.text(mx, my + 0.2, label, ha='center', va='bottom',
                fontsize=9, color=color, fontweight='bold', fontfamily='monospace')

# Title
ax.text(7.5, 8.7, 'Claude Runner', ha='center', va='top',
        fontsize=22, fontweight='bold', color=WHITE, fontfamily='monospace')
ax.text(7.5, 8.25, 'Add AI agents to any product. Fork > customize 3 files > deploy.', ha='center', va='top',
        fontsize=11, color=GRAY, fontfamily='monospace')

# Left: What you write
card(0.3, 4.4, 3.6, 3.3, 'YOU WRITE', [
    'AGENTS.md',
    '  who is the agent, rules',
    '',
    'OUTPUT.md',
    '  JSON response schema',
    '',
    'tools/*.sh',
    '  CLI scripts for your API',
], color=GREEN)

# Center: Claude Runner
card(5.2, 4.4, 4.2, 3.3, 'CLAUDE RUNNER', [
    'POST /task  > Docker container',
    'WS /stream  > live events',
    '',
    'Isolation per user',
    'Session memory',
    'Structured JSON output',
    'Cost tracking per task',
    'Abort any time',
], color=BLUE)

# Right: Output
card(10.7, 4.4, 4.0, 3.3, 'YOU GET', [
    '{ action: "resolve",',
    '  response: "...",',
    '  user: { name, plan },',
    '  confidence: 0.95 }',
    '',
    'cost: $0.03',
    'tools: ["Bash"]',
    'duration: 12s',
], color=PURPLE)

# Arrows between cards
arrow(3.9, 6.0, 5.2, 6.0, 'prompt + tools', GREEN)
arrow(9.4, 6.0, 10.7, 6.0, 'JSON', PURPLE)

# Bottom: HAR workflow
card(0.3, 0.5, 14.4, 3.4, 'GOT A LEGACY PRODUCT? HERE IS HOW:', [
    '',
    '1. Open Chrome DevTools > Network > check "Preserve log"',
    '2. Use your product — click everything (create, edit, delete)',
    '3. Click "Export HAR" > save the file',
    '4. Give HAR to Claude: "make a CLI tool for this API"',
    '5. Drop generated scripts into tools/ > done',
    '',
    'Your legacy product now has an AI agent. No refactoring needed.',
], color=ORANGE, title_size=12)

# Arrow from bottom to cards
arrow(7.5, 3.9, 7.5, 4.4, '', ORANGE)

# Stats bar
stats = '  10 files  |  400 lines  |  0 dependencies  |  MIT license  |  ~$0.03/task  '
ax.text(7.5, 0.15, stats, ha='center', va='bottom',
        fontsize=10, color=GRAY, fontfamily='monospace',
        bbox=dict(boxstyle='round,pad=0.3', facecolor=BG_CARD, edgecolor=BORDER))

plt.tight_layout()
plt.savefig('/Users/hormold/projects/claude-runner/diagram.png', dpi=200,
            facecolor='#0d1117', bbox_inches='tight', pad_inches=0.3)
print("Saved diagram.png")
