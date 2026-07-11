import type { ApprovalRequest, AuditEntry, Manifest, RuleAnalysis, ToolUsageStats } from '@umbod/core';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function serializeJson(value: unknown): string {
	return JSON.stringify(value).replaceAll('&', '\\u0026').replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

export function renderDashboard(
	manifest: Manifest,
	entries: AuditEntry[],
	approvals: ApprovalRequest[],
	toolUsage: ToolUsageStats,
	ruleAnalysis: RuleAnalysis
): string {
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>umboðsmaðr | ${escapeHtml(manifest.env.name)}</title>
    <link rel="stylesheet" href="/assets/dashboard.css" />
    <style>[x-cloak]{display:none!important}</style>
    <script defer src="/assets/dashboard.js"></script>
    <script defer src="/assets/alpine.js"></script>
  </head>
  <body x-data>
    <div class="bg-mesh"></div>
    <div class="bg-grid"></div>

    <main class="app-shell">
      <section class="hero">
        <div class="hero-content">
          <div class="hero-title">
            <h1>umbo&#240;sma&#240;r</h1>
          </div>
          <p class="hero-subtitle">The arbiter of policy within the autonomous realm</p>
          <div class="hero-status">
            <span>${escapeHtml(manifest.env.name)} v${escapeHtml(manifest.env.version)}</span>
            <span class="hero-status-sep" aria-hidden="true"></span>
            <span>${escapeHtml(manifest.policy.approval_method)} &middot; ${escapeHtml(manifest.policy.default_unknown)}</span>
            <span class="hero-status-sep" aria-hidden="true"></span>
            <span class="live-indicator" :class="$store.dash.wsConnected ? '' : 'disconnected'">
              <span class="pulse-dot"></span>
              <span x-text="$store.dash.wsConnected ? 'Live' : 'Offline'">Live</span>
            </span>
            <span class="hero-status-sep" aria-hidden="true"></span>
            <button type="button" class="rules-toggle-btn" @click="$store.dash.rulesOpen = !$store.dash.rulesOpen" title="View active rules">&#9881; Edicts</button>
          </div>
          <div class="rules-drawer" x-show="$store.dash.rulesOpen" x-cloak>
            <div class="rules-drawer-header">
              <h3>&#9881; Active Edicts</h3>
              <button type="button" class="rules-close-btn" @click="$store.dash.rulesOpen = false" aria-label="Close">&times;</button>
            </div>
            <div class="rules-drawer-body">
              <pre class="rules-code"><template x-for="rule in $store.dash.ruleEntries" :key="rule.pattern"><span><span class="rule-pattern" x-text="'&quot;' + rule.pattern + '&quot;'"></span><span class="rule-eq"> = </span><span :class="'rule-decision rule-decision--' + rule.decision" x-text="'&quot;' + rule.decision + '&quot;'"></span>
</span></template><template x-if="$store.dash.ruleEntries.length === 0"><span># No rules configured</span></template></pre>
            </div>
          </div>
        </div>
      </section>

      <section class="panel panel-approvals">
        <div class="panel-header">
          <h2><span class="section-icon" aria-hidden="true">&#11045;</span> Held for Witness</h2>
          <span class="approval-count-badge" :class="$store.dash.pendingCount > 0 ? 'has-pending' : ''" x-text="$store.dash.pendingCount"></span>
        </div>
        <div class="approval-stack">
          <template x-if="$store.dash.approvals.length === 0">
            <div class="empty-state">No actions await your Sanction.</div>
          </template>
          <template x-for="approval in $store.dash.approvals" :key="approval.id">
            <article class="approval-card">
              <div class="approval-header">
                <div class="entry-meta">
                  <span class="meta-agent" x-text="approval.entry.agent"></span>
                  <span class="meta-sep" aria-hidden="true"></span>
                  <span class="meta-tool" x-text="approval.entry.tool"></span>
                  <span class="meta-sep" aria-hidden="true"></span>
                  <span class="meta-class" x-text="approval.entry.classification"></span>
                </div>
                <div class="timestamp" x-text="$store.dash.formatTimestamp(approval.createdAt)"></div>
              </div>
              <pre class="command-block" x-text="approval.entry.command"></pre>
              <p x-text="approval.entry.reason"></p>
              <div class="approval-actions">
                <button class="button button-primary" type="button" @click="$store.dash.resolveApproval(approval.id, 'approve')">Vouch</button>
                <button class="button button-secondary" type="button" @click="$store.dash.resolveApproval(approval.id, 'deny')">Forbid</button>
              </div>
            </article>
          </template>
        </div>
      </section>

      <section class="panel panel-insights">
        <div class="panel-header">
          <h2><span class="section-icon" aria-hidden="true">&#9678;</span> Insights</h2>
          <span class="panel-meta" x-text="$store.dash.insights.tools.totals.entries + ' calls'">0 calls</span>
        </div>
        <div class="insights-grid">
          <div>
            <h3 class="insight-heading">Tool Use</h3>
            <template x-if="$store.dash.insights.tools.byTool.length === 0"><div class="empty-state">No tool history yet.</div></template>
            <div class="tool-usage-list">
              <template x-for="row in $store.dash.insights.tools.byTool" :key="row.agent + ':' + row.tool">
                <div class="tool-usage-row">
                  <div class="tool-usage-label"><span x-text="row.tool"></span><small x-text="row.agent + ' · ' + row.count"></small></div>
                  <div class="decision-bar" aria-label="Decision distribution">
                    <span class="decision-bar-allow" :style="'width:' + (row.decisions.allow / row.count * 100) + '%'" title="Allowed"></span>
                    <span class="decision-bar-approve" :style="'width:' + (row.decisions.approve / row.count * 100) + '%'" title="Approval required"></span>
                    <span class="decision-bar-block" :style="'width:' + (row.decisions.block / row.count * 100) + '%'" title="Blocked"></span>
                  </div>
                </div>
              </template>
            </div>
          </div>
          <div>
            <h3 class="insight-heading">Rule Health</h3>
            <template x-if="$store.dash.insights.rules.rules.length === 0"><div class="empty-state">No edicts to inspect.</div></template>
            <div class="rule-health-list">
              <template x-for="rule in $store.dash.insights.rules.rules" :key="rule.pattern">
                <div class="rule-health-row"><code x-text="rule.pattern"></code><span class="health-chip" :class="'health-chip--' + rule.status" x-text="rule.status"></span></div>
              </template>
            </div>
          </div>
        </div>
        <template x-if="$store.dash.insights.rules.tomlSnippet">
          <div class="suggestions-block">
            <div class="suggestions-header"><h3 class="insight-heading">Suggested Edicts</h3><button type="button" class="copy-button" @click="$store.dash.copySuggestions()">Copy</button></div>
            <pre class="suggestions-code" x-text="$store.dash.insights.rules.tomlSnippet"></pre>
          </div>
        </template>
        <div class="coverage-block">
          <button type="button" class="button button-secondary" :disabled="$store.dash.coverageLoading" @click="$store.dash.loadCoverage()" x-text="$store.dash.coverageLoading ? 'Scanning transcripts…' : 'Check transcript coverage'"></button>
          <template x-if="$store.dash.coverage"><span class="coverage-summary" x-text="Math.round($store.dash.coverage.coverageRatio * 100) + '% covered · ' + $store.dash.coverage.totals.gaps + ' gaps'"></span></template>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2><span class="section-icon" aria-hidden="true">&#9672;</span> The Annals</h2>
          </div>
          <div class="panel-meta">
            <span x-text="$store.dash.countLabel"></span>
          </div>
        </div>
        <div class="annals-toolbar">
          <div class="annals-search">
            <input type="text" class="search-input" placeholder="Search the annals\u2026" autocomplete="off" spellcheck="false"
              x-model="$store.dash.searchQuery"
              @input.debounce.200ms="$store.dash.resetPage()" />
          </div>
          <div class="annals-filters">
            <select class="filter-select" x-model="$store.dash.filterOutcome" @change="$store.dash.resetPage()">
              <option value="">All Outcomes</option>
              <option value="allowed">Sanctioned</option>
              <option value="blocked">Outlawed</option>
              <option value="approved">Vouched</option>
              <option value="denied">Forbidden</option>
              <option value="pending">In Moot</option>
            </select>
            <select class="filter-select" x-model="$store.dash.filterTool" @change="$store.dash.resetPage()">
              <option value="">All Tools</option>
              <template x-for="tool in $store.dash.uniqueTools" :key="tool">
                <option :value="tool" x-text="tool"></option>
              </template>
            </select>
            <select class="filter-select" x-model="$store.dash.filterAgent" @change="$store.dash.resetPage()">
              <option value="">All Agents</option>
              <template x-for="agent in $store.dash.uniqueAgents" :key="agent">
                <option :value="agent" x-text="agent"></option>
              </template>
            </select>
          </div>
        </div>

        <div class="activity-feed">
          <template x-if="$store.dash.pagedEntries.length === 0">
            <div class="empty-state" x-text="($store.dash.searchQuery || $store.dash.filterOutcome || $store.dash.filterTool || $store.dash.filterAgent) ? 'No inscriptions match your query.' : 'The ink remains dry.'"></div>
          </template>
          <template x-for="entry in $store.dash.pagedEntries" :key="entry.id">
            <article class="activity-card" :data-outcome="$store.dash.outcomeKey(entry)">
              <div class="entry-header">
                <div class="entry-meta">
                  <span class="meta-agent" x-text="entry.agent"></span>
                  <span class="meta-sep" aria-hidden="true"></span>
                  <span class="meta-tool" x-text="entry.tool"></span>
                  <span class="meta-sep" aria-hidden="true"></span>
                  <span class="meta-class" x-text="entry.classification"></span>
                  <span class="meta-outcome" :class="'meta-outcome--' + $store.dash.outcomeKey(entry)">
                    <span class="meta-dot"></span>
                    <span x-text="$store.dash.outcomeLabel(entry)"></span>
                  </span>
                  <template x-if="entry.decision === 'approve'">
                    <span class="meta-policy">requires warrant</span>
                  </template>
                </div>
                <div class="timestamp" x-text="$store.dash.formatTimestamp(entry.timestamp)"></div>
              </div>
              <pre class="command-block" x-text="entry.command"></pre>
              <div class="entry-footer">
                <div class="entry-reason" x-text="$store.dash.formatReason(entry)"></div>
                <div class="entry-resolution" x-text="entry.decision === 'approve' && entry.approvalStatus ? (entry.approvalStatus === 'pending' ? 'Awaiting the Moot' : 'Resolved ' + $store.dash.formatRelative(entry.approvalResolvedAt || entry.timestamp)) : ''"></div>
              </div>
            </article>
          </template>
        </div>

        <div class="pagination-bar">
          <div class="pagination-controls">
            <div class="page-size-wrap">
              <span class="page-size-label">Show</span>
              <select class="filter-select page-size-select" @change="$store.dash.setPageSize(+$event.target.value)">
                <template x-for="n in [10, 25, 50, 100]" :key="n">
                  <option :value="n" :selected="n === $store.dash.pageSize" x-text="n"></option>
                </template>
              </select>
            </div>
            <span class="pagination-info" x-text="$store.dash.paginationInfo"></span>
            <div class="pagination-buttons">
              <button type="button" class="pagination-btn" :disabled="$store.dash.page <= 1" @click="$store.dash.page--">&#9664;</button>
              <template x-for="n in $store.dash.pageNumbers" :key="n">
                <button type="button" class="pagination-btn" :class="n === $store.dash.page ? 'pagination-btn--active' : ''" @click="$store.dash.page = n" x-text="n"></button>
              </template>
              <button type="button" class="pagination-btn" :disabled="$store.dash.page >= $store.dash.totalPages" @click="$store.dash.page++">&#9654;</button>
            </div>
          </div>
        </div>
      </section>
    </main>

    <script id="umbod-bootstrap" type="application/json">${serializeJson({ manifest, entries, approvals, insights: { tools: toolUsage, rules: ruleAnalysis } })}</script>
  </body>
</html>`;
}
