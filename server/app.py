from __future__ import annotations

import os

import uuid
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional

from flask import Flask, jsonify, request, abort
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room

# ----------------------------------------------------------------------------
# Data models (kept in-memory for now)
# ----------------------------------------------------------------------------

@dataclass
class Player:
    id: str
    name: str
    odds: str
    tier: int


@dataclass
class Pick:
    id: str
    player_id: str
    team_id: str
    round: int
    created_by: Optional[str] = None


@dataclass
class Team:
    id: str
    name: str
    owner: Optional[str] = None
    picks: List[Pick] = field(default_factory=list)


@dataclass
class Draft:
    id: str
    tournament: str
    format: str
    team_count: int
    teams: Dict[str, Team]
    players: Dict[str, Player]
    pick_order: List[str]
    current_pick_index: int = 0
    is_active: bool = False
    has_completed: bool = False

    def serialize(self) -> Dict:
        return {
            "id": self.id,
            "tournament": self.tournament,
            "format": self.format,
            "teamCount": self.team_count,
            "teams": {tid: {
                "id": team.id,
                "name": team.name,
                "owner": team.owner,
                "picks": [asdict(p) for p in team.picks]
            } for tid, team in self.teams.items()},
            "players": {pid: asdict(player) for pid, player in self.players.items()},
            "pickOrder": self.pick_order,
            "currentPickIndex": self.current_pick_index,
            "isActive": self.is_active,
            "hasCompleted": self.has_completed
        }


# ----------------------------------------------------------------------------
# In-memory state (replace with database persistence later)
# ----------------------------------------------------------------------------

drafts: Dict[str, Draft] = {}
DEFAULT_DRAFT_ID: Optional[str] = None


def create_default_players() -> Dict[str, Player]:
    """Return a small static roster of players by tier."""
    seed = [
        ("jon-rahm", "Jon Rahm", "+900", 1),
        ("rory-mcilroy", "Rory McIlroy", "+650", 1),
        ("scottie-scheffler", "Scottie Scheffler", "+450", 1),
        ("ludvig-aberg", "Ludvig Åberg", "+1800", 2),
        ("brooks-koepka", "Brooks Koepka", "+1600", 2),
        ("tommy-fleetwood", "Tommy Fleetwood", "+2800", 3),
        ("max-homa", "Max Homa", "+3000", 3),
        ("wyndham-clark", "Wyndham Clark", "+4500", 4),
        ("collin-morikawa", "Collin Morikawa", "+4000", 4),
    ]
    return {pid: Player(pid, name, odds, tier) for pid, name, odds, tier in seed}


def create_draft(tournament: str, fmt: str, team_count: int) -> Draft:
    draft_id = uuid.uuid4().hex
    teams = {
        str(idx + 1): Team(id=str(idx + 1), name=f"Team {idx + 1}")
        for idx in range(team_count)
    }
    pick_order = [str(idx + 1) for idx in range(team_count)]
    draft = Draft(
        id=draft_id,
        tournament=tournament,
        format=fmt,
        team_count=team_count,
        teams=teams,
        players=create_default_players(),
        pick_order=pick_order,
    )
    drafts[draft_id] = draft
    global DEFAULT_DRAFT_ID
    if DEFAULT_DRAFT_ID is None:
        DEFAULT_DRAFT_ID = draft_id
    return draft


# ----------------------------------------------------------------------------
# Flask / Socket.IO setup
# ----------------------------------------------------------------------------

app = Flask(__name__)
app.config['SECRET_KEY'] = 'replace-me'
CORS(app, resources={r"/api/*": {"origins": "*"}}, supports_credentials=True)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')


# ----------------------------------------------------------------------------
# REST API routes
# ----------------------------------------------------------------------------

@app.route('/')
def index():
    return {'message': 'Draft backend is running'}, 200

@app.route('/', methods=['GET'])
def root() -> tuple:
    return jsonify({"status": "ok", "service": "golf-draft-backend"})


