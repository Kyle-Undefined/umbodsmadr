(function () {
	'use strict';

	var bootstrapNode = document.getElementById('umbod-bootstrap');
	var bootstrap = {};
	var DEFAULT_ACTIVITY_LIMIT = 200;
	try {
		if (bootstrapNode && bootstrapNode.textContent) {
			bootstrap = JSON.parse(bootstrapNode.textContent);
		}
	} catch (e) {
		console.error('Failed to parse bootstrap data:', e);
	}

	function activityLimit() {
		var value = new URLSearchParams(location.search).get('limit');
		if (value === null) return DEFAULT_ACTIVITY_LIMIT;
		if (!/^\d+$/.test(value)) return DEFAULT_ACTIVITY_LIMIT;
		var parsed = Number(value);
		return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_ACTIVITY_LIMIT;
	}

	function entryMatches(entry, store, query) {
		var filters = [
			[store.filterOutcome, store.outcomeKey(entry)],
			[store.filterTool, entry.tool],
			[store.filterAgent, entry.agent],
		];
		var searchable = [
			entry.agent,
			entry.tool,
			entry.command,
			entry.classification,
			entry.reason,
			entry.matchedRule || '',
			entry.workspaceId || '',
			entry.resolvedWorkspaceId || '',
			entry.policyScope || '',
		]
			.join(' ')
			.toLowerCase();
		return (
			filters.every(function (pair) {
				return !pair[0] || pair[0] === pair[1];
			}) &&
			(!query || searchable.includes(query))
		);
	}

	function activityOrder(entry) {
		if (Number.isSafeInteger(entry.id)) return entry.id;
		var timestamp = Date.parse(entry.timestamp);
		return Number.isFinite(timestamp) ? timestamp : null;
	}

	function mergeActivityEntries(preferred, fallback, limit) {
		var seenIds = new Set();
		var merged = [];
		preferred.concat(fallback).forEach(function (entry) {
			if (!entry || typeof entry !== 'object') return;
			if (entry.id !== undefined && entry.id !== null) {
				var key = String(entry.id);
				if (seenIds.has(key)) return;
				seenIds.add(key);
			}
			merged.push({ entry: entry, order: merged.length });
		});
		merged.sort(function (left, right) {
			var leftOrder = activityOrder(left.entry);
			var rightOrder = activityOrder(right.entry);
			if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
				return rightOrder - leftOrder;
			}
			return left.order - right.order;
		});
		return merged.slice(0, limit).map(function (candidate) {
			return candidate.entry;
		});
	}

	function workspaceQuery(workspace) {
		if (!workspace) return '';
		var params = new URLSearchParams();
		params.set('workspace', workspace);
		return '?' + params.toString();
	}

	function requestIsCurrent(store, generationKey, generation, workspace) {
		return generation === store[generationKey] && workspace === store.insightWorkspace;
	}

	async function fetchCoverageReport(workspace) {
		var response = await fetch('/api/analytics/coverage' + workspaceQuery(workspace));
		var result = await response.json();
		if (!response.ok) {
			throw new Error(result && result.error ? result.error : 'coverage fetch failed: ' + response.status);
		}
		return result;
	}

	document.addEventListener('alpine:init', function () {
		Alpine.store('dash', {
			entries: Array.isArray(bootstrap.entries) ? bootstrap.entries : [],
			approvals: Array.isArray(bootstrap.approvals) ? bootstrap.approvals : [],
			manifest: bootstrap.manifest || {},
			insights: bootstrap.insights || {
				tools: { totals: { entries: 0 }, byTool: [] },
				rules: { rules: [], tomlSnippet: '' },
			},
			coverage: null,
			coverageError: '',
			coverageLoading: false,
			insightWorkspace: '',
			insightsRequestGeneration: 0,
			coverageRequestGeneration: 0,
			insightsOpen: false,
			insightsExpanded: false,
			explorerLoading: false,
			explorerLoaded: false,
			explorerEntries: [],
			explorerPage: 1,
			explorerPageSize: 50,
			explorerTotal: 0,
			explorerTotalPages: 1,
			explorerFilters: {
				tool: '',
				agent: '',
				classification: '',
				decision: '',
				project: '',
				workspace: '',
				search: '',
			},
			explorerOpenId: null,
			page: 1,
			pageSize: 25,
			searchQuery: '',
			filterOutcome: '',
			filterTool: '',
			filterAgent: '',
			activityLimit: activityLimit(),
			activityRevision: 0,
			activityRefreshGeneration: 0,
			approvalRefreshGeneration: 0,
			wsConnected: false,
			rulesOpen: false,

			get pendingCount() {
				return this.approvals.length;
			},

			get uniqueTools() {
				return Array.from(
					new Set(
						this.entries.map(function (e) {
							return e.tool;
						})
					)
				).sort();
			},

			get uniqueAgents() {
				return Array.from(
					new Set(
						this.entries.map(function (e) {
							return e.agent;
						})
					)
				).sort();
			},

			outcomeKey: function (entry) {
				if (entry.decision === 'approve') {
					if (entry.approvalStatus === 'approved') return 'approved';
					if (entry.approvalStatus === 'denied') return 'denied';
					return 'pending';
				}
				return entry.decision === 'allow' ? 'allowed' : 'blocked';
			},

			outcomeLabel: function (entry) {
				var map = {
					approved: 'Vouched',
					denied: 'Forbidden',
					pending: 'In Moot',
					allowed: 'Sanctioned',
					blocked: 'Outlawed',
				};
				return map[this.outcomeKey(entry)] || '';
			},

			formatReason: function (entry) {
				return entry.matchedRule ? 'Accordant with Law: ' + entry.matchedRule : entry.reason;
			},

			formatTimestamp: function (value) {
				var d = new Date(value);
				if (isNaN(d.getTime())) return value;
				return new Intl.DateTimeFormat(undefined, {
					month: 'short',
					day: 'numeric',
					hour: 'numeric',
					minute: '2-digit',
					second: '2-digit',
				}).format(d);
			},

			formatRelative: function (value) {
				var d = new Date(value);
				if (isNaN(d.getTime())) return '';
				return new Intl.DateTimeFormat(undefined, {
					month: 'short',
					day: 'numeric',
					hour: 'numeric',
					minute: '2-digit',
				}).format(d);
			},

			get filteredEntries() {
				var self = this;
				var q = self.searchQuery.toLowerCase();
				return self.entries.filter(function (entry) {
					return entryMatches(entry, self, q);
				});
			},

			get totalPages() {
				return Math.max(1, Math.ceil(this.filteredEntries.length / this.pageSize));
			},

			get pagedEntries() {
				var start = (this.page - 1) * this.pageSize;
				return this.filteredEntries.slice(start, start + this.pageSize);
			},

			get pageNumbers() {
				var total = this.totalPages;
				var cur = Math.min(this.page, total);
				var start = Math.max(1, cur - 2);
				var end = Math.min(total, start + 4);
				if (end - start < 4) start = Math.max(1, end - 4);
				var nums = [];
				for (var i = start; i <= end; i++) nums.push(i);
				return nums;
			},

			get countLabel() {
				var total = this.filteredEntries.length;
				var all = this.entries.length;
				return all + ' inscriptions' + (total !== all ? ' (' + total + ' shown)' : '');
			},

			get paginationInfo() {
				var total = this.filteredEntries.length;
				if (total === 0) return '0 of 0';
				var start = (this.page - 1) * this.pageSize + 1;
				var end = Math.min(this.page * this.pageSize, total);
				return start + '\u2013' + end + ' of ' + total;
			},

			get ruleEntries() {
				var rules = this.manifest && this.manifest.rules ? this.manifest.rules : {};
				var entries = Object.keys(rules).map(function (k) {
					return { scope: 'global', pattern: k, decision: rules[k] };
				});
				var workspaces = this.manifest && Array.isArray(this.manifest.workspaces) ? this.manifest.workspaces : [];
				workspaces.forEach(function (workspace) {
					Object.keys(workspace.rules || {}).forEach(function (pattern) {
						entries.push({
							scope: workspace.id,
							pattern: pattern,
							decision: workspace.rules[pattern],
						});
					});
				});
				return entries;
			},

			setPageSize: function (n) {
				this.pageSize = n;
				this.page = 1;
			},

			resetPage: function () {
				this.page = 1;
			},

			refreshApprovals: async function () {
				var generation = ++this.approvalRefreshGeneration;
				try {
					var response = await fetch('/api/approvals', { headers: { accept: 'application/json' } });
					if (!response.ok) throw new Error('approvals fetch failed: ' + response.status);
					var approvals = await response.json();
					if (generation !== this.approvalRefreshGeneration) return;
					this.approvals = Array.isArray(approvals) ? approvals : [];
				} catch (e) {
					console.error('approval refresh failed:', e);
				}
			},

			refreshActivity: async function () {
				var generation = ++this.activityRefreshGeneration;
				var startingRevision = this.activityRevision;
				try {
					var response = await fetch('/api/activity?limit=' + this.activityLimit, {
						headers: { accept: 'application/json' },
					});
					if (!response.ok) throw new Error('activity fetch failed: ' + response.status);
					var fetched = await response.json();
					if (generation !== this.activityRefreshGeneration) return;
					var snapshot = Array.isArray(fetched) ? fetched : [];
					var streamArrived = this.activityRevision !== startingRevision;
					this.entries = mergeActivityEntries(
						streamArrived ? this.entries : snapshot,
						streamArrived ? snapshot : this.entries,
						this.activityLimit
					);
					if (this.page > this.totalPages) this.page = this.totalPages;
				} catch (e) {
					console.error('activity refresh failed:', e);
				}
			},

			receiveActivity: function (entry) {
				if (!entry || typeof entry !== 'object') return;
				this.activityRevision += 1;
				this.entries = mergeActivityEntries([entry], this.entries, this.activityLimit);
				if (this.page > this.totalPages) this.page = this.totalPages;
			},

			loadInsights: async function () {
				var generation = ++this.insightsRequestGeneration;
				var workspace = this.insightWorkspace;
				try {
					var query = workspaceQuery(workspace);
					var results = await Promise.all([
						fetch('/api/analytics/tools' + query).then(function (r) {
							if (!r.ok) throw new Error('tool analytics fetch failed: ' + r.status);
							return r.json();
						}),
						fetch('/api/analytics/rules' + query).then(function (r) {
							if (!r.ok) throw new Error('rule analytics fetch failed: ' + r.status);
							return r.json();
						}),
					]);
					if (!requestIsCurrent(this, 'insightsRequestGeneration', generation, workspace)) return;
					this.insights = { tools: results[0], rules: results[1] };
					this.coverage = null;
					this.coverageError = '';
				} catch (e) {
					if (!requestIsCurrent(this, 'insightsRequestGeneration', generation, workspace)) return;
					console.error('insights refresh failed:', e);
				}
			},

			loadCoverage: async function () {
				var generation = ++this.coverageRequestGeneration;
				var workspace = this.insightWorkspace;
				this.coverageLoading = true;
				this.coverageError = '';
				try {
					var result = await fetchCoverageReport(workspace);
					if (!requestIsCurrent(this, 'coverageRequestGeneration', generation, workspace)) return;
					this.coverage = result;
				} catch (e) {
					if (!requestIsCurrent(this, 'coverageRequestGeneration', generation, workspace)) return;
					this.coverage = null;
					this.coverageError = e instanceof Error ? e.message : String(e);
					console.error('coverage fetch failed:', e);
				} finally {
					if (generation === this.coverageRequestGeneration) this.coverageLoading = false;
				}
			},

			loadExplorer: async function () {
				this.explorerLoading = true;
				try {
					var params = new URLSearchParams({
						page: String(this.explorerPage),
						pageSize: String(this.explorerPageSize),
					});
					Object.entries(this.explorerFilters).forEach(function (entry) {
						if (entry[1]) params.set(entry[0], entry[1]);
					});
					var response = await fetch('/api/analytics/calls?' + params.toString());
					if (!response.ok) throw new Error('call explorer fetch failed: ' + response.status);
					var result = await response.json();
					this.explorerEntries = Array.isArray(result.entries) ? result.entries : [];
					this.explorerPage = result.page || 1;
					this.explorerTotal = result.total || 0;
					this.explorerTotalPages = result.totalPages || 1;
					this.explorerLoaded = true;
					this.explorerOpenId = null;
				} catch (e) {
					console.error('call explorer fetch failed:', e);
				} finally {
					this.explorerLoading = false;
				}
			},

			toggleInsights: function () {
				this.insightsOpen = !this.insightsOpen;
				if (this.insightsOpen && !this.explorerLoaded) this.loadExplorer();
			},

			applyExplorerFilters: function () {
				this.explorerPage = 1;
				this.loadExplorer();
			},

			changeExplorerPage: function (page) {
				if (page < 1 || page > this.explorerTotalPages || page === this.explorerPage) return;
				this.explorerPage = page;
				this.loadExplorer();
			},

			resetExplorer: function () {
				this.explorerFilters = {
					tool: '',
					agent: '',
					classification: '',
					decision: '',
					project: '',
					workspace: '',
					search: '',
				};
				this.explorerPage = 1;
				this.loadExplorer();
			},

			copySuggestions: async function () {
				var value = this.insights.rules.tomlSnippet || '';
				if (!value) return;
				try {
					await navigator.clipboard.writeText(value);
				} catch (e) {
					console.error('copy failed:', e);
				}
			},

			resolveApproval: async function (id, action) {
				try {
					var approval = this.approvals.find(function (candidate) {
						return candidate.id === id;
					});
					var resp = await fetch('/api/approvals/' + id + '/' + action, { method: 'POST' });
					if (!resp.ok) return;
					var result = await resp.json();
					this.approvals = this.approvals.filter(function (candidate) {
						return candidate.id !== id;
					});
					this.activityRevision += 1;
					this.entries = this.entries.map(function (entry) {
						if (
							(approval && entry.id === approval.auditLogId) ||
							(entry.approvalRequestId !== undefined && entry.approvalRequestId === id)
						) {
							return Object.assign({}, entry, {
								approvalStatus: result.status,
								approvalResolvedAt: result.resolvedAt,
							});
						}
						return entry;
					});
					await this.refreshApprovals();
				} catch (e) {
					console.error('approval action failed:', e);
				}
			},
		});
	});

	document.addEventListener('alpine:init', function () {
		if (!('WebSocket' in window)) return;

		var protocol = location.protocol === 'https:' ? 'wss' : 'ws';
		var activeSocket = null;
		var reconnectTimer = null;
		var refreshTimer = null;

		function connectSocket() {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
			var socket = new WebSocket(protocol + '://' + location.host + '/ws');
			activeSocket = socket;

			socket.addEventListener('open', function () {
				if (activeSocket !== socket) return;
				var store = Alpine.store('dash');
				store.wsConnected = true;
				store.refreshActivity();
				store.refreshApprovals();
			});

			socket.addEventListener('message', function (event) {
				if (activeSocket !== socket) return;
				try {
					Alpine.store('dash').receiveActivity(JSON.parse(event.data));
				} catch (e) {
					console.error('invalid activity message:', e);
					return;
				}
				clearTimeout(refreshTimer);
				refreshTimer = setTimeout(function () {
					Alpine.store('dash').refreshApprovals();
				}, 150);
			});

			socket.addEventListener('close', function () {
				if (activeSocket !== socket) return;
				Alpine.store('dash').wsConnected = false;
				reconnectTimer = setTimeout(connectSocket, 1000);
			});
		}

		connectSocket();
	});
})();
