from datetime import datetime
from pydantic import BaseModel


class ParticipantUpdate(BaseModel):
    name: str
    did: list[str]
    will_do: list[str]
    blockers: list[str]


class StandupSummary(BaseModel):
    guild_id: int
    channel_id: int
    started_at: datetime
    ended_at: datetime
    participants: list[ParticipantUpdate]
    raw_transcript: str
    summary_text: str