@app.route('/api/health', methods=['GET'])
def health() -> tuple:
    return jsonify({"status": "ok"})


@app.route('/api/drafts', methods=['POST'])
def create_draft_route():
    payload = request.get_json(force=True, silent=True) or {}
    tournament = payload.get('tournament', 'Masters')
    fmt = payload.get('format', 'Snake')
    team_count = int(payload.get('teamCount', 4))
    draft = create_draft(tournament, fmt, team_count)
    if payload.get('setDefault'):
        global DEFAULT_DRAFT_ID
        DEFAULT_DRAFT_ID = draft.id
    return jsonify(draft.serialize()), 201


@app.route('/api/drafts/<draft_id>', methods=['GET'])
def get_draft(draft_id: str):
    draft = drafts.get(draft_id)
    if not draft:
        abort(404, description="Draft not found")
    return jsonify(draft.serialize())


@app.route('/api/drafts/default', methods=['GET'])
def get_default_draft():
    global DEFAULT_DRAFT_ID
    if not drafts:
        default_draft = create_draft('Masters', 'Snake', 4)
        DEFAULT_DRAFT_ID = default_draft.id
    draft_id = DEFAULT_DRAFT_ID or next(iter(drafts))
    return jsonify(drafts[draft_id].serialize())


@app.route('/api/drafts/<draft_id>/state', methods=['PATCH'])
def update_draft_state(draft_id: str):
    draft = drafts.get(draft_id)
    if not draft:
        abort(404, description="Draft not found")
    payload = request.get_json(force=True, silent=True) or {}
    if 'isActive' in payload:
        draft.is_active = bool(payload['isActive'])
    if 'hasCompleted' in payload:
        draft.has_completed = bool(payload['hasCompleted'])
    return jsonify(draft.serialize())


# ----------------------------------------------------------------------------
# Socket.IO events
# ----------------------------------------------------------------------------

@socketio.on('join_draft')
def on_join_draft(data):
    draft_id = data.get('draftId')
    user_id = data.get('userId')
    if not draft_id or draft_id not in drafts:
        emit('error', {'message': 'Draft not found'})
        return
    join_room(draft_id)
    emit('draft_state', drafts[draft_id].serialize(), room=request.sid)
    emit('user_joined', {'userId': user_id}, room=draft_id, include_self=False)


@socketio.on('leave_draft')
def on_leave_draft(data):
    draft_id = data.get('draftId')
    user_id = data.get('userId')
    if draft_id:
        leave_room(draft_id)
        emit('user_left', {'userId': user_id}, room=draft_id)


@socketio.on('submit_pick')
def on_submit_pick(data):
    draft_id = data.get('draftId')
    team_id = str(data.get('teamId'))
    player_id = data.get('playerId')
    user_id = data.get('userId')

    draft = drafts.get(draft_id)
    if not draft:
        emit('error', {'message': 'Draft not found'})
        return
    if team_id not in draft.teams:
        emit('error', {'message': 'Team not found'})
        return
    player = draft.players.get(player_id)
    if not player:
        emit('error', {'message': 'Player not found'})
        return

    # Prevent duplicate picks
    for team in draft.teams.values():
        if any(p.player_id == player_id for p in team.picks):
            emit('error', {'message': 'Player already drafted'})
            return

    pick = Pick(
        id=uuid.uuid4().hex,
        player_id=player_id,
        team_id=team_id,
        round=len(draft.teams[team_id].picks) + 1,
        created_by=user_id
    )
    draft.teams[team_id].picks.append(pick)

    draft.current_pick_index = (draft.current_pick_index + 1) % len(draft.pick_order)
    draft.is_active = True

    socketio.emit('draft_state', draft.serialize(), room=draft_id)


# ----------------------------------------------------------------------------
# Entry point
# ----------------------------------------------------------------------------

if __name__ == '__main__':
    default_draft = create_draft('Masters', 'Snake', 4)
    DEFAULT_DRAFT_ID = default_draft.id
    port = int(os.environ.get('PORT', 5001))
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
