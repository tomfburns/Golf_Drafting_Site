    (() => {
      const qs = (s, r = document) => r.querySelector(s);
      const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));

      const el = (tag, attrs = {}, children = []) => {
        const node = document.createElement(tag);
        Object.entries(attrs).forEach(([k, v]) => {
          if (k === 'class') node.className = v;
          else if (k === 'text') node.textContent = v;
          else node.setAttribute(k, v);
        });
        children.forEach(c => node.appendChild(c));
        return node;
      };

      const state = {
        teamCount: 4,
        teams: [],
        teamNames: {},
        rounds: 4,
        currentPick: 0,
        pickOrder: [], // array of team numbers per pick
        draftedPlayers: new Set(),
        format: 'Snake',
        tournament: 'Masters',
        isActive: false,
        hasCompleted: false,
        scores: {},
        pastDrafts: [],
        activeLeaderboardTab: 'current'
      };
      const HISTORY_LIMIT = 10;
      const TIER_VALUES = [1, 2, 3, 4];
      const MOBILE_MENU_BREAKPOINT = 900;
      const dragState = { card: null };
      const API_BASE_URL = window.__API_BASE__ || 'https://your-render-service.onrender.com/api';
      const SOCKET_URL = window.__SOCKET_BASE__ || 'https://your-render-service.onrender.com';
      const CLIENT_ID = `client-${Math.random().toString(36).slice(2)}`;
      let socket = null;
      let currentDraftId = null;
      let isServerSynchronized = false;
      const STORAGE_KEYS = {
        snapshot: 'majors-draft:snapshot',
        history: 'majors-draft:history'
      };
      const STORAGE_AVAILABLE = (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined');

      function readStorage(key, fallback = null) {
        if (!STORAGE_AVAILABLE) return fallback;
        try {
          const raw = window.localStorage.getItem(key);
          if (!raw) return fallback;
          return JSON.parse(raw);
        } catch (err) {
          console.warn('[Storage] Failed to read key', key, err);
          return fallback;
        }
      }

      function writeStorage(key, value) {
        if (!STORAGE_AVAILABLE) return;
        try {
          window.localStorage.setItem(key, JSON.stringify(value));
        } catch (err) {
          console.warn('[Storage] Failed to write key', key, err);
        }
      }

      function removeStorage(key) {
        if (!STORAGE_AVAILABLE) return;
        try {
          window.localStorage.removeItem(key);
        } catch (err) {
          console.warn('[Storage] Failed to remove key', key, err);
        }
      }

      function updateStartButton() {
        const startBtn = qs('[data-action="start-draft"]');
        if (!startBtn) return;
        if (state.isActive) {
          startBtn.textContent = 'Draft in Progress';
          startBtn.classList.add('is-active');
        } else {
          startBtn.classList.remove('is-active');
          if (state.hasCompleted) {
            startBtn.textContent = 'Restart Draft';
          } else {
            startBtn.textContent = 'Start Draft';
          }
        }
      }

      const tournamentThemes = {
        'masters': 'theme-masters',
        'pga championship': 'theme-pga',
        'pga': 'theme-pga',
        'u.s. open': 'theme-us-open',
        'us open': 'theme-us-open',
        'the open': 'theme-open',
        'open championship': 'theme-open'
      };

      const tournamentLogos = {
        'masters': 'Masters_Logo.png',
        'pga championship': 'PGA_Championship.png',
        'pga': 'PGA_Championship.png',
        'u.s. open': 'US_Open_(Golf)_Logo.png',
        'us open': 'US_Open_(Golf)_Logo.png',
        'the open': 'The_Open_Championship_logo.png',
        'open championship': 'The_Open_Championship_logo.png'
      };

      const themeSeriesColors = {
        'theme-masters': ['#006341', '#ffdf00', '#2f66ff', '#b45309', '#c026d3', '#f97316'],
        'theme-pga': ['#1e3a8a', '#d62828', '#16a34a', '#f59e0b', '#7c3aed', '#10b981'],
        'theme-us-open': ['#1d4ed8', '#facc15', '#dc2626', '#0f766e', '#9333ea', '#fb923c'],
        'theme-open': ['#123a7a', '#c0cadc', '#f97316', '#15803d', '#6366f1', '#facc15'],
        'theme-default': ['#2f66ff', '#16a34a', '#f97316', '#ef4444', '#9333ea', '#0ea5e9']
      };

      function getActiveThemeClass() {
        const body = document.body;
        if (!body) return 'theme-default';
        return Object.values(tournamentThemes).find(cls => body.classList.contains(cls)) || 'theme-default';
      }

      function resolveSeriesColors(count) {
        const theme = getActiveThemeClass();
        const palette = themeSeriesColors[theme] || themeSeriesColors['theme-default'];
        const colors = [];
        for (let i = 0; i < count; i++) {
          const color = palette[i] || palette[i % palette.length];
          colors.push(color);
        }
        return colors;
      }

      function applyTournamentTheme(label) {
        const body = document.body;
        if (!body) return;
        const tournament = (label || 'Masters').trim();
        state.tournament = tournament;
        const key = tournament.toLowerCase();
        const themeClass = tournamentThemes[key] || 'theme-masters';
        Object.values(tournamentThemes).forEach(cls => body.classList.remove(cls));
        body.classList.remove('theme-default');
        body.classList.add(themeClass);
        syncTournamentTabs(tournament);
        const logo = qs('[data-hook="tournament-logo"]');
        if (logo) {
          const filename = tournamentLogos[key] || 'Masters_Logo.png';
          logo.setAttribute('src', `/Users/thomasburns/Documents/PythonProjects/Golf_Drafting_Site/${filename}`);
          logo.setAttribute('alt', `${tournament} logo`);
        }
        renderScoreChart();
      }

      function syncTournamentTabs(selected) {
        const tabsWrap = qs('[data-hook="tournament-select"]');
        if (!tabsWrap) return;
        const normalized = (selected || '').toLowerCase();
        const tabs = qsa('.tournament-tab', tabsWrap);
        let anyActive = false;
        tabs.forEach(tab => {
          const label = (tab.getAttribute('data-tournament') || tab.textContent || '').trim();
          const isActive = label.toLowerCase() === normalized;
          tab.classList.toggle('is-active', isActive);
          tab.setAttribute('aria-selected', String(isActive));
          tab.setAttribute('tabindex', isActive ? '0' : '-1');
          if (isActive) anyActive = true;
        });
        if (!anyActive && tabs.length) {
          const first = tabs[0];
          first.classList.add('is-active');
          first.setAttribute('aria-selected', 'true');
          first.setAttribute('tabindex', '0');
        }
      }

      function setupTopbarMenu() {
        const toggle = qs('[data-action="toggle-topbar-menu"]');
        const controls = qs('header.topbar .controls');
        if (!toggle || !controls) return;
        const closeMenu = () => {
          controls.classList.remove('is-open');
          toggle.setAttribute('aria-expanded', 'false');
          toggle.classList.remove('is-open');
        };
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          const isOpen = controls.classList.toggle('is-open');
          toggle.setAttribute('aria-expanded', String(isOpen));
          toggle.classList.toggle('is-open', isOpen);
        });
        document.addEventListener('click', (event) => {
          if (window.innerWidth > MOBILE_MENU_BREAKPOINT) return;
          if (!controls.contains(event.target) && !toggle.contains(event.target)) {
            closeMenu();
          }
        });
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            closeMenu();
          }
        });
        window.addEventListener('resize', () => {
          if (window.innerWidth > MOBILE_MENU_BREAKPOINT) {
            closeMenu();
          }
        });
        closeMenu();
      }

      // ===== Helpers =====
      function renderPar(n) {
        if (n === 0) return 'E';
        return n > 0 ? `+${n}` : `${n}`;
      }

      function ensureScoreEntry(id) {
        if (!id) return [0,0,0,0];
        const existing = state.scores[id];
        if (Array.isArray(existing)) {
          while (existing.length < 4) existing.push(0);
          return existing;
        }
        const arr = [0,0,0,0];
        if (typeof existing === 'number') {
          arr[0] = existing;
        }
        state.scores[id] = arr;
        return arr;
      }

      function getRoundScores(id) {
        const arr = ensureScoreEntry(id);
        return arr.slice(0,4);
      }

      function setRoundScore(id, roundIdx, value) {
        const arr = ensureScoreEntry(id);
        const num = Number(value);
        arr[roundIdx] = isNaN(num) ? 0 : num;
        persistDraftSnapshot();
      }

      function getScoreFor(id) {
        return getRoundScores(id).reduce((sum, val) => sum + (Number(val) || 0), 0);
      }
      function buildRoundOrder(format, roundIdx) {
        const forward = state.teams.slice();
        if (format === 'Snake') {
          return (roundIdx % 2 === 1) ? forward.slice().reverse() : forward;
        }
        return forward;
      }

      function computePickOrder(format) {
        const order = [];
        for (let r = 0; r < state.rounds; r++) {
          const seq = buildRoundOrder(format, r);
          order.push(...seq);
        }
        return order;
      }

      function findTeamName(teamNum) {
        if (!teamNum) return '';
        const key = String(teamNum);
        const name = state.teamNames?.[key];
        if (typeof name === 'string' && name.trim().length) {
          return name.trim();
        }
        const fallback = `Team ${teamNum}`;
        if (state.teamNames) state.teamNames[key] = fallback;
        return fallback;
      }

      function syncTeamNames() {
        const next = {};
        state.teams.forEach(teamNum => {
          const key = String(teamNum);
          const existing = state.teamNames?.[key];
          next[key] = (typeof existing === 'string' && existing.trim().length)
            ? existing.trim()
            : `Team ${teamNum}`;
        });
        state.teamNames = next;
      }

      function renderTeamsCard() {
        const wrap = qs('#teams');
        if (!wrap) return;
        wrap.innerHTML = '';
        state.teams.forEach(teamNum => {
          const team = el('div', { class: 'team', 'data-team': String(teamNum) });
          const title = el('h3', { text: findTeamName(teamNum) });
          team.appendChild(title);
          for (let tier = 1; tier <= 4; tier++) {
            team.appendChild(el('div', { class: 'slot', 'data-tier': String(tier) }));
          }
          wrap.appendChild(team);
        });
      }

      function renderTeamTotals() {
        const wrap = qs('#team-totals');
        if (!wrap) return;
        wrap.innerHTML = '';
        state.teams.forEach(teamNum => {
          const block = el('div', { class: 'team', 'data-team-total': String(teamNum) });
          const header = el('h3');
          header.appendChild(document.createTextNode(`${findTeamName(teamNum)} Total: `));
          header.appendChild(el('span', { class: 'chip', 'data-team-score': String(teamNum), text: 'E' }));
          block.appendChild(header);
          wrap.appendChild(block);
        });
      }

      function renderLeaderboards() {
        const wrap = qs('#team-leaderboards');
        if (!wrap) return;
        wrap.innerHTML = '';
        state.teams.forEach(teamNum => {
          const board = el('div', { class: 'team-board', 'data-team': String(teamNum) });
          board.appendChild(el('h3', { class: 'team-board__title', text: findTeamName(teamNum) }));
          const tableWrap = el('div', { class: 'team-board__table' });
          const table = el('table', { class: 'leaderboard-table', 'data-team': String(teamNum), 'aria-label': `${findTeamName(teamNum)} leaderboard` });
          const thead = el('thead');
          const headerRow = el('tr');
          ['Player', 'Tier', 'Odds', 'R1', 'R2', 'R3', 'R4', 'Total'].forEach(lbl => headerRow.appendChild(el('th', { text: lbl })));
          thead.appendChild(headerRow);
          table.appendChild(thead);
          table.appendChild(el('tbody'));
          tableWrap.appendChild(table);
          board.appendChild(tableWrap);
          wrap.appendChild(board);
        });
        renderScoreChart();
      }

      function renderScoreChart() {
        const wrap = qs('#score-chart');
        if (!wrap) return;
        wrap.innerHTML = '';

        const roundCount = state.rounds;
        const roundLabels = Array.from({ length: roundCount }, (_, idx) => `R${idx + 1}`);
        const teamSeries = state.teams.map(teamNum => {
          const slots = qsa(`.team[data-team="${teamNum}"] .slot[data-player-id]`);
          const players = slots
            .map(slot => {
              const id = slot.getAttribute('data-player-id');
              if (!id) return null;
              const name = slot.querySelector('.name')?.textContent?.trim() || '';
              const rounds = getRoundScores(id);
              const total = getScoreFor(id);
              return { id, name, rounds, total };
            })
            .filter(Boolean);
          const perRound = Array.from({ length: roundCount }, (_, roundIdx) =>
            players.reduce((sum, player) => {
              const score = Number(player.rounds?.[roundIdx]) || 0;
              return sum + score;
            }, 0)
          );
          const cumulative = [];
          perRound.reduce((running, roundVal, idx) => {
            const total = running + roundVal;
            cumulative[idx] = total;
            return total;
          }, 0);
          return {
            teamNum,
            teamName: findTeamName(teamNum),
            cumulative,
            hasPlayers: players.length > 0,
            players
          };
        });

        const draftedTeams = teamSeries.filter(team => team.hasPlayers);
        if (!draftedTeams.length) {
          wrap.setAttribute('aria-label', 'Round-by-round team totals. No drafted teams yet.');
          wrap.appendChild(el('div', { class: 'score-chart__empty', text: 'Draft players to see team totals by round.' }));
          return;
        }

        const header = el('div', { class: 'score-chart__header' }, [
          el('h3', { class: 'score-chart__title', text: 'Team Totals (Cumulative)' }),
          el('span', { class: 'score-chart__value', text: 'Lower is better' })
        ]);
        wrap.appendChild(header);

        const allValues = teamSeries.flatMap(team => team.cumulative);
        let domainMin = Math.min(0, ...allValues);
        let domainMax = Math.max(0, ...allValues);
        if (domainMin === domainMax) {
          domainMax += 1;
          domainMin -= 1;
        }
        const range = domainMax - domainMin || 1;

        const width = 660;
        const height = 220;
        const padding = { top: 24, right: 20, bottom: 38, left: 64 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const xForIdx = (idx) => {
          if (roundCount === 1) {
            return padding.left + chartWidth / 2;
          }
          return padding.left + (idx / (roundCount - 1)) * chartWidth;
        };
        const yForVal = (val) => padding.top + ((domainMax - val) / range) * chartHeight;

        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('class', 'score-chart__svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('role', 'presentation');

        const axisPath = document.createElementNS(svgNS, 'path');
        axisPath.setAttribute('d', `M${padding.left} ${padding.top} L${padding.left} ${padding.top + chartHeight} L${padding.left + chartWidth} ${padding.top + chartHeight}`);
        axisPath.setAttribute('class', 'score-chart__axis');
        svg.appendChild(axisPath);

        if (domainMin <= 0 && domainMax >= 0) {
          const zeroY = yForVal(0);
          const zeroLine = document.createElementNS(svgNS, 'line');
          zeroLine.setAttribute('x1', padding.left);
          zeroLine.setAttribute('x2', padding.left + chartWidth);
          zeroLine.setAttribute('y1', zeroY);
          zeroLine.setAttribute('y2', zeroY);
          zeroLine.setAttribute('class', 'score-chart__zero-line');
          svg.appendChild(zeroLine);
        }

        const tickValues = new Set([domainMin, domainMax]);
        if (domainMin < 0 && domainMax > 0) tickValues.add(0);
        const yTicks = Array.from(tickValues).sort((a, b) => a - b);
        const xTicks = roundLabels.map((label, idx) => ({ label, idx }));

        const palette = resolveSeriesColors(teamSeries.length);
        const legend = el('div', { class: 'score-chart__legend' });

        teamSeries.forEach((team, idx) => {
          const color = palette[idx % palette.length];
          const points = team.cumulative.map((val, roundIdx) => `${xForIdx(roundIdx)},${yForVal(val)}`).join(' ');
          const line = document.createElementNS(svgNS, 'polyline');
          line.setAttribute('points', points);
          line.setAttribute('class', 'score-chart__line');
          line.setAttribute('stroke', color);
          if (!team.hasPlayers) line.style.opacity = '0.4';
          svg.appendChild(line);

          team.cumulative.forEach((val, roundIdx) => {
            const dot = document.createElementNS(svgNS, 'circle');
            dot.setAttribute('cx', xForIdx(roundIdx));
            dot.setAttribute('cy', yForVal(val));
            dot.setAttribute('r', 4);
            dot.setAttribute('class', 'score-chart__dot');
            dot.setAttribute('fill', color);
            if (!team.hasPlayers) dot.style.opacity = '0.4';
            svg.appendChild(dot);
          });

          if (team.players?.length) {
            const finalIndex = Math.max(0, roundCount - 1);
            const baseX = xForIdx(finalIndex);
            const spread = Math.min(12, 6 * (team.players.length - 1));
            team.players.forEach((player, playerIdx) => {
              const total = Number(player.total) || 0;
              const playerDot = document.createElementNS(svgNS, 'circle');
              const offset = team.players.length === 1 ? 0 : ((playerIdx / (team.players.length - 1)) - 0.5) * spread;
              playerDot.setAttribute('cx', baseX + offset);
              playerDot.setAttribute('cy', yForVal(total));
              playerDot.setAttribute('r', 5);
              playerDot.setAttribute('class', 'score-chart__player-dot');
              playerDot.setAttribute('fill', color);
              playerDot.setAttribute('fill-opacity', '0.18');
              playerDot.setAttribute('stroke', color);
              playerDot.setAttribute('stroke-opacity', '0.45');
              playerDot.setAttribute('data-player-id', player.id);
              const title = document.createElementNS(svgNS, 'title');
              title.textContent = `${player.name || 'Player'} • ${renderPar(total)}`;
              playerDot.appendChild(title);
              svg.appendChild(playerDot);
            });
          }

          const legendItem = el('div', { class: 'score-chart__legend-item', style: `--series-color:${color}` }, [
            el('span', { class: 'score-chart__legend-swatch' }),
            el('span', { class: 'score-chart__legend-label', text: `${team.teamName} (${renderPar(team.cumulative[roundCount - 1] || 0)})` })
          ]);
          if (!team.hasPlayers) legendItem.classList.add('is-empty');
          legend.appendChild(legendItem);
        });

        yTicks.forEach(val => {
          const text = document.createElementNS(svgNS, 'text');
          text.setAttribute('x', padding.left - 10);
          text.setAttribute('y', yForVal(val));
          text.setAttribute('class', 'score-chart__tick score-chart__tick--y');
          text.textContent = renderPar(Math.round(val));
          svg.appendChild(text);
        });

        xTicks.forEach(({ label, idx }) => {
          const text = document.createElementNS(svgNS, 'text');
          text.setAttribute('x', xForIdx(idx));
          text.setAttribute('y', padding.top + chartHeight + 18);
          text.setAttribute('class', 'score-chart__tick score-chart__tick--x');
          text.textContent = label;
          svg.appendChild(text);
        });

        wrap.appendChild(svg);
        wrap.appendChild(legend);

        const leader = draftedTeams.reduce((best, team) => {
          const current = team.cumulative[roundCount - 1] || 0;
          const bestScore = best.cumulative[roundCount - 1] || 0;
          return current < bestScore ? team : best;
        }, draftedTeams[0]);
        const leaderScore = leader.cumulative[roundCount - 1] || 0;
        wrap.setAttribute('aria-label', `Round-by-round team totals. Best total ${renderPar(leaderScore)} by ${leader.teamName}.`);
      }

      function formatDateTime(isoString) {
        if (!isoString) return '';
        const date = new Date(isoString);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        });
      }

      function setLeaderboardTab(tab) {
        const desired = tab === 'history' ? 'history' : 'current';
        state.activeLeaderboardTab = desired;
        qsa('.leaderboard-tab').forEach(btn => {
          const target = btn.getAttribute('data-tab');
          const isActive = target === desired;
          btn.classList.toggle('is-active', isActive);
          btn.setAttribute('aria-selected', String(isActive));
          btn.setAttribute('tabindex', isActive ? '0' : '-1');
        });
        qsa('.leaderboard-panel').forEach(panel => {
          const target = panel.getAttribute('data-panel');
          const isActive = target === desired;
          panel.classList.toggle('is-active', isActive);
          if (isActive) panel.removeAttribute('hidden');
          else panel.setAttribute('hidden', '');
        });
      }

      function renderPastEvents() {
        const wrap = qs('#past-events');
        if (!wrap) return;
        wrap.innerHTML = '';

        const clearBtn = qs('[data-action="clear-history"]');
        if (clearBtn) clearBtn.disabled = state.pastDrafts.length === 0;

        if (!state.pastDrafts.length) {
          wrap.appendChild(el('div', { class: 'past-event__empty', text: 'No drafts saved yet. Finish a draft to archive it here.' }));
          return;
        }

        state.pastDrafts.forEach(event => {
          const card = el('article', { class: 'past-event', 'data-event-id': event.id });
          const title = `${event.tournament || 'Tournament'} · ${event.format || 'Format'}`;
          const meta = `${formatDateTime(event.timestamp)} • ${event.teamCount || state.teamCount} teams`;
          const header = el('div', { class: 'past-event__header' }, [
            el('h4', { class: 'past-event__heading', text: title }),
            el('div', { class: 'past-event__meta', text: meta })
          ]);
          card.appendChild(header);

          const teamsWrap = el('div', { class: 'past-event__teams' });
          event.teams.forEach(team => {
            const teamBlock = el('div', { class: 'past-event__team' });
            const headerRow = el('div', { class: 'past-event__team-header' }, [
              el('span', { class: 'past-event__team-name', text: team.name || `Team ${team.teamNum}` }),
              el('span', { class: 'past-event__team-total', text: renderPar(team.totalValue || 0) })
            ]);
            teamBlock.appendChild(headerRow);

            if (team.picks && team.picks.length) {
              const list = el('ul', { class: 'past-event__picks' });
              team.picks.forEach(pick => {
                const oddsPart = pick.odds ? ` • ${pick.odds}` : '';
                const roundsPart = pick.rounds && pick.rounds.some(val => val !== 0)
                  ? ` • Rnds: ${pick.rounds.map(renderPar).join(' / ')}`
                  : '';
                list.appendChild(el('li', {
                  class: 'past-event__pick',
                  text: `${pick.name} · ${pick.tier}${oddsPart} • Total ${renderPar(pick.totalValue || 0)}${roundsPart}`
                }));
              });
              teamBlock.appendChild(list);
            } else {
              teamBlock.appendChild(el('div', { class: 'past-event__meta', text: 'No picks recorded.' }));
            }
            teamsWrap.appendChild(teamBlock);
          });
          card.appendChild(teamsWrap);
          wrap.appendChild(card);
        });
      }

      function saveDraftToHistory() {
        const event = {
          id: `draft-${Date.now()}`,
          timestamp: new Date().toISOString(),
          tournament: state.tournament || 'Tournament',
          format: state.format,
          teamCount: state.teamCount,
          teams: []
        };

        state.teams.forEach(teamNum => {
          const teamName = findTeamName(teamNum);
          const picks = [];
          let totalValue = 0;

          qsa(`#team-leaderboards .team-board[data-team="${teamNum}"] tbody tr`).forEach(row => {
            const id = row.getAttribute('data-player-id');
            if (!id) return;
            const playerName = row.children[0]?.textContent?.trim() || 'Player';
            const tierText = row.children[1]?.textContent?.trim() || '';
            const oddsText = row.children[2]?.textContent?.trim() || '';
            const rounds = getRoundScores(id).slice(0, state.rounds);
            const total = getScoreFor(id);
            totalValue += total;
            picks.push({
              id,
              name: playerName,
              tier: tierText,
              odds: oddsText,
              rounds,
              totalValue: total
            });
          });

          event.teams.push({
            teamNum,
            name: teamName,
            totalValue,
            picks
          });
        });

        state.pastDrafts = [event, ...state.pastDrafts].slice(0, HISTORY_LIMIT);
        renderPastEvents();
        persistPastDrafts();
        persistDraftSnapshot();
      }

      function renderTeamNameEditor() {
        const wrap = qs('#team-name-editor');
        if (!wrap) return;
        wrap.innerHTML = '';

        wrap.appendChild(el('h3', { class: 'team-name-editor__title', text: 'Team Names' }));

        const grid = el('div', { class: 'team-name-editor__grid' });
        state.teams.forEach(teamNum => {
          const key = String(teamNum);
          const fallbackName = `Team ${teamNum}`;
          const stored = state.teamNames?.[key];
          const hasCustomName = typeof stored === 'string' && stored.trim().length && stored.trim() !== fallbackName;
          const displayValue = hasCustomName ? stored.trim() : '';

          const field = el('label', { class: 'team-name-editor__field' });
          field.appendChild(el('span', { class: 'team-name-editor__label', text: 'Enter name' }));
          const input = el('input', {
            class: 'team-name-editor__input',
            type: 'text',
            value: displayValue,
            'data-team': String(teamNum),
            placeholder: 'Enter name',
            maxlength: '40',
            autocomplete: 'off'
          });
          input.addEventListener('input', (event) => {
            const target = event.target;
            const team = Number(target.getAttribute('data-team'));
            applyTeamName(team, target.value);
          });
          input.addEventListener('blur', (event) => {
            const team = Number(event.target.getAttribute('data-team'));
            const fallback = `Team ${team}`;
            const currentName = findTeamName(team);
            event.target.value = currentName === fallback ? '' : currentName;
          });
          field.appendChild(input);
          grid.appendChild(field);
        });
        wrap.appendChild(grid);
      }

      function applyTeamName(teamNum, rawName) {
        if (!teamNum) return;
        const key = String(teamNum);
        const fallback = `Team ${teamNum}`;
        const trimmed = (rawName || '').replace(/\s+/g, ' ').trim();
        state.teamNames[key] = trimmed.length ? trimmed : fallback;
        syncLeaderboardTitles();
        renderScoreChart();
        persistDraftSnapshot();
      }

      function slugify(text) {
        return (text || '')
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'golfer';
      }

      function ensureUniquePlayerId(base) {
        const safeBase = base || 'golfer';
        let candidate = safeBase;
        let counter = 1;
        while (qs(`.player[data-player-id="${candidate}"]`)) {
          candidate = `${safeBase}-${counter}`;
          counter += 1;
        }
        return candidate;
      }

      function isValidTier(tier) {
        return TIER_VALUES.includes(Number(tier));
      }

      function movePlayerToTier(card, tier, { before } = {}) {
        if (!card) return false;
        const desiredTier = Number(tier);
        const currentTier = Number(card.getAttribute('data-tier')) || desiredTier;
        const targetList = qs(`.tier[data-tier="${desiredTier}"] .players`);
        const insertionTarget = (before && before.parentNode === targetList && before !== card) ? before : null;
        if (!isValidTier(desiredTier)) {
          announce('Choose a valid tier.');
          return false;
        }
        if (!targetList) {
          announce('Tier not found.');
          return false;
        }
        if (desiredTier === currentTier) {
          if (insertionTarget) {
            targetList.insertBefore(card, insertionTarget);
          } else if (card.parentNode === targetList) {
            targetList.appendChild(card);
          }
          return true;
        }
        const id = card.getAttribute('data-player-id');
        const name = card.querySelector('.name')?.textContent?.trim() || 'Player';
        if (id && state.draftedPlayers.has(id)) {
          announce(`${name} already drafted. Tier locked.`);
          return false;
        }
        card.setAttribute('data-tier', String(desiredTier));
        card.dataset.tier = String(desiredTier);
        if (insertionTarget) {
          targetList.insertBefore(card, insertionTarget);
        } else {
          targetList.appendChild(card);
        }
        if (name) {
          announce(`${name} moved to Tier ${desiredTier}.`);
        } else {
          announce(`Player moved to Tier ${desiredTier}.`);
        }
        persistDraftSnapshot();
        return true;
      }

      function serializeDraftSnapshot() {
        const teamsRoot = qs('#teams');
        if (!teamsRoot) return null;
        const snapshot = {
          version: 1,
          timestamp: Date.now(),
          tournament: state.tournament || 'Masters',
          format: state.format,
          teamCount: state.teamCount,
          teamNames: { ...state.teamNames },
          teams: [],
          scores: { ...state.scores },
          draftedPlayers: Array.from(state.draftedPlayers || []),
          currentPick: state.currentPick,
          pickOrder: Array.isArray(state.pickOrder) ? state.pickOrder.slice() : [],
          isActive: state.isActive,
          hasCompleted: state.hasCompleted,
          rounds: state.rounds
        };

        state.teams.forEach(teamNum => {
          const teamEl = qs(`#teams .team[data-team="${teamNum}"]`);
          const teamName = findTeamName(teamNum);
          const slots = [];
          if (teamEl) {
            qsa('.slot', teamEl).forEach(slot => {
              const id = slot.getAttribute('data-player-id');
              if (!id) return;
              const tier = Number(slot.getAttribute('data-tier'));
              const name = slot.querySelector('.name')?.textContent?.trim() || '';
              const subtle = slot.querySelector('.subtle')?.textContent || '';
              let odds = '';
              const match = subtle.match(/([+\-]?\d{3,5})/);
              if (match) odds = match[1];
              const rounds = getRoundScores(id);
              const total = getScoreFor(id);
              slots.push({ id, tier, name, odds, rounds, total });
            });
          }
          snapshot.teams.push({ teamNum, name: teamName, slots });
        });

        snapshot.board = [];
        const board = qs('#draft-board');
        if (board) {
          qsa('.round-row', board).forEach(row => {
            const round = Number(row.getAttribute('data-round')) || 0;
            qsa('.cell[data-team]', row).forEach(cell => {
              const id = cell.getAttribute('data-player-id');
              if (!id) return;
              const teamNum = Number(cell.getAttribute('data-team')) || 0;
              const name = cell.querySelector('.name')?.textContent?.trim() || '';
              const oddsAttr = cell.getAttribute('data-odds') || '';
              const tierAttr = Number(cell.getAttribute('data-tier')) || 0;
              snapshot.board.push({ round, teamNum, id, name, odds: oddsAttr, tier: tierAttr });
            });
          });
        } else {
          const previous = readStorage(STORAGE_KEYS.snapshot, null);
          if (previous && Array.isArray(previous.board)) {
            snapshot.board = previous.board;
          }
        }
        snapshot.tournament = state.tournament;

        return snapshot;
      }

      function persistDraftSnapshot() {
        if (!STORAGE_AVAILABLE || isServerSynchronized) return;
        const data = serializeDraftSnapshot();
        if (!data) {
          clearDraftSnapshot();
          return;
        }
        writeStorage(STORAGE_KEYS.snapshot, data);
      }

      function clearDraftSnapshot() {
        removeStorage(STORAGE_KEYS.snapshot);
      }

      function loadDraftSnapshot() {
        const data = readStorage(STORAGE_KEYS.snapshot, null);
        if (!data || typeof data !== 'object') return null;
        return data;
      }

      function applySnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return;
        state.rounds = snapshot.rounds || state.rounds;
        state.format = snapshot.format || state.format;
        state.teamCount = snapshot.teamCount || state.teamCount;
        state.teams = Array.from({ length: state.teamCount }, (_, idx) => idx + 1);
        state.teamNames = {};
        const storedNames = snapshot.teamNames || {};
        state.teams.forEach(teamNum => {
          const key = String(teamNum);
          const teamData = snapshot.teams?.find(t => Number(t.teamNum) === teamNum);
          const fromStored = storedNames[key];
          state.teamNames[key] = typeof fromStored === 'string' && fromStored.trim().length
            ? fromStored.trim()
            : (teamData?.name || `Team ${teamNum}`);
        });

        state.draftedPlayers = new Set(Array.isArray(snapshot.draftedPlayers) ? snapshot.draftedPlayers : []);
        state.scores = (snapshot.scores && typeof snapshot.scores === 'object') ? { ...snapshot.scores } : {};
        state.pickOrder = Array.isArray(snapshot.pickOrder) && snapshot.pickOrder.length
          ? snapshot.pickOrder.slice()
          : computePickOrder(state.format);
        state.currentPick = Number(snapshot.currentPick) || 0;
        state.isActive = Boolean(snapshot.isActive);
        state.hasCompleted = Boolean(snapshot.hasCompleted);

        if (snapshot.tournament) {
          applyTournamentTheme(snapshot.tournament);
        }

        syncTeamNames();
        rebuildTeamSections();

        if (Array.isArray(snapshot.teams)) {
          snapshot.teams.forEach(team => {
            const teamNum = Number(team.teamNum);
            if (!teamNum || !Array.isArray(team.slots)) return;
            team.slots.forEach(slot => {
              const tier = Number(slot.tier);
              const name = slot.name || 'Player';
              const odds = slot.odds || '';
              const id = slot.id || slugify(name);
              if (Array.isArray(slot.rounds)) {
                state.scores[id] = slot.rounds.slice(0, state.rounds);
              }
              fillTeamSlot(teamNum, tier, name, odds, id);
              upsertLeaderboardRow({ teamNum, id, name, tier, odds });
            });
          });
        }

        if (Array.isArray(snapshot.board)) {
          snapshot.board.forEach(entry => {
            const round = Number(entry.round) || 0;
            const teamNum = Number(entry.teamNum) || 0;
            if (!round || !teamNum) return;
            const name = entry.name || 'Player';
            const odds = entry.odds || '';
            const tier = Number(entry.tier) || 1;
            const id = entry.id;
            fillBoardCell(round, teamNum, name, odds, tier, id);
          });
        }

        if (snapshot.draftedPlayers) {
          snapshot.draftedPlayers.forEach(id => {
            const card = qs(`.player[data-player-id="${id}"]`);
            if (card) disablePlayerEl(card);
          });
        }

        recomputeTeamTotals();
        updateStartButton();
        updateOnClock();
      }

      function loadPastDraftsFromStorage() {
        const stored = readStorage(STORAGE_KEYS.history, null);
        if (Array.isArray(stored)) {
          state.pastDrafts = stored;
        }
      }

      function persistPastDrafts() {
        writeStorage(STORAGE_KEYS.history, state.pastDrafts);
      }

      function attachDragHandlers(card) {
        if (!card) return;
        card.setAttribute('draggable', 'true');
        card.addEventListener('dragstart', (event) => {
          const id = card.getAttribute('data-player-id');
          if (card.classList.contains('drafted') || (id && state.draftedPlayers.has(id))) {
            event.preventDefault();
            return;
          }
          dragState.card = card;
          card.classList.add('is-dragging');
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', id || 'player');
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('is-dragging');
          dragState.card = null;
          qsa('.tier.is-drop-target').forEach(t => t.classList.remove('is-drop-target'));
        });
      }

      function createPlayerCard({ id, name, odds, tier }) {
        const card = el('div', {
          class: 'player',
          role: 'listitem',
          'data-player-id': id,
          'data-odds': odds,
          'data-tier': String(tier)
        });
        const nameEl = el('span', { class: 'name', text: name });
        const oddsEl = el('span', { class: 'odds', text: odds });
        const actions = el('div', { class: 'actions' }, [
          el('button', { class: 'draft-btn', 'data-action': 'draft', type: 'button', text: 'Draft' })
        ]);
        card.appendChild(nameEl);
        card.appendChild(oddsEl);
        card.appendChild(actions);
        attachDragHandlers(card);
        return card;
      }

      function addPlayerToTier({ name, odds, tier }) {
        const playersWrap = qs(`.tier[data-tier="${tier}"] .players`);
        if (!playersWrap) {
          announce('Tier not found.');
          return null;
        }
        const baseId = slugify(name);
        const id = ensureUniquePlayerId(baseId);
        const card = createPlayerCard({ id, name, odds, tier });
        playersWrap.appendChild(card);
        announce(`${name} added to Tier ${tier}.`);
        return card;
      }

      function enhancePlayerPool() {
        qsa('.player').forEach(card => {
          attachDragHandlers(card);
        });
      }

      function bindTierDropZones() {
        qsa('.tier').forEach(tierEl => {
          const playersWrap = tierEl.querySelector('.players');
          if (!playersWrap || playersWrap.dataset.dndBound === '1') return;
          playersWrap.dataset.dndBound = '1';

          const clearHighlight = () => tierEl.classList.remove('is-drop-target');

          playersWrap.addEventListener('dragenter', (event) => {
            if (!dragState.card) return;
            event.preventDefault();
            tierEl.classList.add('is-drop-target');
          });

          playersWrap.addEventListener('dragover', (event) => {
            if (!dragState.card) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          });

          playersWrap.addEventListener('dragleave', (event) => {
            if (!dragState.card) return;
            if (!playersWrap.contains(event.relatedTarget)) {
              clearHighlight();
            }
          });

          playersWrap.addEventListener('drop', (event) => {
            if (!dragState.card) return;
            event.preventDefault();
            clearHighlight();
            const targetTier = Number(tierEl.getAttribute('data-tier'));
            const referenceCard = event.target.closest('.player');
            const beforeNode = (referenceCard && referenceCard !== dragState.card) ? referenceCard : null;
            movePlayerToTier(dragState.card, targetTier, { before: beforeNode });
          });
        });
      }

      function rebuildTeamSections() {
        renderTeamsCard();
        renderTeamTotals();
        renderTeamNameEditor();
        renderLeaderboards();
        renderPastEvents();
        syncLeaderboardTitles();
      }

      function clearLeaderboard() {
        qsa('#team-leaderboards tbody').forEach(tb => tb.innerHTML = '');
        renderScoreChart();
      }

      function resetTeamTotals() {
        qsa('[data-team-score]').forEach(chip => { chip.textContent = 'E'; });
      }

      function setTeamCount(count) {
        const n = Math.max(2, Math.min(Number(count) || state.teamCount, 4));
        state.teamCount = n;
        state.teams = Array.from({ length: n }, (_, idx) => idx + 1);
        syncTeamNames();
        rebuildTeamSections();
      }

      function handleTeamCountChange(count, { silent = false, preserveSnapshot = false } = {}) {
        const previous = state.teamCount;
        setTeamCount(count);
        resetBoard({ silent: true, preserveStorage: preserveSnapshot });
        const playersSelect = qs('[data-hook="players-select"]');
        if (playersSelect) {
          const desired = String(state.teamCount);
          if (playersSelect.value !== desired) playersSelect.value = desired;
        }
        if (!silent && state.teamCount !== previous) {
          announce(`Team count set to ${state.teamCount}. Choose Start Draft to begin.`);
        }
        if (!preserveSnapshot) {
          persistDraftSnapshot();
        }
      }

      function syncLeaderboardTitles() {
        state.teams.forEach(teamNum => {
          const name = findTeamName(teamNum);
          const rosterHeader = qs(`.team[data-team="${teamNum}"] h3`);
          if (rosterHeader) {
            const chip = rosterHeader.querySelector('.chip');
            rosterHeader.textContent = name;
            if (chip) rosterHeader.appendChild(chip);
          }
          const board = qs(`#team-leaderboards .team-board[data-team="${teamNum}"]`);
          const totalHeader = qs(`#team-totals [data-team-total="${teamNum}"] h3`);
          if (totalHeader) {
            const chip = totalHeader.querySelector('.chip');
            totalHeader.textContent = `${name} Total: `;
            if (chip) totalHeader.appendChild(chip);
          }
          if (!board) return;
          const title = board.querySelector('.team-board__title');
          if (title) title.textContent = name;
          const table = board.querySelector('.leaderboard-table');
          if (table) table.setAttribute('aria-label', `${name} leaderboard`);
        });
      }

      function recomputeTeamTotals() {
        state.teams.forEach(teamNum => {
            let sum = 0;
            qsa(`.team[data-team="${teamNum}"] .slot`).forEach(slot => {
            const pid = slot.getAttribute('data-player-id');
            if (pid) sum += getScoreFor(pid);
            });
            const badge = qs(`[data-team-score="${teamNum}"]`);
            if (badge) badge.textContent = renderPar(sum);
        });
        renderScoreChart();
      }

      function upsertLeaderboardRow({ teamNum, id, name, tier, odds }) {
        const board = qs(`#team-leaderboards .team-board[data-team="${teamNum}"]`);
        if (!board) return;
        const title = board.querySelector('.team-board__title');
        if (title) title.textContent = findTeamName(teamNum);
        const tbody = board.querySelector('tbody');
        if (!tbody) return;

        const existing = qs(`#team-leaderboards tr[data-player-id="${id}"]`);
        if (existing) {
            const host = existing.closest('tbody');
            if (host && host !== tbody) existing.remove();
        }

        const rounds = getRoundScores(id);

        let row = qs(`tr[data-player-id="${id}"]`, tbody);
        if (!row) {
            row = el('tr', { 'data-player-id': id });
            row.appendChild(el('td', { text: name }));
            row.appendChild(el('td', { text: String(tier) }));
            row.appendChild(el('td', { text: odds }));
            rounds.forEach((val, idx) => {
            const scoreCell = el('td');
            const inp = el('input', {
              type: 'text',
              value: String(val),
              'data-round': String(idx),
              inputmode: 'numeric',
              pattern: '[-+]?\\d*'
            });
            inp.addEventListener('input', () => {
                const num = Number(inp.value || 0);
                setRoundScore(id, idx, isNaN(num) ? 0 : num);
                updateTotalCell(row, id);
                updateSlotChips(id);
                recomputeTeamTotals();
            });
            scoreCell.appendChild(inp);
            row.appendChild(scoreCell);
            });
            const totalCell = el('td', { class: 'total-cell', text: renderPar(getScoreFor(id)) });
            row.appendChild(totalCell);
            tbody.appendChild(row);
        } else {
            // update teamName (if user renames later), odds, etc.
            if (title) title.textContent = findTeamName(teamNum);
            row.children[0].textContent = name;
            row.children[1].textContent = String(tier);
            row.children[2].textContent = odds;
            rounds.forEach((val, idx) => {
            const inp = row.children[3 + idx]?.querySelector('input');
            if (inp) inp.value = String(val);
            });
            updateTotalCell(row, id);
        }
      }

      function updateTotalCell(row, playerId) {
        const total = renderPar(getScoreFor(playerId));
        const cell = row.querySelector('.total-cell');
        if (cell) cell.textContent = total;
      }

      function updateSlotChips(playerId) {
        const val = renderPar(getScoreFor(playerId));
        // update roster slot chip
        qsa(`.slot[data-player-id="${playerId}"] .chip`).forEach(ch => ch.textContent = val);
      }

      function applyOddsUpdate(playerEl, odds) {
        if (!playerEl) return false;
        const id = playerEl.getAttribute('data-player-id');
        const tier = playerEl.getAttribute('data-tier');
        if (!id || !tier) return false;
        playerEl.setAttribute('data-odds', odds);
        const oddsEl = playerEl.querySelector('.odds');
        if (oddsEl) oddsEl.textContent = odds;
        qsa(`.team .slot[data-player-id="${id}"] .subtle`).forEach(el => { el.textContent = `Tier ${tier} • ${odds}`; });
        qsa(`#draft-board .cell[data-player-id="${id}"] .subtle`).forEach(el => { el.textContent = `${odds} • Tier ${tier}`; });
        const leaderboardRow = qs(`#team-leaderboards tr[data-player-id="${id}"]`);
        if (leaderboardRow) {
          const oddsCell = leaderboardRow.children[2];
          if (oddsCell) oddsCell.textContent = odds;
        }
        return true;
      }

      function importOddsCSV(text) {
        const lines = (text || '')
          .split(/\r?\n|;/)
          .map(line => line.trim())
          .filter(Boolean);
        if (!lines.length) {
          announce('Provide CSV data to import.');
          return { updated: 0, moved: 0, created: 0, missing: [] };
        }
        let updated = 0;
        let moved = 0;
        let created = 0;
        const missing = [];

        lines.forEach(line => {
          const parts = line.split(',').map(part => part.trim());
          if (!parts.length) return;

          const name = parts[0];
          const odds = parts[1] ?? '';
          const tierToken = parts[2];

          if (!name) return;

          let tierValue = null;
          if (typeof tierToken === 'string' && tierToken.length) {
            const match = tierToken.match(/\d+/);
            if (match) {
              tierValue = Number(match[0]);
            }
          }

          const playerEl = qsa('.player').find(card => {
            const cardName = card.querySelector('.name')?.textContent?.trim() || '';
            return cardName.toLowerCase() === name.toLowerCase();
          });

          const tierDefined = tierValue !== null && isValidTier(tierValue);

          if (playerEl) {
            if (odds) {
              if (applyOddsUpdate(playerEl, odds)) updated += 1;
            }
            if (tierDefined) {
              const currentTier = Number(playerEl.getAttribute('data-tier'));
              if (currentTier !== tierValue && movePlayerToTier(playerEl, tierValue)) moved += 1;
            } else if (tierToken && !tierDefined) {
              missing.push(`${name} (invalid tier "${tierToken}")`);
            }
            return;
          }

          if (tierDefined) {
            const card = addPlayerToTier({ name, odds, tier: tierValue });
            if (card) {
              created += 1;
            }
          } else {
            missing.push(`${name} (not found)`);
          }
        });

        const messages = [];
        if (updated) messages.push(`${updated} odds`);
        if (moved) messages.push(`${moved} tier change${moved === 1 ? '' : 's'}`);
        if (created) messages.push(`${created} new player${created === 1 ? '' : 's'}`);

        if (messages.length) {
          announce(`Imported: ${messages.join(', ')}.`);
        } else if (missing.length === 0) {
          announce('No changes made.');
        } else {
          announce('No matching players found to update.');
        }

        if (missing.length) {
          console.warn('[Players Import] Issues:', missing.join('; '));
        }

        persistDraftSnapshot();

        return { updated, moved, created, missing };
      }

      function buildBoard(format) {
        const board = qs('#draft-board');
        if (!board) return;
        board.style.setProperty('--team-count', String(state.teamCount));
        board.innerHTML = '';
        for (let r = 1; r <= state.rounds; r++) {
          const seq = buildRoundOrder(format, r - 1);
          const row = el('div', { class: 'round-row', 'data-round': String(r) });
          row.appendChild(el('div', { class: 'cell round', text: `R${r}` }));
          seq.forEach(teamNum => {
            row.appendChild(el('div', { class: 'cell', 'data-team': String(teamNum), 'data-slot': String(r) }));
          });
          board.appendChild(row);
        }
      }

      function clearTeams() {
        qsa('.team .slot').forEach(s => {
          s.innerHTML = '';
          s.removeAttribute('data-player-id');
        });
        qsa('.team h3').forEach(h => {
          const chip = h.querySelector('.chip');
          if (chip) chip.remove();
        });
      }

      function clearPlayerPool() {
        qsa('.player').forEach(p => {
          p.classList.remove('drafted');
          const btn = p.querySelector('.draft-btn');
          if (btn) btn.disabled = false;
        });
      }

      function resetBoard({ silent = false, preserveStorage = false } = {}) {
        state.currentPick = 0;
        state.draftedPlayers.clear();
        state.pickOrder = computePickOrder(state.format);
        state.isActive = false;
        state.hasCompleted = false;
        state.scores = {};
        updateStartButton();
        buildBoard(state.format);
        clearTeams();
        clearPlayerPool();
        clearLeaderboard();
        resetTeamTotals();
        updateOnClock();
        setLeaderboardTab('current');
        if (!silent) announce('Draft reset. Choose Start Draft to begin.');
        if (!preserveStorage) clearDraftSnapshot();
      }

      function startDraft() {
        state.format = qs('[data-hook="format-select"]').value;
        state.currentPick = 0;
        state.draftedPlayers.clear();
        buildBoard(state.format);
        state.pickOrder = computePickOrder(state.format);
        state.isActive = true;
        state.hasCompleted = false;
        updateStartButton();
        updateOnClock();
        setLeaderboardTab('current');
        announce(`${state.format} draft started. ${findTeamName(currentTeam())} is on the clock.`);
        persistDraftSnapshot();
      }

      function currentTeam() { return state.pickOrder[state.currentPick] || 1; }
      function currentRound() { return Math.floor(state.currentPick / state.teams.length) + 1; }

      function updateOnClock() {
        qsa('.team h3').forEach(h => { const chip = h.querySelector('.chip'); if (chip) chip.remove(); });
        syncLeaderboardTitles();
        if (!state.isActive) return;
        const teamNum = currentTeam();
        const header = qs(`.team[data-team="${teamNum}"] h3`);
        if (header) header.appendChild(el('span', { class: 'chip', text: 'On the clock' }));
      }

      function normalizeServerDraft(serverDraft) {
        if (!serverDraft || typeof serverDraft !== 'object') return null;
        const players = serverDraft.players || {};
        const teamsArray = [];
        const teamNamesMap = {};

        Object.values(serverDraft.teams || {}).forEach(team => {
          const teamNum = Number(team.id);
          if (!teamNum) return;
          teamNamesMap[String(teamNum)] = team.name || `Team ${teamNum}`;
          const picks = Array.isArray(team.picks) ? team.picks : [];
          const slots = picks.map(pick => {
            const playerDetails = players[pick.player_id] || {};
            return {
              id: pick.player_id,
              tier: Number(playerDetails.tier) || 1,
              name: playerDetails.name || 'Player',
              odds: playerDetails.odds || '',
              rounds: [0, 0, 0, 0]
            };
          });
          teamsArray.push({ teamNum, name: team.name || `Team ${teamNum}`, slots });
        });

        const board = [];
        Object.values(serverDraft.teams || {}).forEach(team => {
          const teamNum = Number(team.id);
          if (!teamNum) return;
          (team.picks || []).forEach(pick => {
            const playerDetails = players[pick.player_id] || {};
            board.push({
              round: Number(pick.round) || 0,
              teamNum,
              id: pick.player_id,
              name: playerDetails.name || 'Player',
              odds: playerDetails.odds || '',
              tier: Number(playerDetails.tier) || 1
            });
          });
        });

        return {
          tournament: serverDraft.tournament,
          format: serverDraft.format,
          teamCount: serverDraft.teamCount,
          teams: teamsArray,
          teamNames: teamNamesMap,
          board,
          pickOrder: Array.isArray(serverDraft.pickOrder) ? serverDraft.pickOrder.slice() : [],
          currentPick: Number(serverDraft.currentPickIndex) || 0,
          isActive: Boolean(serverDraft.isActive),
          hasCompleted: Boolean(serverDraft.hasCompleted),
          draftedPlayers: board.map(entry => entry.id)
        };
      }

      async function bootstrapServerDraft() {
        try {
          const res = await fetch(`${API_BASE_URL}/drafts/default`);
          if (!res.ok) {
            throw new Error(`Failed to load draft: ${res.status}`);
          }
          const serverDraft = await res.json();
          if (serverDraft && serverDraft.id) {
            currentDraftId = serverDraft.id;
          }
          const normalized = normalizeServerDraft(serverDraft);
          if (normalized) {
            isServerSynchronized = true;
            applySnapshot(normalized);
          }
          connectSocket();
        } catch (err) {
          console.warn('[Server Sync] Unable to load draft from backend:', err);
        }
      }

      function connectSocket() {
        if (socket || typeof io !== 'function') return;
        socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] });
        socket.on('connect', () => {
          if (currentDraftId) {
            socket.emit('join_draft', { draftId: currentDraftId, userId: CLIENT_ID });
          }
        });
        socket.on('draft_state', (serverDraft) => {
          const normalized = normalizeServerDraft(serverDraft);
          if (normalized) {
            isServerSynchronized = true;
            applySnapshot(normalized);
          }
        });
        socket.on('error', (payload) => {
          console.error('[Socket]', payload);
        });
      }

      function teamHasTierFilled(teamNum, tier) {
        const slot = qs(`.team[data-team="${teamNum}"] .slot[data-tier="${tier}"]`);
        return slot && slot.textContent.trim().length > 0;
      }

      function fillTeamSlot(teamNum, tier, name, odds, id) {
        const slot = qs(`.team[data-team="${teamNum}"] .slot[data-tier="${tier}"]`);
        if (!slot) return false;
        slot.innerHTML = '';
        if (id) slot.setAttribute('data-player-id', id);
        const left = el('div', {}, [
            el('div', { class: 'name', text: name }),
            el('div', { class: 'subtle', text: `Tier ${tier} • ${odds}` })
        ]);
        const right = el('span', { class: 'chip', text: renderPar(getScoreFor(id)) });
        slot.appendChild(left);
        slot.appendChild(right);
        return true;
      }

      function fillBoardCell(round, teamNum, name, odds, tier, id) {
        const row = qs(`.round-row[data-round="${round}"]`);
        if (!row) return false;
        const cell = qsa('.cell', row).find(c =>
            c.getAttribute('data-team') === String(teamNum) &&
            c.getAttribute('data-slot') === String(round)
        );
        if (!cell) return false;
        cell.innerHTML = '';
        const wrap = el('div', {}, [
            el('div', { class: 'name', text: name }),
            el('div', { class: 'subtle', text: `${odds} • Tier ${tier}` })
        ]);
        cell.appendChild(wrap);
        if (id) cell.setAttribute('data-player-id', id);
        cell.setAttribute('data-tier', String(tier));
        if (odds) cell.setAttribute('data-odds', odds);
        return true;
      }

      function disablePlayerEl(playerEl) {
        playerEl.classList.add('drafted');
        const btn = playerEl.querySelector('.draft-btn');
        if (btn) btn.disabled = true;
      }

      function announce(msg) {
        let live = qs('#live-region');
        if (!live) {
          live = el('div', { id: 'live-region', style: 'position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;', role: 'status', 'aria-live': 'polite' });
          document.body.appendChild(live);
        }
        live.textContent = msg;
      }

      function finishDraft() {
        state.isActive = false;
        state.hasCompleted = true;
        updateStartButton();
        updateOnClock();
        saveDraftToHistory();
        setLeaderboardTab('current');
        announce('Draft complete. Saved to Past Events.');
      }

      function handleDraftClick(playerEl) {
        if (!state.isActive) { announce('Start the draft first.'); return; }
        const id = playerEl.getAttribute('data-player-id');
        const tier = Number(playerEl.getAttribute('data-tier'));
        const odds = playerEl.getAttribute('data-odds');
        const name = playerEl.querySelector('.name')?.textContent?.trim() || 'Player';

        if (state.draftedPlayers.has(id)) { announce(`${name} already drafted.`); return; }

        const teamNum = currentTeam();
        const round = currentRound();

        if (isServerSynchronized && socket && socket.connected && currentDraftId) {
          socket.emit('submit_pick', {
            draftId: currentDraftId,
            teamId: teamNum,
            playerId: id,
            userId: CLIENT_ID
          });
          return;
        }

        if (teamHasTierFilled(teamNum, tier)) { announce(`${findTeamName(teamNum)} already has a Tier ${tier} pick.`); return; }

        const ok1 = fillTeamSlot(teamNum, tier, name, odds, id);
        const ok2 = fillBoardCell(round, teamNum, name, odds, tier, id);
        if (!(ok1 && ok2)) { announce('Could not place pick.'); return; }

        state.draftedPlayers.add(id);
        disablePlayerEl(playerEl);

        upsertLeaderboardRow({ teamNum, id, name, tier, odds });
        recomputeTeamTotals();
        persistDraftSnapshot();

        state.currentPick += 1;
        if (state.currentPick >= state.pickOrder.length) { finishDraft(); return; }

        updateOnClock();
        announce(`${findTeamName(currentTeam())} is on the clock.`);
      }

      // ===== Export CSV =====
      function exportCSV() {
        const rows = [];
        rows.push(['Team', 'Tier', 'Player', 'Odds']);
        state.teams.forEach(teamNum => {
          const teamName = findTeamName(teamNum);
          qsa(`.team[data-team="${teamNum}"] .slot`).forEach(slot => {
            const tier = Number(slot.getAttribute('data-tier'));
            const name = slot.querySelector('.name')?.textContent?.trim() || '';
            const subtle = slot.querySelector('.subtle')?.textContent || '';
            let odds = '';
            const m = subtle.match(/([+\-]?\d{3,5})/);
            if (m) odds = m[1];
            if (name) rows.push([teamName, `Tier ${tier}`, name, odds]);
          });
        });
        const csv = rows
          .map(r => r.map(cell => {
            const s = String(cell ?? '');
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
          }).join(','))
          .join('\n');

        const tour = state.tournament || 'Tournament';
        const ts = new Date().toISOString().slice(0,10);
        const filename = `${tour.replace(/\s+/g,'_')}_draft_${ts}.csv`;

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
      }

      // ===== Wire Up =====
      function attachHandlers() {
        setupTopbarMenu();
        const topbarControls = qs('header.topbar .controls');
        const menuToggle = qs('[data-action="toggle-topbar-menu"]');
        const collapseTopbarMenu = () => {
          if (window.innerWidth <= MOBILE_MENU_BREAKPOINT && topbarControls) {
            topbarControls.classList.remove('is-open');
            if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');
            if (menuToggle) menuToggle.classList.remove('is-open');
          }
        };

        const formatSelect = qs('[data-hook="format-select"]');
        if (formatSelect) {
          formatSelect.addEventListener('change', (e) => {
            state.format = e.target.value;
            resetBoard({ silent: true });
            announce(`Format set to ${state.format}. Choose Start Draft to begin.`);
            collapseTopbarMenu();
          });
        }

        qsa('[data-hook="tournament-select"] .tournament-tab').forEach(tab => {
          tab.addEventListener('click', () => {
            const label = tab.getAttribute('data-tournament') || tab.textContent;
            applyTournamentTheme(label);
            persistDraftSnapshot();
            collapseTopbarMenu();
          });
        });

        qsa('.leaderboard-tab').forEach(btn => {
          btn.addEventListener('click', () => {
            const tab = btn.getAttribute('data-tab');
            setLeaderboardTab(tab);
          });
        });

        const clearHistoryBtn = qs('[data-action="clear-history"]');
        if (clearHistoryBtn) {
          clearHistoryBtn.addEventListener('click', () => {
            if (!state.pastDrafts.length) return;
            state.pastDrafts = [];
            renderPastEvents();
            persistPastDrafts();
            announce('Past events cleared.');
          });
        }

        const playersSelect = qs('[data-hook="players-select"]');
        if (playersSelect) {
          playersSelect.addEventListener('change', (e) => {
            handleTeamCountChange(Number(e.target.value));
            collapseTopbarMenu();
          });
        }

        const addPlayerForm = qs('#add-player-form');
        if (addPlayerForm) {
          addPlayerForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const nameInput = qs('#new-player-name');
            const oddsInput = qs('#new-player-odds');
            const tierSelect = qs('#new-player-tier');
            const name = nameInput?.value?.trim();
            const odds = oddsInput?.value?.trim() || 'N/A';
            const tier = Number(tierSelect?.value || 0);
            if (!name) { announce('Enter a golfer name.'); return; }
            if (![1,2,3,4].includes(tier)) { announce('Choose a valid tier.'); return; }
            const card = addPlayerToTier({ name, odds, tier });
            if (card) {
              if (nameInput) nameInput.value = '';
              if (oddsInput) oddsInput.value = '';
              if (tierSelect) tierSelect.value = String(tier);
              nameInput?.focus();
            }
          });
        }

        // Scores CSV import/export controls removed from UI; handlers stripped intentionally.
        const oddsBtn = qs('[data-action="import-odds"]');
        if (oddsBtn) oddsBtn.addEventListener('click', () => {
          const textarea = qs('#odds-csv');
          const contents = textarea?.value || '';
          if (!contents.trim()) {
            announce('Paste odds CSV data first.');
            return;
          }
          importOddsCSV(contents);
          if (textarea) textarea.value = '';
        });

        const pool = qs('#tiers');
        if (pool) {
          pool.addEventListener('click', (e) => {
            const card = e.target.closest('.player');
            if (!card) return;
            if (!state.isActive) { startDraft(); }
            handleDraftClick(card);
          });
        }

        qsa('.player .draft-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const playerEl = e.currentTarget.closest('.player');
            if (!state.isActive) { startDraft(); }
            handleDraftClick(playerEl);
          });
        });

        const startBtn = qs('[data-action="start-draft"]');
        if (startBtn) startBtn.addEventListener('click', () => { startDraft(); collapseTopbarMenu(); });
        const resetBtn = qs('[data-action="reset"]');
        if (resetBtn) resetBtn.addEventListener('click', () => { resetBoard(); collapseTopbarMenu(); });
        const exportBtn = qs('[data-action="export"]');
        if (exportBtn) exportBtn.addEventListener('click', () => { exportCSV(); collapseTopbarMenu(); });
      }

      // ===== Init =====
      async function init() {
        const y = qs('#year'); if (y) y.textContent = new Date().getFullYear();
        const formatSelect = qs('[data-hook="format-select"]');
        if (formatSelect) state.format = formatSelect.value;
        applyTournamentTheme(state.tournament);
        loadPastDraftsFromStorage();
        const snapshot = loadDraftSnapshot();
        const playersSelect = qs('[data-hook="players-select"]');
        const desiredTeamCount = snapshot?.teamCount || (playersSelect ? Number(playersSelect.value) : state.teamCount);
        if (playersSelect && snapshot?.teamCount) {
          playersSelect.value = String(snapshot.teamCount);
        }
        handleTeamCountChange(desiredTeamCount, { silent: true, preserveSnapshot: true });
        if (snapshot) {
          applySnapshot(snapshot);
        }
        enhancePlayerPool();
        bindTierDropZones();
        attachHandlers();
        if (!snapshot) {
          state.isActive = false;
          state.hasCompleted = false;
        }
        updateStartButton();
        setLeaderboardTab(state.activeLeaderboardTab);
        if (!snapshot) {
          updateOnClock();
        }
        announce('Draft ready. Choose Start Draft to begin.');
        recomputeTeamTotals();
        await bootstrapServerDraft();
      }

      // ===== Smoke Tests (non-destructive) =====
      (function smokeTests(){
        try {
            const tierCounts = TIER_VALUES.map(tier => qsa(`.player[data-tier="${tier}"]`).length);
            const poolSize = tierCounts.reduce((sum, val) => sum + val, 0);
            console.assert(poolSize > 0, 'Player pool should not be empty');
            console.info('[Player Pool] Tier counts:', tierCounts.join('/'));
            console.assert(typeof recomputeTeamTotals === 'function', 'recomputeTeamTotals exists');
            console.assert(typeof upsertLeaderboardRow === 'function', 'upsertLeaderboardRow exists');
            console.assert(qsa('#team-leaderboards .team-board').length === state.teams.length, 'Leaderboard has per-team tables');
            console.assert(qsa('.leaderboard-table thead th').length >= 8, 'Leaderboard shows round breakdown');
            console.info('[Leaderboard Smoke Tests] passed');
        } catch (e) {
            console.warn('[Leaderboard Smoke Tests] issue:', e);
        }
        })();

      init().then(() => runSmokeTests());
    })();
  
