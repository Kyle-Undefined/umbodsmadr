(function () {
	'use strict';

	var bootstrapNode = document.getElementById('umbod-bootstrap');
	var bootstrap = {};
	try {
		if (bootstrapNode && bootstrapNode.textContent) {
			bootstrap = JSON.parse(bootstrapNode.textContent);
		}
	} catch (e) {
		console.error('Failed to parse bootstrap data:', e);
	}

	document.addEventListener('alpine:init', function () {
		Alpine.store('dash', {
			entries: Array.isArray(bootstrap.entries) ? bootstrap.entries : [],
			approvals: Array.isArray(bootstrap.approvals) ? bootstrap.approvals : [],
			manifest: bootstrap.manifest || {},
			page: 1,
			pageSize: 25,
			searchQuery: '',
			filterOutcome: '',
			filterTool: '',
			filterAgent: '',
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
					var key = self.outcomeKey(entry);
					if (self.filterOutcome && key !== self.filterOutcome) return false;
					if (self.filterTool && entry.tool !== self.filterTool) return false;
					if (self.filterAgent && entry.agent !== self.filterAgent) return false;
					if (q) {
						var text = [
							entry.agent,
							entry.tool,
							entry.command,
							entry.classification,
							entry.reason,
							entry.matchedRule || '',
						]
							.join(' ')
							.toLowerCase();
						if (text.indexOf(q) === -1) return false;
					}
					return true;
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
				return Object.keys(rules).map(function (k) {
					return { pattern: k, decision: rules[k] };
				});
			},

			setPageSize: function (n) {
				this.pageSize = n;
				this.page = 1;
			},

			resetPage: function () {
				this.page = 1;
			},

			refresh: async function () {
				try {
					var results = await Promise.all([
						fetch('/api/activity', { headers: { accept: 'application/json' } }).then(function (r) {
							if (!r.ok) throw new Error('activity fetch failed: ' + r.status);
							return r.json();
						}),
						fetch('/api/approvals', { headers: { accept: 'application/json' } }).then(function (r) {
							if (!r.ok) throw new Error('approvals fetch failed: ' + r.status);
							return r.json();
						}),
					]);
					this.entries = Array.isArray(results[0]) ? results[0] : [];
					this.approvals = Array.isArray(results[1]) ? results[1] : [];
					if (this.page > this.totalPages) this.page = this.totalPages;
				} catch (e) {
					console.error('refresh failed:', e);
				}
			},

			resolveApproval: async function (id, action) {
				try {
					var resp = await fetch('/api/approvals/' + id + '/' + action, { method: 'POST' });
					if (resp.ok) await this.refresh();
				} catch (e) {
					console.error('approval action failed:', e);
				}
			},
		});
	});

	document.addEventListener('alpine:init', function () {
		if (!('WebSocket' in window)) return;

		var protocol = location.protocol === 'https:' ? 'wss' : 'ws';
		var socket = new WebSocket(protocol + '://' + location.host + '/ws');
		var refreshTimer = null;

		socket.addEventListener('open', function () {
			Alpine.store('dash').wsConnected = true;
		});

		socket.addEventListener('message', function () {
			clearTimeout(refreshTimer);
			refreshTimer = setTimeout(function () {
				Alpine.store('dash').refresh();
			}, 150);
		});

		socket.addEventListener('close', function () {
			Alpine.store('dash').wsConnected = false;
		});
	});
})();
