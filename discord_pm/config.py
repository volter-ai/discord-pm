from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    discord_token: str
    replicate_api_token: str
    anthropic_api_key: str

    standup_channel_id: int | None = None
    summary_channel_id: int | None = None

    recording_max_duration_seconds: int = 3600
    audio_sample_rate: int = 48000


settings = Settings()  # type: ignore[call-arg]
