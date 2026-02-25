"""Standup summarization using the Anthropic API."""

import json
from anthropic import AsyncAnthropic
from ..models.standup import ParticipantUpdate

_SYSTEM_PROMPT = """\
You are a helpful project management assistant. You will receive a raw transcript of a team standup meeting.
Your job is to:
1. Identify each participant by name (use speaker names if present, otherwise infer from context).
2. For each participant extract:
   - What they did since the last standup
   - What they plan to do today
   - Any blockers or impediments
3. Produce a concise overall summary paragraph.

Respond in this exact JSON format with no other text:
{
  "participants": [
    {
      "name": "Alice",
      "did": ["completed login page"],
      "will_do": ["start on dashboard"],
      "blockers": []
    }
  ],
  "summary_text": "The team made good progress on..."
}"""


class Summarizer:
    def __init__(self, api_key: str, model: str = "claude-sonnet-4-6"):
        self._client = AsyncAnthropic(api_key=api_key)
        self._model = model

    async def summarize(self, transcript: str) -> tuple[list[ParticipantUpdate], str]:
        """Returns (participants, summary_text) parsed from the LLM response."""
        response = await self._client.messages.create(
            model=self._model,
            max_tokens=2048,
            system=_SYSTEM_PROMPT,
            messages=[
                {"role": "user", "content": f"Transcript:\n\n{transcript}"},
                # Prefill assistant turn to steer output directly into JSON
                {"role": "assistant", "content": "{"},
            ],
        )

        raw = "{" + (response.content[0].text if response.content else "")
        data = json.loads(raw)

        participants = [ParticipantUpdate(**p) for p in data.get("participants", [])]
        summary_text = data.get("summary_text", "")
        return participants, summary_text
