"""Basic model tests."""

from datetime import datetime, UTC
from discord_pm.models.standup import ParticipantUpdate, StandupSummary


def test_participant_update():
    p = ParticipantUpdate(
        name="Alice",
        did=["Finished auth module"],
        will_do=["Start dashboard"],
        blockers=[],
    )
    assert p.name == "Alice"
    assert p.blockers == []


def test_standup_summary():
    now = datetime.now(UTC)
    s = StandupSummary(
        guild_id=123,
        channel_id=456,
        started_at=now,
        ended_at=now,
        participants=[],
        raw_transcript="...",
        summary_text="Good progress today.",
    )
    assert s.guild_id == 123
