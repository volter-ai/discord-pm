"""SQLite persistence for standup summaries."""

import json
from pathlib import Path

import aiosqlite

from ..models.standup import ParticipantUpdate, StandupSummary

_DDL = """
CREATE TABLE IF NOT EXISTS standups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    INTEGER NOT NULL,
    channel_id  INTEGER NOT NULL,
    started_at  TEXT    NOT NULL,
    ended_at    TEXT    NOT NULL,
    participants TEXT   NOT NULL,  -- JSON array
    transcript  TEXT    NOT NULL,
    summary     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_standups_guild ON standups (guild_id, started_at DESC);
"""


class StandupStore:
    def __init__(self, db_path: str | Path = "data/standups.db"):
        self._db_path = Path(db_path)

    async def init(self) -> None:
        """Create tables if they don't exist. Call once at bot startup."""
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self._db_path) as db:
            await db.executescript(_DDL)
            await db.commit()

    async def save(self, summary: StandupSummary) -> int:
        """Persist a standup summary. Returns the new row id."""
        participants_json = json.dumps([p.model_dump() for p in summary.participants])
        async with aiosqlite.connect(self._db_path) as db:
            cursor = await db.execute(
                """
                INSERT INTO standups
                    (guild_id, channel_id, started_at, ended_at, participants, transcript, summary)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    summary.guild_id,
                    summary.channel_id,
                    summary.started_at.isoformat(),
                    summary.ended_at.isoformat(),
                    participants_json,
                    summary.raw_transcript,
                    summary.summary_text,
                ),
            )
            await db.commit()
            return cursor.lastrowid  # type: ignore[return-value]

    async def recent(self, guild_id: int, limit: int = 10) -> list[StandupSummary]:
        """Return the most recent standups for a guild."""
        async with aiosqlite.connect(self._db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT * FROM standups
                WHERE guild_id = ?
                ORDER BY started_at DESC
                LIMIT ?
                """,
                (guild_id, limit),
            ) as cursor:
                rows = await cursor.fetchall()

        return [_row_to_summary(row) for row in rows]

    async def get(self, record_id: int) -> StandupSummary | None:
        """Fetch a single standup by id."""
        async with aiosqlite.connect(self._db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM standups WHERE id = ?", (record_id,)
            ) as cursor:
                row = await cursor.fetchone()

        return _row_to_summary(row) if row else None


def _row_to_summary(row: aiosqlite.Row) -> StandupSummary:
    from datetime import datetime
    participants = [ParticipantUpdate(**p) for p in json.loads(row["participants"])]
    return StandupSummary(
        guild_id=row["guild_id"],
        channel_id=row["channel_id"],
        started_at=datetime.fromisoformat(row["started_at"]),
        ended_at=datetime.fromisoformat(row["ended_at"]),
        participants=participants,
        raw_transcript=row["transcript"],
        summary_text=row["summary"],
    )
